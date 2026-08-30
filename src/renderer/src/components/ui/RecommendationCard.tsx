import { useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { PillButton, type PillButtonVariant } from './PillButton';

/**
 * 通用建议卡——置信度信号条 + 备选方案抽屉 + CTA success 态。
 * 卡片持有当前建议形态；「备选方案」展开抽屉列出其余选项，点击任一项
 * 提升为当前建议（`key={active.key}` 重挂载 180ms 交叉淡入）并重置已接受态；
 * 主 CTA 确认后进入 success 态。
 *
 * 视觉/交互参考 beautiful-ui: D:\AI\beautiful-ui\components\primitives\RecommendationCard.tsx
 * 样式类 .ap-rec-* 落 globals.css（颜色取全局语义变量，.ai-panel 内/外取值均正确）。
 * signal/tone/label 相比参考实现改为可选——追问建议等无置信度语义的场景不渲染信号条。
 */

export type RecommendationOption = {
  key: string;
  /** 建议正文（支持行内小件组合，如 ValuePill/EntityChip） */
  body: ReactNode;
  /** 备选抽屉行的一行摘要 */
  short: string;
  /** 置信度信号条格数 0–3；缺省不渲染信号条 */
  signal?: number;
  /** 信号条着色（CSS 颜色值，建议传语义变量） */
  tone?: string;
  /** 置信度/状态标签（页脚与备选行右侧小字） */
  label?: string;
  /** 主 CTA 文案 */
  cta: string;
  ctaVariant?: PillButtonVariant;
};

/** 置信度信号条：3 根竖条，前 signal 根取 tone 色，其余取 --input（映射 --line-strong） */
export function SignalMeter({
  signal,
  tone,
  className,
}: {
  signal: number;
  tone: string;
  className?: string;
}) {
  return (
    <span className={cn('ap-rec-meter', className)} aria-hidden>
      {[0, 1, 2].map((bar) => (
        <i key={bar} style={{ background: bar < signal ? tone : 'var(--input)' }} />
      ))}
    </span>
  );
}

type RecommendationCardProps = {
  options: RecommendationOption[];
  /** 卡片顶部问题/标题行 */
  title?: ReactNode;
  /** 主体区顶部附加内容（如违例上下文块），位于 title 之前 */
  preface?: ReactNode;
  /** 页脚左侧（信号条+标签之后）附加动作（如重新分析/拒绝） */
  footerLeft?: ReactNode;
  /** 确认回调；resolve 后 CTA 进入 accepted 态 */
  onAccept?: (option: RecommendationOption) => void | Promise<void>;
  /** accepted 态 CTA 文案（默认「已接受」） */
  acceptedLabel?: string;
  /** 外部受控已接受态（如违例已被确认）；缺省由组件内部管理 */
  accepted?: boolean;
  /** 备选抽屉开关文案（默认「备选方案」） */
  alternativesLabel?: string;
  /** 备选抽屉标题（默认「其他选项」） */
  othersLabel?: string;
  /** 禁用全部交互（加载中/已拒绝等场景） */
  disabled?: boolean;
  className?: string;
};

export function RecommendationCard({
  options,
  title,
  preface,
  footerLeft,
  onAccept,
  acceptedLabel = '已接受',
  accepted,
  alternativesLabel = '备选方案',
  othersLabel = '其他选项',
  disabled = false,
  className,
}: RecommendationCardProps) {
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState(false);
  const [selfAccepted, setSelfAccepted] = useState(false);
  const [busy, setBusy] = useState(false);

  // 夹紧选中项（options 缩短时避免越界）
  const index = Math.min(selected, Math.max(0, options.length - 1));
  const active = options[index];
  const isAccepted = accepted ?? selfAccepted;

  if (!active) return null;

  const others = options
    .map((o, i) => ({ o, i }))
    .filter(({ i }) => i !== index);
  const hasAlternatives = others.length > 0;

  const handleAccept = async () => {
    if (isAccepted || busy || disabled) return;
    setBusy(true);
    try {
      await onAccept?.(active);
      setSelfAccepted(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('ap-rec-card', className)} data-testid="recommendation-card">
      <div className="ap-rec-pad">
        {preface}
        {title && <span className="ap-rec-title">{title}</span>}
        {/* key 重挂载：切换建议时 180ms 交叉淡入（AnimatePresence 轻量等效） */}
        <p
          key={active.key}
          className="ap-rec-body"
          style={{ animation: 'fade-in 180ms var(--ease-out-strong) both' }}
        >
          {active.body}
        </p>
      </div>

      {/* 备选抽屉：grid-rows 0fr→1fr 展开（始终挂载，动画由 CSS 承担） */}
      {hasAlternatives && (
        <div
          className="ap-rec-drawer"
          style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
        >
          <div className="ap-rec-drawer-clip">
            <div className="ap-rec-others" data-testid="recommendation-alternatives">
              <p className="ap-rec-others-label">{othersLabel}</p>
              {others.map(({ o, i }) => (
                <button
                  key={o.key}
                  type="button"
                  disabled={disabled}
                  className="ap-rec-other-row"
                  data-testid="recommendation-alternative"
                  onClick={() => {
                    setSelected(i);
                    setSelfAccepted(false);
                  }}
                >
                  {o.signal !== undefined && o.tone && (
                    <SignalMeter signal={o.signal} tone={o.tone} />
                  )}
                  <span className="ap-rec-other-short">{o.short}</span>
                  {o.label && <span className="ap-rec-other-label">{o.label}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="ap-rec-footer">
        <span className="ap-rec-footer-left">
          {active.signal !== undefined && active.tone && (
            <SignalMeter signal={active.signal} tone={active.tone} />
          )}
          {active.label && <span className="ap-rec-active-label">{active.label}</span>}
          {footerLeft}
        </span>

        <span className="ap-rec-actions">
          {hasAlternatives && (
            <PillButton
              variant="secondary"
              size="sm"
              aria-expanded={open}
              disabled={disabled}
              onClick={() => setOpen((v) => !v)}
            >
              {alternativesLabel}
            </PillButton>
          )}
          <PillButton
            variant={isAccepted ? 'success' : (active.ctaVariant ?? 'accent')}
            size="sm"
            disabled={disabled || busy || isAccepted}
            onClick={() => void handleAccept()}
          >
            {busy && <Loader2 className="size-3 animate-spin" />}
            {isAccepted ? acceptedLabel : active.cta}
          </PillButton>
        </span>
      </div>
    </div>
  );
}
