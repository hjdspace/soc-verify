import { useEffect, useRef, useCallback, useState } from 'react';
import { syntaxTree } from '@codemirror/language';
import { Tree } from '@lezer/common';
import { tags as highlightTags, type Tag, getStyleTags } from '@lezer/highlight';
import type { EditorView } from '@codemirror/view';

// ── Minimap 缩略图组件 ──────────────────────────────────────────
//
// 在编辑器右侧渲染带语法高亮的微缩代码缩略图（类似 VS Code）：
// - 用 canvas 以极小字号绘制每行的实际代码文本
// - 通过 CodeMirror 语法树提取每个 token 的 highlight tag，
//   映射到 --syn-* CSS 变量颜色，实现语法高亮
// - 视口位置用半透明矩形标识
// - 点击 minimap 跳转到对应行，拖拽同步滚动
// - 大文件（>2000 行）采样显示
// - 使用 requestAnimationFrame 节流渲染

/** minimap 容器宽度（px） */
const MINIMAP_WIDTH = 100;
/** minimap 每行高度（px） */
const MINIMAP_LINE_HEIGHT = 2.5;
/** minimap 字号（px） */
const MINIMAP_FONT_SIZE = 2.2;
/** minimap 字体 */
const MINIMAP_FONT_FAMILY = 'ui-monospace, "SF Mono", "Cascadia Code", "Fira Code", Consolas, monospace';
/** 每行最大字符数（超出截断） */
const MAX_CHARS_PER_LINE = 80;
/** 触发采样的大文件行数阈值 */
const SAMPLING_THRESHOLD = 2000;
/** 采样后的最大行数 */
const MAX_SAMPLED_LINES = 2000;
/** 视口指示器最小高度（px） */
const MIN_VIEWPORT_HEIGHT = 12;

// ── Tag → CSS 变量颜色映射 ──────────────────────────────────────
// 复用 syntax-highlight.ts 中的颜色映射逻辑，但直接返回 CSS 变量字符串。
// 顺序不重要——highlightTree 会按 specificity 匹配。

const TAG_COLOR_MAP: { tag: Tag | readonly Tag[]; color: string }[] = [
  // 关键字
  { tag: highlightTags.keyword, color: 'var(--syn-keyword)' },
  { tag: highlightTags.controlKeyword, color: 'var(--syn-keyword)' },
  { tag: highlightTags.definitionKeyword, color: 'var(--syn-keyword)' },
  { tag: highlightTags.moduleKeyword, color: 'var(--syn-keyword)' },
  { tag: highlightTags.modifier, color: 'var(--syn-keyword)' },

  // 字符串
  { tag: highlightTags.string, color: 'var(--syn-string)' },
  { tag: highlightTags.special(highlightTags.string), color: 'var(--syn-string)' },

  // 数字
  { tag: highlightTags.number, color: 'var(--syn-number)' },

  // 注释
  { tag: highlightTags.comment, color: 'var(--syn-comment)' },
  { tag: highlightTags.lineComment, color: 'var(--syn-comment)' },
  { tag: highlightTags.blockComment, color: 'var(--syn-comment)' },
  { tag: highlightTags.docComment, color: 'var(--syn-comment)' },

  // 函数名
  { tag: highlightTags.function(highlightTags.variableName), color: 'var(--syn-function)' },
  { tag: highlightTags.function(highlightTags.propertyName), color: 'var(--syn-function)' },

  // 类型名
  { tag: highlightTags.typeName, color: 'var(--syn-type)' },
  { tag: highlightTags.className, color: 'var(--syn-type)' },
  { tag: highlightTags.namespace, color: 'var(--syn-type)' },

  // 属性名
  { tag: highlightTags.propertyName, color: 'var(--syn-property)' },
  { tag: highlightTags.attributeName, color: 'var(--syn-property)' },

  // 变量名 — 使用前景色
  { tag: highlightTags.variableName, color: 'var(--foreground)' },

  // 运算符
  { tag: highlightTags.operator, color: 'var(--muted-foreground)' },
  { tag: highlightTags.arithmeticOperator, color: 'var(--muted-foreground)' },
  { tag: highlightTags.logicOperator, color: 'var(--muted-foreground)' },
  { tag: highlightTags.bitwiseOperator, color: 'var(--muted-foreground)' },

  // 括号
  { tag: highlightTags.bracket, color: 'var(--muted-foreground)' },
  { tag: highlightTags.paren, color: 'var(--muted-foreground)' },
];

