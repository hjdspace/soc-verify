import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Liquid } from '@renderer/components/visual';

/**
 * 里程碑单步：done（完成打勾）/ current（脉冲）/ pending（序号）。
 * 样式对照原型 `.ms-step` / `.ms-dot` / `.ms-line`。
 */
export type MilestoneStep = {
  label: string;
  /** 副值文案（如「目标 ≥ 90%」），仅描述性文字，不渲染伪造的统计值 */
  hint?: string;
  status: 'done' | 'current' | 'pending';
  /** 点击节点触发（如「环境生成」打开环境生成向导）；图标本身可点击 */
  onClick?: () => void;
  /** 节点附带的子动作（通过节点点击展开） */
  actions?: { label: string; icon: LucideIcon; onClick: () => void; testId?: string }[];
};

export function MilestoneBar({ steps }: { steps: MilestoneStep[] }) {
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  return (
    <div
      className="mb-3 flex items-center overflow-x-auto rounded-xl border border-border bg-card px-4 py-3"
      data-testid="milestone-bar"
    >
      {steps.map((step, index) => {
        const hasActions = Boolean(step.actions?.length);
        const expanded = expandedStep === step.label;
        const clickable = Boolean(step.onClick) || hasActions;
        const handleStepClick = () => {
          if (hasActions) setExpandedStep((current) => (current === step.label ? null : step.label));
          step.onClick?.();
        };
        return (
        <div key={step.label} className="flex items-center">
          <div
            className={cn('flex shrink-0 items-center gap-2', clickable && 'group')}
            data-testid={`milestone-step-${index}`}
          >
            <button
              type="button"
              disabled={!clickable}
              onClick={handleStepClick}
              aria-label={clickable ? (hasActions ? step.label : `打开${step.label}`) : undefined}
              aria-expanded={hasActions ? expanded : undefined}
              className={cn(
                'grid size-[22px] shrink-0 place-items-center rounded-full border-2 text-[10px] font-semibold transition-colors',
                step.status === 'done' && 'border-primary bg-primary/15 text-primary',
                step.status === 'current' && 'animate-pulse border-primary text-primary',
                step.status === 'pending' && 'border-border text-muted-foreground/60',
                clickable && 'cursor-pointer hover:border-primary hover:bg-primary/20 hover:ring-2 hover:ring-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                !clickable && 'cursor-default',
              )}
              data-testid={`milestone-icon-${index}`}
            >
              {step.status === 'done' ? <Check className="size-2.5" strokeWidth={3} /> : index + 1}
            </button>
            <div className="text-[11.5px] leading-tight">
              <div className="flex items-center gap-1">
                <span
                  className={cn(
                    step.status === 'pending' ? 'text-muted-foreground' : 'text-foreground',
                    step.status === 'current' && 'font-semibold',
                    clickable && 'group-hover:text-primary transition-colors',
                  )}
                >
                  {step.label}
                </span>
                {hasActions && (
                  <ChevronDown
                    aria-hidden="true"
                    className={cn('size-3 text-muted-foreground transition-transform', expanded && 'rotate-180')}
                  />
                )}
              </div>
              {step.hint && (
                <span
                  className={cn(
                    'block text-[10px] text-muted-foreground/70',
                    step.status === 'current' && 'text-primary',
                  )}
                >
                  {step.hint}
                </span>
              )}
            </div>
          </div>
          {hasActions && expanded && (
            <Liquid
              blur={5}
              contrast={16}
              fill="var(--card)"
              shadow="0 2px 5px rgba(0,0,0,.08)"
              className="ml-1 flex shrink-0 flex-col items-center gap-1"
              data-testid={`milestone-actions-${index}`}
            >
              {step.actions!.map((action) => {
                const Icon = action.icon;
                return (
                  <Liquid.Item key={action.label}>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        action.onClick();
                        setExpandedStep(null);
                      }}
                      aria-label={action.label}
                      title={action.label}
                      className="grid size-7 place-items-center rounded-full border border-border/70 bg-card text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      data-testid={action.testId}
                    >
                      <Icon className="size-3.5" strokeWidth={1.8} />
                    </button>
                  </Liquid.Item>
                );
              })}
            </Liquid>
          )}
          {index < steps.length - 1 && (
            <span
              className={cn(
                'mx-2 h-px w-9 shrink-0',
                step.status === 'done' ? 'bg-primary' : 'bg-border',
              )}
            />
          )}
        </div>
        );
      })}
    </div>
  );
}
