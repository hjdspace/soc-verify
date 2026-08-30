import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * 列宽拖拽 — role="separator" 手柄 + window 级 pointermove 拖宽 + 首帧
 * useLayoutEffect 测量锁定。摘取自 beautiful-ui RecordsTable（不整体引入）：
 * D:\AI\beautiful-ui\components\primitives\RecordsTable.tsx
 * （startColumnResize 约 L565–599；首帧测量锁定约 L471–488）
 *
 * 锁定前表格按宿主布局自适应铺满；锁定后每列均为显式宽度（colgroup style），
 * 拖拽只改目标列与表格总宽。sticky 首列与 fixed 布局为宿主职责——th/td 加
 * .ap-tbl-sticky（左锚 + 投影），table 加 table-fixed。
 */

export type ColumnResize<K extends string> = {
  /** 挂到 <table> 上，首帧测量读取其 thead th 宽度 */
  tableRef: RefObject<HTMLTableElement | null>;
  /** 当前列宽（锁定前为 defaults，锁定后为实测宽度） */
  widths: Record<K, number>;
  /** 首帧测量完成；此后拖拽只改目标列 */
  locked: boolean;
  /** 拖拽中的列（手柄 is-resizing 样式） */
  resizingKey: K | null;
  /** 生成手柄 onPointerDown；minWidth 缺省 120 */
  startResize: (key: K, minWidth?: number) => (event: ReactPointerEvent<HTMLElement>) => void;
};

const DEFAULT_MIN_WIDTH = 120;

/**
 * 列宽状态机：测量锁定 → 拖拽改宽。drag 中 window 级 pointermove 持续
 * setWidths（minWidth 夹紧），pointerup/cancel 结束；期间 body 换
 * col-resize 光标并禁文本选择，结束恢复；卸载兜底清理监听。
 */
export function useColumnResize<K extends string>(options: {
  /** 列宽缺省值（key 顺序 = thead th 顺序，测量按序对应） */
  defaults: Record<K, number>;
}): ColumnResize<K> {
  const { defaults } = options;
  const tableRef = useRef<HTMLTableElement>(null);
  const [widths, setWidths] = useState<Record<K, number>>(defaults);
  const [locked, setLocked] = useState(false);
  const [resizingKey, setResizingKey] = useState<K | null>(null);
  /** 拖拽清理函数（卸载兜底，防止中途卸载泄漏 window 监听与 body 样式） */
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  // 首帧测量锁定：铺满后、绘制前捕获各列实宽，此后全部列显式化
  useLayoutEffect(() => {
    if (locked || !tableRef.current) return;
    const keys = Object.keys(defaults) as K[];
    const headers = Array.from(tableRef.current.querySelectorAll<HTMLTableCellElement>('thead th'));
    if (headers.length < keys.length) return;
    const measured = { ...defaults };
    keys.forEach((key, i) => {
      const width = headers[i].getBoundingClientRect().width;
      if (width > 0) measured[key] = width;
    });
    setWidths(measured);
    setLocked(true);
  }, [locked, defaults]);

  const startResize = (key: K, minWidth: number = DEFAULT_MIN_WIDTH) => (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widths[key];
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setResizingKey(key);

    const move = (moveEvent: PointerEvent) => {
      const width = Math.max(minWidth, startWidth + moveEvent.clientX - startX);
      setWidths((current) => ({ ...current, [key]: width }));
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      cleanupRef.current = null;
      setResizingKey(null);
    };
    cleanupRef.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  return { tableRef, widths, locked, resizingKey, startResize };
}

type ColumnResizeHandleProps = {
  /** 列名（aria-label「调整 X 列宽」） */
  label: string;
  /** 该列拖拽中（accent 竖线高亮常显） */
  resizing?: boolean;
  onStart: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  className?: string;
};

/** 列宽拖拽手柄：绝对定位于表头单元格右缘，hover/拖拽中显 accent 竖线 */
export function ColumnResizeHandle({ label, resizing = false, onStart, className }: ColumnResizeHandleProps) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`调整「${label}」列宽`}
      className={cn('ap-colresize-handle', resizing && 'is-resizing', className)}
      onPointerDown={onStart}
    />
  );
}
