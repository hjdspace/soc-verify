import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * 划选锚定 hook（issues #5 测试缝）。
 *
 * 视觉/交互参考 beautiful-ui:
 * D:\AI\beautiful-ui\components\primitives\SelectionActions.tsx
 *
 * 职责：监听 `selectionchange`，把 host 容器内的非折叠文本选区换算成
 * 浮条锚点——x 取选区包围盒水平中心，y 取 `getClientRects()` 最后一行
 * bottom + gap（浮条贴在选区最后一行下方居中）。重算入口 `place()` 用
 * rAF 批处理（同一帧内的多次触发合并，避免流式重排下的中间态闪烁）；
 * host 尺寸变化（ResizeObserver）、窗口 resize 与滚动均触发重算——
 * 滚动监听走 document 捕获（scroll 不冒泡），覆盖两类宿主：host 在
 * 滚动容器内（重算无害，锚点本就随内容平移）与 host 包住内部滚动区
 * （如 CodeMirror 的 .cm-scroller，重算是锚点跟随选区的唯一途径）。
 *
 * 可测试性：DOM Selection 读取抽成可注入的 `readSelection` 纯函数，
 * UI 测试直接传假 reader 驱动 hook，不模拟真实划选。
 */

/** 视口坐标矩形（DOMRect 的可序列化等价物） */
export type SelectionRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** 一次有效划选的快照 */
export type SelectionSnapshot = {
  /** 选中文本（trim 后非空） */
  text: string;
  /** 选区整体包围盒 */
  bounds: SelectionRect;
  /** 最后一行的行盒（浮条锚定其 bottom） */
  lastLine: SelectionRect;
};

/** 浮条锚点（相对 host 容器左上角，px） */
export type SelectionAnchor = { x: number; y: number };

function rectOf(rect: DOMRect): SelectionRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/**
 * 默认 DOM Selection 读取实现：选区折叠、为空、越出 host（或 host 为空）
 * 时返回 null。`host.contains` 接受文本节点，因此选区落在 host 内任意
 * 深度的文本上都判定为命中。
 */
export function readDomSelection(host: Element | null): SelectionSnapshot | null {
  if (typeof window === 'undefined') return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (host && !host.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const bounds = range.getBoundingClientRect();
  if (!bounds || (bounds.width === 0 && bounds.height === 0)) return null;
  const lineRects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
  const lastLine = lineRects.length > 0 ? lineRects[lineRects.length - 1] : bounds;
  return { text, bounds: rectOf(bounds), lastLine: rectOf(lastLine) };
}

export function useSelectionAnchor(options: {
  /** 锚点坐标系参照（浮条的 offsetParent），同时圈定划选生效范围 */
  hostRef: RefObject<HTMLElement | null>;
  /** false 时移除全部监听并停止重算（已得锚点保留——回合进行中浮条不消失） */
  enabled?: boolean;
  /** 浮条与选区最后一行的间距，默认 8px */
  gap?: number;
  /** 测试缝：注入假 reader 即可脱离真实 DOM Selection 单测 */
  readSelection?: (host: Element | null) => SelectionSnapshot | null;
}): {
  selection: SelectionSnapshot | null;
  anchor: SelectionAnchor | null;
  /** 立即重算（rAF 批处理） */
  place: () => void;
} {
  const { hostRef, enabled = true, gap = 8, readSelection = readDomSelection } = options;

  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);
  const frameRef = useRef<number | null>(null);
  // reader 经 ref 间接调用：注入的假 reader 可以在测试中随时换行为，
  // 而监听器（selectionchange/resize/observer）不必重建
  const readRef = useRef(readSelection);
  readRef.current = readSelection;

  const measure = useCallback(() => {
    const host = hostRef.current;
    const snapshot = readRef.current(host);
    if (!snapshot || !host) {
      setSelection(null);
      setAnchor(null);
      return;
    }
    const hostBounds = host.getBoundingClientRect();
    // 浮条水平居中于选区包围盒（Rect 模型用 left/right 求中点）
    const centerX = (snapshot.bounds.left + snapshot.bounds.right) / 2;
    const next = {
      x: Math.round(centerX - hostBounds.left),
      y: Math.round(snapshot.lastLine.bottom - hostBounds.top + gap),
    };
    setSelection(snapshot);
    setAnchor((current) =>
      current && current.x === next.x && current.y === next.y ? current : next,
    );
  }, [hostRef, gap]);

  const place = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    if (!enabled) return undefined;
    document.addEventListener('selectionchange', place);
    window.addEventListener('resize', place);
    // scroll 不冒泡，捕获监听才能收到任意子树滚动容器（CodeMirror 等）的事件
    document.addEventListener('scroll', place, true);
    const observer = new ResizeObserver(place);
    if (hostRef.current) observer.observe(hostRef.current);
    return () => {
      document.removeEventListener('selectionchange', place);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      observer.disconnect();
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [enabled, place, hostRef]);

  return { selection, anchor, place };
}