/**
 * 将 highlight Tag 数组解析为 CSS 变量颜色字符串。
 * 遍历 TAG_COLOR_MAP，找到第一个匹配的 tag 对应的颜色。
 */
function resolveTagColor(tagList: readonly Tag[]): string | null {
  for (const { tag, color } of TAG_COLOR_MAP) {
    const tags = Array.isArray(tag) ? tag : [tag];
    for (const t of tagList) {
      // 检查 t 是否在 tags 中，或 t 是某个 tag 的子 tag
      if (tags.includes(t) || t.set.some((parent) => tags.includes(parent))) {
        return color;
      }
    }
  }
  return null;
}

// ── 行数据结构 ─────────────────────────────────────────────────

/** 一个 token 的渲染信息 */
type MiniToken = {
  /** 文本内容 */
  text: string;
  /** CSS 变量颜色字符串（如 'var(--syn-keyword)'），null 表示用默认前景色 */
  color: string | null;
};

/** 一行的渲染信息 */
type MiniLine = {
  /** 0-based 行号 */
  line: number;
  /** 该行的 token 列表 */
  tokens: MiniToken[];
};

/**
 * 从 CodeMirror EditorView 提取带语法高亮的行数据。
 * 大文件（>2000 行）采样显示。
 */
function extractMiniLines(
  doc: { lines: number; line: (n: number) => { text: string; from: number; length: number } },
  tree: Tree | null,
): MiniLine[] {
  const totalLines = doc.lines;
  const shouldSample = totalLines > SAMPLING_THRESHOLD;
  const step = shouldSample ? totalLines / MAX_SAMPLED_LINES : 1;

  // 如果有语法树，先构建 from→line 的映射
  const lineStarts: number[] = [];
  for (let i = 1; i <= totalLines; i++) {
    lineStarts.push(doc.line(i).from);
  }

  /** 将文档偏移量转换为 0-based 行号 */
  const offsetToLine = (offset: number): number => {
    // 二分查找
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // 预分配每行的 token 数组
  const linesData: MiniToken[][] = new Array(totalLines);
  for (let i = 0; i < totalLines; i++) linesData[i] = [];

  if (tree) {
    // 遍历语法树，收集每个 token 的颜色
    tree.iterate({
      enter: (node) => {
        const styleResult = getStyleTags(node);
        if (!styleResult || styleResult.tags.length === 0) return;

        const color = resolveTagColor(styleResult.tags);
        if (!color) return;

        // 获取该 node 的文本
        const from = node.from;
        const to = node.to;
        if (to <= from) return;

        // 获取文本内容 - 需要 doc.sliceString
        // 但这里我们没有 doc.sliceString，只有 doc.line(n).text
        // 所以我们需要通过 from/to 来定位行
        const startLine = offsetToLine(from);
        const endLine = offsetToLine(to);

        // 简化：只在单行内的 token 才处理
        if (startLine === endLine) {
          const lineStart = lineStarts[startLine];
          const text = doc.line(startLine + 1).text.slice(from - lineStart, to - lineStart);
          if (text.length > 0) {
            linesData[startLine].push({ text, color });
          }
        } else {
          // 跨行 token（如块注释），分别处理每行
          for (let ln = startLine; ln <= endLine && ln < totalLines; ln++) {
            const lineStart = lineStarts[ln];
            const lineEnd = ln + 1 < totalLines ? lineStarts[ln + 1] - 1 : doc.line(ln + 1).from + doc.line(ln + 1).length;
            const segFrom = Math.max(from, lineStart);
            const segTo = Math.min(to, lineEnd);
            if (segTo > segFrom) {
              const text = doc.line(ln + 1).text.slice(segFrom - lineStart, segTo - lineStart);
              if (text.length > 0) {
                linesData[ln].push({ text, color });
              }
            }
          }
        }
      },
    });
  }

  // 构建 MiniLine 数组（带采样）
  const result: MiniLine[] = [];
  const count = shouldSample ? MAX_SAMPLED_LINES : totalLines;
  for (let i = 0; i < count; i++) {
    const lineNum = shouldSample ? Math.floor(i * step) : i;
    if (lineNum >= totalLines) break;

    const tokens = linesData[lineNum];
    // 如果该行没有语法 token，用原始文本（无高亮）
    if (tokens.length === 0) {
      const text = doc.line(lineNum + 1).text;
      result.push({ line: lineNum, tokens: [{ text, color: null }] });
    } else {
      // 按 from 排序 token
      // tokens 已经是按遍历顺序的，但可能不严格排序，所以需要排序
      // 实际上 tree.iterate 是按位置顺序遍历的，所以 tokens 已经是有序的
      result.push({ line: lineNum, tokens });
    }
  }

  return result;
}

/**
 * 计算视口在 minimap 中的位置和高度。
 */
function calcViewportRect(
  scrollTop: number,
  editorHeight: number,
  contentHeight: number,
  minimapHeight: number,
): { top: number; height: number } {
  if (contentHeight <= 0) return { top: 0, height: minimapHeight };
  const ratio = minimapHeight / contentHeight;
  const top = scrollTop * ratio;
  const height = Math.max(MIN_VIEWPORT_HEIGHT, editorHeight * ratio);
  return { top: Math.min(top, minimapHeight - height), height };
}

/**
 * 将 CSS 变量颜色字符串解析为 canvas 可用的颜色值。
 * 由于 canvas 不支持 var(--xxx)，需要从 computed style 中读取实际值。
 */
class ColorResolver {
  private cache = new Map<string, string>();
  private style: CSSStyleDeclaration;

  constructor(container: HTMLElement) {
    this.style = getComputedStyle(container);
  }

  resolve(color: string | null): string {
    if (!color) return this.resolve('var(--foreground)');

    if (color.startsWith('var(')) {
      // 提取变量名
      const varName = color.match(/var\((--[\w-]+)\)/)?.[1];
      if (!varName) return color;
      if (this.cache.has(varName)) return this.cache.get(varName)!;
      const value = this.style.getPropertyValue(varName).trim();
      const resolved = value || 'rgba(128,128,128,0.6)';
      this.cache.set(varName, resolved);
      return resolved;
    }

    return color;
  }
}

interface MinimapProps {
  /** 获取 CodeMirror EditorView 实例的函数 */
  getView: () => EditorView | null;
}

export function Minimap({ getView }: MinimapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const [miniLines, setMiniLines] = useState<MiniLine[]>([]);
  const [viewportRect, setViewportRect] = useState<{ top: number; height: number }>({ top: 0, height: 0 });

  // 从 EditorView 提取数据并更新 state
  const updateMinimap = useCallback(() => {
    const view = getView();
    if (!view?.state?.doc) return;

    const doc = view.state.doc;
    // 安全地获取语法树（可能尚未解析完成）
    const tree = syntaxTree(view.state);

    // 提取行数据
    const lines = extractMiniLines(
      {
        lines: doc.lines,
        line: (n: number) => {
          const lineObj = doc.line(n);
          return { text: lineObj.text, from: lineObj.from, length: lineObj.length };
        },
      },
      tree,
    );
    setMiniLines(lines);

    // 计算视口位置
    const editorEl = view.dom;
    if (!editorEl) return;
    const editorHeight = editorEl.clientHeight;
    const contentHeight = view.contentHeight;
    const minimapHeight = containerRef.current?.clientHeight ?? editorHeight;
    const scrollDom = view.scrollDOM;
    const scrollTop = scrollDom ? scrollDom.scrollTop : 0;

    setViewportRect(calcViewportRect(scrollTop, editorHeight, contentHeight, minimapHeight));
  }, [getView]);

  // requestAnimationFrame 节流渲染
  const scheduleUpdate = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      updateMinimap();
    });
  }, [updateMinimap]);

  // 初始渲染 + 监听编辑器滚动和内容变化
  useEffect(() => {
    updateMinimap();

    const view = getView();
    if (!view?.dom) return;

    // 监听 scroll 事件
    const scrollDom = view.scrollDOM;
    const handleScroll = () => scheduleUpdate();
    if (scrollDom) {
      scrollDom.addEventListener('scroll', handleScroll, { passive: true });
    }

    // 使用 MutationObserver 监听编辑器 DOM 变化
    const observer = new MutationObserver(() => scheduleUpdate());
    observer.observe(view.dom, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // 定期检查（兜底机制，确保大文件滚动时 minimap 同步）
    const interval = setInterval(() => scheduleUpdate(), 500);

    return () => {
      if (scrollDom) {
        scrollDom.removeEventListener('scroll', handleScroll);
      }
      observer.disconnect();
      clearInterval(interval);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [getView, scheduleUpdate, updateMinimap]);

  // 在 canvas 上渲染带语法高亮的微缩代码
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const container = containerRef.current;
    if (!container) return;

    const dpr = window.devicePixelRatio || 1;
    const width = MINIMAP_WIDTH;
    const height = container.clientHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    // 清空
    ctx.clearRect(0, 0, width, height);

    // 创建颜色解析器（从 CSS 变量解析实际颜色值）
    const colorResolver = new ColorResolver(container);

    // 设置字体
    ctx.font = `${MINIMAP_FONT_SIZE}px ${MINIMAP_FONT_FAMILY}`;
    ctx.textBaseline = 'top';

    const totalLines = miniLines.length;
    if (totalLines === 0) return;

    // 计算每行在 canvas 上的 Y 位置
    // 如果行数超过容器高度能容纳的行数，进行压缩
    const maxLines = Math.floor(height / MINIMAP_LINE_HEIGHT);
    const renderStep = totalLines > maxLines ? Math.ceil(totalLines / maxLines) : 1;

    // 默认前景色（用于无高亮 token）
    const defaultColor = colorResolver.resolve('var(--foreground)');

    for (let i = 0; i < totalLines; i += renderStep) {
      const miniLine = miniLines[i];
      const y = (i / totalLines) * height;

      // 渲染该行的每个 token
      let x = 2; // 左边距 2px
      const maxWidth = width - 4; // 两侧各留 2px

      for (const token of miniLine.tokens) {
        if (x >= maxWidth) break;

        // 截断过长文本
        let text = token.text;
        if (text.length > MAX_CHARS_PER_LINE) {
          text = text.slice(0, MAX_CHARS_PER_LINE);
        }

        // 计算文本宽度，如果超出则截断
        const metrics = ctx.measureText(text);
        let renderText = text;
        if (x + metrics.width > maxWidth) {
          // 逐步截断直到适合
          while (renderText.length > 0 && x + ctx.measureText(renderText).width > maxWidth) {
            renderText = renderText.slice(0, -1);
          }
        }

        if (renderText.length > 0) {
          ctx.fillStyle = token.color ? colorResolver.resolve(token.color) : defaultColor;
          ctx.fillText(renderText, x, y);
          x += ctx.measureText(renderText).width;
        }
      }
    }
  }, [miniLines]);

  // 点击/拖拽跳转到对应行
  const jumpToPosition = useCallback((clientY: number) => {
    const view = getView();
    const container = containerRef.current;
    if (!view?.dom?.clientHeight || !container) return;

    const rect = container.getBoundingClientRect();
    const clickY = clientY - rect.top;
    const ratio = Math.max(0, Math.min(1, clickY / rect.height));

    // 映射到编辑器滚动位置
    const contentHeight = view.contentHeight;
    const editorHeight = view.dom.clientHeight;
    const maxScroll = Math.max(0, contentHeight - editorHeight);
    const targetScroll = ratio * maxScroll - editorHeight / 2;
    if (view.scrollDOM) {
      view.scrollDOM.scrollTo({ top: Math.max(0, targetScroll), behavior: 'auto' });
    }
  }, [getView]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    jumpToPosition(e.clientY);
  }, [jumpToPosition]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    jumpToPosition(e.clientY);
  }, [jumpToPosition]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    isDraggingRef.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div
      ref={containerRef}
      className="cm-minimap-container"
      data-testid="minimap-container"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <canvas ref={canvasRef} className="cm-minimap-canvas" data-testid="minimap-canvas" />
      <div
        ref={viewportRef}
        className="cm-minimap-viewport"
        data-testid="minimap-viewport"
        style={{ top: `${viewportRect.top}px`, height: `${viewportRect.height}px` }}
      />
    </div>
  );
}

// 导出类型和工具函数供测试使用
export type { MiniLine, MiniToken, MinimapProps };
export { extractMiniLines, calcViewportRect, MINIMAP_WIDTH, MINIMAP_LINE_HEIGHT };
