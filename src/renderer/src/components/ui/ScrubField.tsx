import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * ScrubField — 数值微调控件：label 即 role="slider" 手柄。
 *
 * 三路改值：① 拖拽手柄（setPointerCapture 水平拖动，(Δx/2)*step 连续调值）；
 * ② 键盘 ↑↓/←→ ±step，Shift ×10；③ inputMode="numeric" 直接输入。
 * 全部经 clamp（min/max）+ 步进精度取整收敛。
 *
 * 偏离默认值 accent-tint 高亮：传 defaultValue 内部派生（value !== defaultValue），
 * 或传 active 外部受控（同时传时 active 优先）。
 *
 * 视觉/交互参考 beautiful-ui: D:\AI\beautiful-ui\components\primitives\FineTuneCard.tsx
 * 适配偏差：
 * - clamp 取整精度由 step 的小数位派生（step=0.5 保留 1 位小数）——参考实现
 *   恒用 Math.round（整数），直填小数会被吞；
 * - 输入框聚焦期间保留草稿文本（受控值之外），避免「9.」被即时归一成 9 后
 *   小数点丢失；无可解析内容（清空/杂字符）忽略不跳 0，blur/Enter 落回受控值；
 * - handle 槽允许宿主替换手柄内容（如覆盖率表格中 metric 名已在左列，
 *   手柄渲染 ↔ 图标，aria-label 仍用 label）。
 * 样式类 .ap-scrub-* 落 globals.css；颜色取语义变量，明暗主题自动取值。
 */

export type ScrubFieldProps = {
  /** 手柄 aria-label + 输入框 aria-label 前缀 + 缺省手柄文本 */
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  /** 步长：键盘 ±step、Shift ×10、拖拽 (Δx/2)*step；取整精度随其小数位 */
  step?: number;
  /** 值后缀（如 %） */
  suffix?: string;
  /** 偏离高亮基准（如行业默认值）；缺省不派生高亮 */
  defaultValue?: number;
  /** 外部受控高亮；与 defaultValue 同时传入时优先 */
  active?: boolean;
  /** 手柄内容覆盖（缺省渲染 label 文本） */
  handle?: ReactNode;
  className?: string;
  testId?: string;
};

export function ScrubField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  defaultValue,
  active,
  handle,
  className,
  testId,
}: ScrubFieldProps) {
  const drag = useRef<{ x: number; v: number } | null>(null);
  // 输入框聚焦期间的草稿文本：null 时显示受控值
  const [draftText, setDraftText] = useState<string | null>(null);

  const clamp = useMemo(() => {
    const s = String(step);
    const dot = s.indexOf('.');
    const decimals = dot === -1 ? 0 : Math.min(s.length - dot - 1, 6);
    const factor = 10 ** decimals;
    return (v: number) => Math.min(max, Math.max(min, Math.round(v * factor) / factor));
  }, [step, min, max]);

  const edited = active ?? (defaultValue !== undefined && value !== defaultValue);

  const startDrag = (e: React.PointerEvent<HTMLSpanElement>) => {
    // jsdom 无 setPointerCapture（拖拽跟随只依赖 pointermove 事件本身），
    // 真实浏览器靠捕获让指针移出手柄后继续收到 move
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, v: value };
  };

  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    const mult = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      onChange(clamp(value + step * mult));
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      onChange(clamp(value - step * mult));
    }
  };

  return (
    <label
      className={cn('ap-scrub-field', className)}
      data-edited={edited ? 'true' : 'false'}
      data-testid={testId}
    >
      <span
        role="slider"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        className="ap-scrub-handle"
        data-testid={testId ? `${testId}-handle` : undefined}
        onPointerDown={startDrag}
        onPointerMove={(e) => {
          if (!drag.current) return;
          onChange(clamp(drag.current.v + ((e.clientX - drag.current.x) / 2) * step));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={onKeyDown}
      >
        {handle ?? label}
      </span>
      <input
        inputMode="numeric"
        value={draftText ?? String(value)}
        onChange={(e) => {
          setDraftText(e.target.value);
          const raw = e.target.value.replace(/[^\d.-]/g, '');
          // 无可解析内容（清空/杂字符/仅负号）：忽略不跳 0，blur 后回显受控值
          if (raw === '') return;
          const n = Number(raw);
          if (!Number.isNaN(n)) onChange(clamp(n));
        }}
        onBlur={() => {
          setDraftText(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setDraftText(null);
        }}
        aria-label={`${label} 值`}
        className="ap-scrub-input"
        data-testid={testId ? `${testId}-input` : undefined}
      />
      {suffix && <span className="ap-scrub-suffix">{suffix}</span>}
    </label>
  );
}
