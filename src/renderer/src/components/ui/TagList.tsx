import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * TagList — 标签溢出折叠：隐藏测量层量宽 + 贪心 visibleCount（4px 间隙计入），
 * 放不下的标签折叠为「+N」徽标，ResizeObserver 随列宽变化实时重算。
 *
 * 摘取自 beautiful-ui RecordsTable（不整体引入，1053 行 TSX 与 demo 数据深度耦合）：
 * D:\AI\beautiful-ui\components\primitives\RecordsTable.tsx（TagList L222–269）
 * 样式类 .ap-tags* 与 .ap-tag 落 globals.css。参考实现 TAG_COLORS 以 oklch --tag-base
 * color-mix 派生三色，此处 color 由宿主逐项传语义变量（var(--status-*) 等），
 * 未传取 --fg-faint 中性档；暗档混白加深沿 FilterStatusPill 先例（white 关键字）。
 */

/** 单个标签：label 为展示文本；color 为任意 CSS 颜色值（通常传语义变量） */
export type TagItem = {
  key: string;
  label: string;
  /** base hue 颜色（如 var(--status-fail)）；缺省中性档 */
  color?: string;
};

/** 标签间距：JS 贪心累计与 CSS gap（.ap-tags / .ap-tags-measure）同源同值 */
export const TAG_GAP = 4;

/**
 * 贪心装箱：按序累计标签宽度（首个不计 gap，其余计入），剩余标签存在时
 * 还需容纳「+N」徽标宽度才允许当前标签入列——保证溢出徽标本身不溢出。
 * 返回可完整显示的标签数。纯函数，update() 与单测共用。
 */
export function fitVisibleCount(
  tagWidths: readonly number[],
  available: number,
  moreWidth: number,
  gap: number = TAG_GAP,
): number {
  let used = 0;
  let count = 0;
  for (let index = 0; index < tagWidths.length; index += 1) {
    const nextUsed = used + (count > 0 ? gap : 0) + tagWidths[index];
    const hiddenAfter = tagWidths.length - (index + 1);
    const totalWithOverflow = nextUsed + (hiddenAfter > 0 ? gap + moreWidth : 0);
    if (totalWithOverflow > available) break;
    used = nextUsed;
    count += 1;
  }
  return count;
}

type TagListProps = {
  items: ReadonlyArray<TagItem>;
  className?: string;
  /** 原生 title / aria-label 缺省由全部 label 拼出（折叠语义下隐藏项须可达） */
  label?: string;
};

/**
 * 溢出折叠标签列表。首次绘制前 useLayoutEffect 完成量宽（无闪烁），
 * 容器尺寸变化（列宽拖拽等）经 ResizeObserver 重算 visibleCount。
 * items 引用变化即重算（宿主数据刷新后折叠态自动跟随）。
 */
export function TagList({ items, className, label }: TagListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const update = () => {
      const available = container.clientWidth;
      const tagWidths = Array.from(
        measure.querySelectorAll<HTMLElement>('[data-tag-measure]'),
        (tag) => tag.offsetWidth,
      );
      const moreWidth = measure.querySelector<HTMLElement>('[data-more-measure]')?.offsetWidth ?? 0;
      setVisibleCount(fitVisibleCount(tagWidths, available, moreWidth));
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [items]);

  const joined = label ?? items.map((item) => item.label).join('、');
  const hiddenCount = items.length - visibleCount;

  return (
    <div ref={containerRef} className={cn('ap-tags', className)} title={joined} aria-label={joined}>
      {/* 隐藏测量层：与可见层同款样式渲染全部标签 + 「+N」徽标，量宽用 */}
      <div ref={measureRef} className="ap-tags-measure" aria-hidden>
        {items.map((item) => (
          <span key={item.key} data-tag-measure>
            <span className="ap-tag" style={item.color ? ({ '--tag-base': item.color } as React.CSSProperties) : undefined}>
              {item.label}
            </span>
          </span>
        ))}
        <span data-more-measure className="ap-tags-more">
          +{items.length}
        </span>
      </div>
      {items.slice(0, visibleCount).map((item) => (
        <span
          key={item.key}
          className="ap-tag"
          style={item.color ? ({ '--tag-base': item.color } as React.CSSProperties) : undefined}
        >
          {item.label}
        </span>
      ))}
      {hiddenCount > 0 && <span className="ap-tags-more">+{hiddenCount}</span>}
    </div>
  );
}
