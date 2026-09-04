import { useMemo, useState } from 'react';
import { ChevronRight, Plus, RotateCcw } from 'lucide-react';
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
// 命令预览栏已完整展示，卡片上只保留语义名，flag 以 chip 形式跟在 label 后。
const LABEL_FLAG_RE = /^(.*?)\s*\((-\S+)\)$/;

export function splitLabelFlag(label: string): { name: string; flag: string | null } {
  const m = label.match(LABEL_FLAG_RE);
  return m ? { name: m[1], flag: m[2] } : { name: label, flag: null };
}

// ─── Option Card (可折叠分组卡) ────────────────────────────────
//
// 结构（原型 option-layout-05-collapsible-cards 验证通过）：
// - 卡头可点击折叠/展开；收起时 header 右侧显示组内已配置项摘要 chips
//   （手风琴方案 4 的精华），不展开也能确认配置
// - 字段区两列（label 自适应 | 控件占满剩余），描述收进悬停 tooltip 省行高

export type OptionCardProps = {
  name: string;
  fields: SimOptionField[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  /** 初始是否展开；未指定时默认展开 */
  defaultOpen?: boolean;
};

export function OptionCard({
  name,
  fields,
  values,
  onChange,
  defaultOpen = true,
}: OptionCardProps) {
  const color = getGroupColor(name);
  const [open, setOpen] = useState(defaultOpen);

  // 折叠态摘要：组内已配置项（非空值）→ label:value chips；
  // boolean true 显示 ✓，最多 3 个 + 溢出计数，收起时一眼可确认
  const summary = useMemo(() => {
    const labelByKey = new Map(fields.map((f) => [f.key, splitLabelFlag(f.label).name]));
    const entries: Array<{ label: string; value: string }> = [];
    for (const f of fields) {
      const v = values[f.key];
      if (v === undefined || v === null || v === '' || v === false) continue;
      entries.push({
        label: labelByKey.get(f.key) ?? f.key,
        value: typeof v === 'boolean' ? '✓' : String(v),
      });
    }
    return entries;
  }, [fields, values]);
  const overflow = Math.max(0, summary.length - 3);

  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border bg-card/50">
      {/* Card header — 点击折叠/展开；收起态右侧显示摘要 chips */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150 ease-out hover:bg-accent/50"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 ease-out',
            open && 'rotate-90',
          )}
        />
        <span className={cn('h-2 w-2 shrink-0 rounded-full', color)} />
        <span className="text-[11px] font-semibold text-foreground/80">{name}</span>
        <span className="rounded bg-secondary px-1 py-px text-[10px] leading-3 text-muted-foreground">
          {fields.length} 项
        </span>
        {!open && summary.length > 0 && (
          <span className="ml-auto flex min-w-0 items-center justify-end gap-1 overflow-hidden">
            {summary.slice(0, 3).map(({ label, value }) => (
              <span
                key={label}
                className="shrink-0 rounded-full border border-border bg-secondary px-1.5 py-px text-[10px] text-muted-foreground"
              >
                {label} <span className="font-mono text-primary">{value}</span>
              </span>
            ))}
            {overflow > 0 && (
              <span className="shrink-0 text-[10px] text-muted-foreground/60">+{overflow}</span>
            )}
          </span>
        )}
      </button>
      {/* Card fields — 0fr→1fr 折叠动画（grid-rows 过渡，内容 overflow hidden）。
          收起时 inert：视效折叠外再挡住键盘焦点/屏幕阅读器进入收起区 */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden" inert={!open}>
          <div className="grid grid-cols-[minmax(90px,auto)_1fr] items-center gap-x-3 gap-y-1.5 px-2.5 pt-1 pb-2">
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
      </div>
    </div>
  );
}

// ─── Option field renderer（label 列 | 控件+描述列）──────────

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

  // tooltip 聚合 key / flag / 描述；flag 与 key 互为镜像（-rundir）时不重复。
  // 描述不常驻（省行高），悬停 label / 控件时可见全量。
  const tooltipParts: string[] = [field.key];
  if (flag && flag !== `-${field.key}`) tooltipParts.push(flag);
  if (field.description) tooltipParts.push(field.description);
  const tooltip = tooltipParts.join(' · ');

  // label：语义名 + CLI flag chip；truncate 兜底超长 label（title 里有全量信息）
  const labelCell = (
    <span className="flex min-w-0 items-baseline gap-1.5" title={tooltip}>
      <span className="truncate text-[11px] font-medium text-muted-foreground">
        {semanticName}
      </span>
      {flag && (
        <span className="shrink-0 font-mono text-[10px] leading-4 text-muted-foreground/60">
          {flag}
        </span>
      )}
    </span>
  );

  // 描述不常驻（省行高）：收进 tooltip，label 与控件悬停均可看
  const inputClass =
    'h-6 w-full min-w-0 rounded border border-border bg-background/60 px-1.5 font-mono text-[11px] outline-none transition-[color,background-color,border-color,box-shadow] duration-150 ease-out focus:border-primary focus:ring-1 focus:ring-primary/30';

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
            title={tooltip}
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
            title={tooltip}
          />
        </>
      );

    case 'boolean':
      return (
        <>
          {labelCell}
          <div className="flex min-w-0 items-center justify-end">
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(value)}
              aria-label={semanticName}
              onClick={() => onChange(!value)}
              className={cn(
                'relative h-4 w-8 shrink-0 rounded-full transition-colors duration-150 ease-out',
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
          </div>
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
        <div className="flex min-w-0 items-center gap-1">
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
      <div className="flex min-w-0 items-center gap-1">
        <select
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputClass, 'flex-1 cursor-pointer')}
          title={tooltip}
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
