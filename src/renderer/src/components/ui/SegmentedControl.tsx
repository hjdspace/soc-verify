import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * SegmentedControl — 分段控件：灰轨 + 白 thumb，thumb 以 translateX(index*100%)
 * 300ms var(--ease-out-strong) 滑动到选中段。
 *
 * 视觉/交互参考 beautiful-ui: D:\AI\beautiful-ui\components\primitives\FineTuneCard.tsx
 * （FineTuneCard 内嵌的分段控件泛化为 props 化共享件：段数任意，宽度按
 * (100% - 4px)/N 均分，4px 为轨道左右各 2px 内边距。）
 * 互斥单选语义：aria-pressed 标注每段选中态；受控段以 key 定位（宿主无需
 * 维护索引回环），value 不在 options 中时不显示 thumb、无选中段。
 * 样式类 .ap-seg-* 落 globals.css；颜色取语义变量，明暗主题自动取值。
 */

export type SegmentedOption<K extends string = string> = {
  /** 段标识（React key + 受控值） */
  key: K;
  /** 段内容：图标或文字 */
  label: ReactNode;
  /** 无可见文字时提供（如纯图标段） */
  ariaLabel?: string;
  testId?: string;
};

export type SegmentedControlProps<K extends string = string> = {
  options: ReadonlyArray<SegmentedOption<K>>;
  /** 受控选中段 key */
  value: K;
  onChange: (key: K) => void;
  className?: string;
  testId?: string;
};

export function SegmentedControl<K extends string = string>({
  options,
  value,
  onChange,
  className,
  testId,
}: SegmentedControlProps<K>) {
  const count = options.length;
  if (count === 0) return null;
  const idx = options.findIndex((o) => o.key === value);

  return (
    <div className={cn('ap-seg', className)} role="group" data-testid={testId}>
      <span
        aria-hidden
        className="ap-seg-thumb"
        style={{
          width: `calc((100% - 4px) / ${count})`,
          left: 2,
          transform: `translateX(${Math.max(0, idx) * 100}%)`,
          // value 与 options 失配（宿主态失配）：不显示 thumb、无选中段，不猜测首段
          opacity: idx === -1 ? 0 : 1,
        }}
      />
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          aria-label={opt.ariaLabel}
          aria-pressed={opt.key === value}
          className="ap-seg-btn"
          data-testid={opt.testId}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
