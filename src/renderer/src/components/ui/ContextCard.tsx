import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

/**
 * 知识 chunk 卡——标题栏（图标+标题+字符数）+ 正文摘要 + 底部来源 chip。
 *
 * chip 错峰淡入：列表展开 700ms 后，按 i*80ms 逐枚淡入（参考实现同款
 * `chipsShown` 700ms 定时 + `i*80ms` transitionDelay）。
 *
 * 视觉/交互参考 beautiful-ui: D:\AI\beautiful-ui\components\primitives\ContextCards.tsx
 * 注意参考实现的 `tone` 存的是 Tailwind 类名（`bg-red`），此处改为项目语义色
 * 映射——BADGE_TONES 取 --status-fail/-pass/-aborted/-primary/-muted-foreground，
 * 随主题自动取值，不引入字面量色。
 */

export type ContextTone = 'neutral' | 'red' | 'green' | 'orange' | 'accent';

export type ContextChunk = {
  key: string;
  /** 标题栏图标（行内彩色图标块；不传则不渲染图标位） */
  icon?: ReactNode;
  title: string;
  /** 标题栏右侧小字（如 "290 characters"、"L42"） */
  meta?: string;
  /** 正文摘要 */
  body: ReactNode;
  /** 底部来源 chip 文本 */
  source: string;
  /** chip 内色块徽标短文本（如 "PDF"、"SV"） */
  badge?: string;
  /** chip 色块语义色 */
  tone?: ContextTone;
  /** 标题栏右侧操作槽（如重新生成按钮） */
  action?: ReactNode;
  /** chip 点击行为（渲染外链图标，chip 变 button） */
  onClick?: () => void;
};

/** badge 色块：实色背景 + 白字（对齐 SourceIcon 的实色方块约定） */
const BADGE_TONES: Record<ContextTone, string> = {
  neutral: 'var(--muted-foreground)',
  red: 'var(--status-fail)',
  green: 'var(--status-pass)',
  orange: 'var(--status-aborted)',
  accent: 'var(--primary)',
};

/** 从路径取扩展名（小写，无点）；无扩展名或空路径返回 '' */
export function deriveExt(path: string | undefined): string {
  if (!path || !path.includes('.')) return '';
  return (path.split('.').pop() ?? '').toLowerCase();
}

/** 来源 chip badge：扩展名大写、截断至 3 字符；无扩展名返回 undefined */
export function deriveBadge(path: string | undefined): string | undefined {
  const ext = deriveExt(path);
  return ext ? ext.toUpperCase().slice(0, 3) : undefined;
}

export function ContextCard({
  chunk,
  /** chip 是否可见（错峰淡入由列表层控制） */
  chipVisible = true,
  /** chip 淡入延迟（ms，i*80ms 错峰） */
  chipDelay = 0,
  className,
}: {
  chunk: ContextChunk;
  chipVisible?: boolean;
  chipDelay?: number;
  className?: string;
}) {
  const { icon, title, meta, body, source, badge, tone = 'neutral', action, onClick } = chunk;
  const interactive = Boolean(onClick);

  // opacity/transform 走错峰延迟；background-color（hover）零延迟即时响应
  const chipStyle: CSSProperties = {
    opacity: chipVisible ? 1 : 0,
    transform: chipVisible ? 'scale(1)' : 'scale(0.95)',
    transitionProperty: 'opacity, transform, background-color',
    transitionDuration: '300ms, 300ms, 120ms',
    transitionTimingFunction: 'var(--ease-out-strong), var(--ease-out-strong), ease',
    transitionDelay: `${chipDelay}ms, ${chipDelay}ms, 0ms`,
  };

  const chipInner = (
    <>
      {badge && (
        <span className="ap-ctx-badge" style={{ background: BADGE_TONES[tone] }}>
          {badge}
        </span>
      )}
      <span className="ap-ctx-source font-mono">{source}</span>
      {interactive && <ArrowUpRight className="ap-ctx-link" strokeWidth={2.5} />}
    </>
  );

  return (
    <div className={cn('ap-ctx-card', className)} data-testid="context-card">
      <div className="ap-ctx-bar">
        {icon && <span className="ap-ctx-icon">{icon}</span>}
        <span className="ap-ctx-title">{title}</span>
        {action && <span className="ap-ctx-action">{action}</span>}
        {meta && <span className="ap-ctx-meta">{meta}</span>}
      </div>
      <p className="ap-ctx-body">{body}</p>
      <div className="ap-ctx-chip-wrap">
        {onClick ? (
          <button
            type="button"
            className="ap-ctx-chip ap-ctx-chip--link"
            onClick={onClick}
            style={chipStyle}
            data-testid="context-chip"
          >
            {chipInner}
          </button>
        ) : (
          <span className="ap-ctx-chip" style={chipStyle} data-testid="context-chip">
            {chipInner}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * chunk 卡列表——管理 chip 错峰淡入：展开（active=true）700ms 后 chip 逐枚
 * 淡入（i*80ms），收起时立即隐藏并重置定时。无 chunk 时不渲染。
 */
export function ContextCardList({
  chunks,
  active,
  className,
}: {
  chunks: ContextChunk[];
  active: boolean;
  className?: string;
}) {
  const [chipsShown, setChipsShown] = useState(false);

  useEffect(() => {
    if (!active) {
      setChipsShown(false);
      return;
    }
    const t = setTimeout(() => setChipsShown(true), 700);
    return () => clearTimeout(t);
  }, [active]);

  if (chunks.length === 0) return null;

  return (
    <div className={cn('ap-ctx-list', className)} data-testid="context-card-list">
      {chunks.map((chunk, i) => (
        <ContextCard
          key={chunk.key}
          chunk={chunk}
          chipVisible={chipsShown}
          chipDelay={i * 80}
        />
      ))}
    </div>
  );
}
