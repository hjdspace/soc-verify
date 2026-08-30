import { useMemo, type ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * FilterTable — 状态 chips 筛选 + 行折叠（泛化为两个可复用件 + 一个 pill 小件）。
 *
 * StatusFilterChips：带彩色圆点与计数徽标的状态 chips——计数由 items 经 statusOf
 * 实时派生（参考实现把计数写死在 FILTERS 常量里，此处修正为数据派生）；
 * FilterCollapseRow：未匹配行 grid-template-rows 1fr→0fr + opacity 300ms 平滑折叠，
 * 行保持挂载不卸载（切回即平滑展开），表格高度随行收拢；FilterStatusPill：
 * 彩色圆点之外的状态展示形态，color-mix 派生 tint（明档浅 tint / 暗档饱和底）。
 *
 * 视觉/交互参考 beautiful-ui: D:\AI\beautiful-ui\components\primitives\FilterTable.tsx
 * 样式类 .ap-ft-* 落 globals.css；参考实现 filter-status-* 用 oklch --tag-base 派生，
 * 此处改项目语义变量（--status-* 混 --card，暗档 [data-shade='dark'] 单独加深），
 * 颜色随主题自动取值。参考实现的演示数据不移植；折叠是 CSS 过渡，测试断言
 * inline style 与 data-shown/inert 属性，不做动画断言。
 */

/** chip key：'all' 或行状态值 */
export type FilterStatusKey<S extends string> = 'all' | S;

export type FilterChipDef<S extends string> = {
  key: FilterStatusKey<S>;
  label: string;
  /** 彩色圆点颜色（任意 CSS 颜色值，通常传语义变量 var(--status-*)）；缺省无圆点 */
  dot?: string;
};

type StatusFilterChipsProps<S extends string, T> = {
  /** chip 定义序列（key 唯一，渲染顺序即数组顺序） */
  filters: ReadonlyArray<FilterChipDef<S>>;
  /** 全部数据行——计数徽标的实时派生源 */
  items: readonly T[];
  /** 行 → 状态值（与 filters 的非 'all' key 同一类型域） */
  statusOf: (item: T) => S;
  /** 当前生效的 chip key */
  value: FilterStatusKey<S>;
  onChange: (key: FilterStatusKey<S>) => void;
  className?: string;
};

/**
 * 状态 chips 筛选条。计数徽标随 items 变化实时重算：'all' = items.length，
 * 其余 key = statusOf 命中数（单遍 Map 派生）。受控组件，选中态由 value 决定。
 */
export function StatusFilterChips<S extends string, T>({
  filters,
  items,
  statusOf,
  value,
  onChange,
  className,
}: StatusFilterChipsProps<S, T>) {
  const counts = useMemo(() => {
    const m = new Map<S, number>();
    for (const item of items) {
      const s = statusOf(item);
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  }, [items, statusOf]);

  return (
    <div className={cn('ap-ft-bar', className)} role="group" aria-label="状态筛选">
      {filters.map((f) => {
        const active = value === f.key;
        const count = f.key === 'all' ? items.length : (counts.get(f.key) ?? 0);
        return (
          <button
            key={f.key}
            type="button"
            aria-pressed={active}
            data-testid={`ft-chip-${f.key}`}
            className="ap-ft-chip"
            onClick={() => onChange(f.key)}
          >
            {f.dot && <span className="ap-ft-dot" style={{ background: f.dot }} />}
            {f.label}
            <span className="ap-ft-badge">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 行折叠壳：shown=false 时行内容 grid-rows 0fr + opacity 0 平滑收拢（保持挂载）。
 * 折叠行同时 inert（移出 tab 序与可访问性树）。className 落在外层 grid 行上
 * （宿主可承载 border 类），行内边框须留在 children 内部——随内容一起收拢，
 * 不在壳上留 1px 残线。
 */
export function FilterCollapseRow({
  shown,
  className,
  testId,
  children,
}: {
  shown: boolean;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn('ap-ft-row', className)}
      style={{ gridTemplateRows: shown ? '1fr' : '0fr', opacity: shown ? 1 : 0 }}
      data-shown={shown ? 'true' : 'false'}
      data-testid={testId}
      inert={!shown}
    >
      <div className="ap-ft-row-clip">{children}</div>
    </div>
  );
}

export type FilterStatusPillTone = 'pass' | 'fail' | 'running' | 'aborted';

const PILL_TONE_VARS: Record<FilterStatusPillTone, string> = {
  pass: 'var(--status-pass)',
  fail: 'var(--status-fail)',
  running: 'var(--status-running)',
  aborted: 'var(--status-aborted)',
};

/**
 * 状态 pill：color-mix 派生 tint 底 + 同 hue 深字（明档浅 tint，暗档饱和底，
 * 见 globals.css .ap-ft-pill）。tone 直接取项目语义状态变量。
 */
export function FilterStatusPill({
  tone,
  className,
  children,
}: {
  tone: FilterStatusPillTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn('ap-ft-pill', className)} data-tone={tone} style={{ '--ft-pill-base': PILL_TONE_VARS[tone] } as React.CSSProperties}>
      {children}
    </span>
  );
}
