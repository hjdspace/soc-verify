import { FileSearch, Wand2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { SimOptionField } from '@shared/plugin-types';

// ─── 分组顺序定义 ──────────────────────────────────────────────
export const GROUP_ORDER = ['基础参数', '波形配置', '仿真参数', '回归测试'];
export const DEFAULT_GROUP = '其他';

// ─── 分组颜色映射 ──────────────────────────────────────────────
export const GROUP_COLORS: Record<string, string> = {
  '基础参数': 'bg-blue-500',
  '波形配置': 'bg-violet-500',
  '仿真参数': 'bg-green-500',
  '回归测试': 'bg-red-500',
  [DEFAULT_GROUP]: 'bg-zinc-500',
};

export function getGroupColor(name: string): string {
  return GROUP_COLORS[name] ?? GROUP_COLORS[DEFAULT_GROUP];
}

// ─── Option Card (Minimalist Card group) ──────────────────────

export type OptionCardProps = {
  name: string;
  fields: SimOptionField[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  onBrowseRegrFile: () => void;
  onParseCommand: () => void;
  canBrowse: boolean;
};

export function OptionCard({
  name,
  fields,
  values,
  onChange,
  onBrowseRegrFile,
  onParseCommand,
  canBrowse,
}: OptionCardProps) {
  const color = getGroupColor(name);
  const isRegrGroup = name === '回归测试';
  return (
    <div className="rounded border border-border bg-card/50 transition-colors hover:border-primary/30">
      {/* Card header */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <span className={cn('h-1.5 w-1.5 rounded-full', color)} />
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {name}
        </span>
        <span className="text-[9px] text-muted-foreground/50">({fields.length})</span>
        {/* 解析回归指令按钮 — 仅回归测试卡片显示 */}
        {isRegrGroup && (
          <button
            onClick={onParseCommand}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="粘贴回归指令，自动提取 runsim 命令参数"
          >
            <Wand2 className="h-2.5 w-2.5" />
            解析指令
          </button>
        )}
      </div>
      {/* Card fields */}
      <div className="flex flex-col gap-1 px-2.5 pb-2">
        {fields.map((field) => (
          <OptionField
            key={field.key}
            field={field}
            value={values[field.key]}
            onChange={(v) => onChange(field.key, v)}
            onBrowseRegrFile={onBrowseRegrFile}
            canBrowse={canBrowse}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Option field renderer (inline minimalist style) ──────────

export type OptionFieldProps = {
  field: SimOptionField;
  value: unknown;
  onChange: (value: unknown) => void;
  onBrowseRegrFile: () => void;
  canBrowse: boolean;
};

export function OptionField({
  field,
  value,
  onChange,
  onBrowseRegrFile,
  canBrowse,
}: OptionFieldProps) {
  const labelText = (
    <span
      className="shrink-0 whitespace-nowrap text-[10px] font-medium text-muted-foreground"
      title={field.key}
    >
      {field.label}
    </span>
  );

  const hint =
    field.description ? (
      <span
        className="cursor-help text-[9px] text-muted-foreground/40"
        title={field.description}
      >
        (?)
      </span>
    ) : null;

  // 回归列表文件字段：输入框 + 浏览按钮
  const isRegrFile = field.key === 'regr_file';

  switch (field.type) {
    case 'string':
      return (
        <div className="flex items-center gap-1.5">
          {labelText}
          {hint}
          <input
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.default ? String(field.default) : ''}
            className="min-w-0 flex-1 rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[11px] outline-none transition-colors focus:border-primary"
          />
          {isRegrFile && (
            <button
              onClick={onBrowseRegrFile}
              disabled={!canBrowse}
              className="flex shrink-0 items-center gap-1 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
              title="浏览选择回归列表文件"
            >
              <FileSearch className="h-2.5 w-2.5" />
              浏览
            </button>
          )}
        </div>
      );

    case 'number':
      return (
        <div className="flex items-center gap-1.5">
          {labelText}
          {hint}
          <input
            type="number"
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            placeholder={field.default !== undefined ? String(field.default) : ''}
            className="min-w-0 flex-1 rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[11px] outline-none transition-colors focus:border-primary"
          />
        </div>
      );

    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-1.5 py-0.5">
          <div className="flex items-center gap-1.5">
            {labelText}
            {hint}
          </div>
          <button
            onClick={() => onChange(!value)}
            className={cn(
              'relative h-3.5 w-7 shrink-0 rounded-full transition-colors',
              value ? 'bg-primary' : 'bg-muted-foreground/30',
            )}
            title={field.description}
          >
            <div
              className={cn(
                'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background shadow-sm transition-transform',
                value ? 'translate-x-3.5' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>
      );

    case 'enum':
      return (
        <div className="flex items-center gap-1.5">
          {labelText}
          {hint}
          <select
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[11px] outline-none transition-colors focus:border-primary"
          >
            <option value="">--</option>
            {field.enumValues?.map((v) => (
              <option key={v} value={v}>
                {v || '--'}
              </option>
            ))}
          </select>
        </div>
      );

    default:
      return null;
  }
}
