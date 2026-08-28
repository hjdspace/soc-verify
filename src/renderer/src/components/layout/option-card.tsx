import { useState } from 'react';
import { Plus, RotateCcw } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { SimOptionField } from '@shared/plugin-types';

// ─── 分组顺序定义 ──────────────────────────────────────────────
export const GROUP_ORDER = ['基础参数', '波形配置', '仿真参数'];
export const DEFAULT_GROUP = '其他';

// ─── 分组颜色映射 ──────────────────────────────────────────────
export const GROUP_COLORS: Record<string, string> = {
  '基础参数': 'bg-blue-500',
  '波形配置': 'bg-violet-500',
  '仿真参数': 'bg-green-500',
  [DEFAULT_GROUP]: 'bg-zinc-500',
};

export function getGroupColor(name: string): string {
  return GROUP_COLORS[name] ?? GROUP_COLORS[DEFAULT_GROUP];
}

// ─── label 尾部 CLI flag 剥离 ─────────────────────────────────
// schema 的 label 形如 "工作目录 (-rundir)"；flag 属于命令行信息，
// 命令预览栏已完整展示，卡片上只保留语义名，flag 进 label tooltip。
const LABEL_FLAG_RE = /^(.*?)\s*\((-\S+)\)$/;

export function splitLabelFlag(label: string): { name: string; flag: string | null } {
  const m = label.match(LABEL_FLAG_RE);
  return m ? { name: m[1], flag: m[2] } : { name: label, flag: null };
}

// ─── Option Card (Minimalist Card group) ──────────────────────

export type OptionCardProps = {
  name: string;
  fields: SimOptionField[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
};

export function OptionCard({
  name,
  fields,
  values,
  onChange,
}: OptionCardProps) {
  const color = getGroupColor(name);
  return (
    <div className="rounded-lg border border-border bg-card/50">
      {/* Card header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', color)} />
        <span className="text-[11px] font-semibold text-foreground/80">{name}</span>
        <span className="rounded bg-secondary px-1 py-px text-[10px] leading-3 text-muted-foreground">
          {fields.length} 项
        </span>
      </div>
      {/* Card fields — 共享 grid，auto 列取卡内最宽 label，输入框左边缘对齐 */}
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 px-2.5 py-2">
        {fields.map((field) => (
          <OptionField
            key={field.key}
            field={field}
            value={values[field.key]}
            onChange={(v) => onChange(field.key, v)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Option field renderer (shared-grid rows: label | control) ─

export type OptionFieldProps = {
  field: SimOptionField;
  value: unknown;
  onChange: (value: unknown) => void;
};

export function OptionField({
  field,
  value,
  onChange,
}: OptionFieldProps) {
  const { name: semanticName, flag } = splitLabelFlag(field.label);

  // tooltip 聚合 key / flag / 描述；flag 与 key 互为镜像（-rundir）时不重复
  const tooltipParts: string[] = [field.key];
  if (flag && flag !== `-${field.key}`) tooltipParts.push(flag);
  if (field.description) tooltipParts.push(field.description);
  const tooltip = tooltipParts.join(' · ');

  const labelCell = (
    <span
      className="max-w-[120px] cursor-default truncate text-[11px] font-medium text-muted-foreground"
      title={tooltip}
    >
      {semanticName}
    </span>
  );

  const inputClass =
    'h-6 min-w-0 rounded border border-border bg-background/60 px-1.5 font-mono text-[11px] outline-none transition-[color,background-color,border-color,box-shadow] duration-150 ease-out focus:border-primary focus:ring-1 focus:ring-primary/30';

  switch (field.type) {
    case 'string':
      return (
        <>
          {labelCell}
          <input
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.default ? String(field.default) : ''}
            className={inputClass}
          />
        </>
      );

    case 'number':
      return (
        <>
          {labelCell}
          <input
            type="number"
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            placeholder={field.default !== undefined ? String(field.default) : ''}
            className={cn(
              inputClass,
              // 隐藏原生 spinner：h-6 下拥挤且不可点
              'appearance-none [-moz-appearance:textfield]',
              '[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
            )}
          />
        </>
      );

    case 'boolean':
      return (
        <>
          {labelCell}
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(value)}
            aria-label={semanticName}
            onClick={() => onChange(!value)}
            className={cn(
              'relative h-4 w-8 shrink-0 justify-self-end rounded-full transition-colors duration-150 ease-out',
              value ? 'bg-primary' : 'bg-muted-foreground/30',
            )}
            title={tooltip}
          >
            <span
              className={cn(
                'absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-background shadow-sm transition-transform duration-150 ease-out',
                value ? 'translate-x-4' : 'translate-x-0',
              )}
            />
          </button>
        </>
      );

    case 'enum':
      return (
        <EnumField
          field={field}
          value={value}
          onChange={onChange}
          labelCell={labelCell}
          inputClass={inputClass}
          tooltip={tooltip}
        />
      );

    default:
      return null;
  }
}

// ─── Enum field — 支持自定义值输入 ───────────────────────────
//
// enum 字段默认渲染为 <select>，旁边附 + 按钮切换到自由输入模式。
// 当当前值不在 enumValues 列表中（如用户之前输入了自定义 corner），
// 自动进入输入模式，避免值丢失。
// 切回 select 模式时，若当前自定义值不在列表中，清空为默认值。

type EnumFieldProps = {
  field: SimOptionField;
  value: unknown;
  onChange: (value: unknown) => void;
  labelCell: React.ReactNode;
  inputClass: string;
  tooltip: string;
};

function EnumField({
  field,
  value,
  onChange,
  labelCell,
  inputClass,
  tooltip,
}: EnumFieldProps) {
  const strValue = typeof value === 'string' ? value : '';
  const isPreset = !strValue || (field.enumValues?.includes(strValue) ?? false);
  // 当值不在预设列表中时，自动进入自定义模式
  const [customMode, setCustomMode] = useState(!isPreset);

  if (customMode) {
    return (
      <>
        {labelCell}
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={strValue}
            onChange={(e) => onChange(e.target.value)}
            placeholder="输入自定义值"
            className={inputClass}
            title={tooltip}
          />
          <button
            type="button"
            onClick={() => {
              setCustomMode(false);
              // 若当前值不在预设列表中，切回 select 时清空
              if (strValue && !(field.enumValues?.includes(strValue) ?? false)) {
                onChange('');
              }
            }}
            className="flex h-6 shrink-0 items-center justify-center rounded border border-border bg-background/60 text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.97]"
            title="切回预设列表"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {labelCell}
      <div className="flex items-center gap-1">
        <select
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputClass, 'flex-1 cursor-pointer')}
        >
          <option value="">--</option>
          {field.enumValues?.map((v) => (
            <option key={v} value={v}>
              {v || '--'}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setCustomMode(true)}
          className="flex h-6 w-5 shrink-0 items-center justify-center rounded border border-border bg-background/60 text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.97]"
          title="输入自定义值"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </>
  );
}
