import type { ReactNode } from 'react';
import {
  Activity,
  Ban,
  BookOpen,
  ClipboardList,
  Cpu,
  List,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Square,
  Target,
  Wrench,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { ChatMessage } from '@renderer/stores/session-types';
import { argStr, argVal, extractResultText, getToolDetails } from '@renderer/components/chat/tool-helpers';
import { ThinkingOrb } from '@renderer/components/visual';

/**
 * subagent 管理操作卡片（management mode：action=list/status/resume/steer/...）。
 *
 * pi-subagents 的管理类 action 返回纯文本 content + `details: { mode:
 * 'management' }`，此前走 GenericBody 兜底——IN 渲染整段原始 JSON args，
 * 可读性差。本组件把派遣参数结构化为「操作徽章 + 目标 chips + 消息块」，
 * 结果文本按纯文本块渲染（能力快照时渲染 agent 行），不再露出原始 JSON。
 */

type ActionMeta = { label: string; icon: typeof Wrench };

/** 管理/控制 action 的中文标签与图标；未收录的 action 回退为原始 action 名 */
const ACTION_META: Record<string, ActionMeta> = {
  list: { label: '列出代理', icon: List },
  get: { label: '查看代理', icon: Search },
  models: { label: '可用模型', icon: Cpu },
  guide: { label: '使用指南', icon: BookOpen },
  authoring: { label: '编写指南', icon: BookOpen },
  create: { label: '创建代理', icon: Plus },
  update: { label: '更新代理', icon: Pencil },
  delete: { label: '删除代理', icon: Ban },
  eject: { label: '导出代理', icon: RotateCcw },
  disable: { label: '停用代理', icon: Ban },
  enable: { label: '启用代理', icon: Play },
  reset: { label: '重置代理', icon: RotateCcw },
  validate: { label: '校验工作流', icon: ClipboardList },
  status: { label: '运行状态', icon: Activity },
  'debug.run': { label: '调试运行', icon: Activity },
  interrupt: { label: '中断', icon: Square },
  stop: { label: '停止', icon: Square },
  resume: { label: '恢复运行', icon: Play },
  steer: { label: '引导', icon: Target },
  doctor: { label: '诊断', icon: Wrench },
  'append-step': { label: '追加步骤', icon: Plus },
  'worktree.cleanup': { label: 'worktree 清理', icon: RotateCcw },
  'grant-spawn-budget': { label: '并发预算追加', icon: Plus },
  'inspector.open': { label: '打开检查器', icon: Search },
  'project.open': { label: '打开项目面板', icon: Search },
};

const ACTION_PREFIX_META: Array<{ prefix: string; meta: ActionMeta }> = [
  { prefix: 'mission.', meta: { label: 'Mission', icon: Target } },
  { prefix: 'schedule.', meta: { label: '计划任务', icon: Activity } },
  { prefix: 'watchdog.', meta: { label: '看门狗', icon: Activity } },
  { prefix: 'lane.', meta: { label: 'Lane', icon: ClipboardList } },
  { prefix: 'refine', meta: { label: '迭代优化', icon: RotateCcw } },
];

function actionMeta(action: string): ActionMeta {
  const exact = ACTION_META[action];
  if (exact) return exact;
  const prefixed = ACTION_PREFIX_META.find((entry) => action.startsWith(entry.prefix));
  if (prefixed) return prefixed.meta;
  return { label: action, icon: Wrench };
}

type CapabilityRow = {
  name?: unknown;
  description?: unknown;
  source?: unknown;
  executable?: unknown;
  model?: { value?: unknown } | null;
  runner?: { type?: unknown } | null;
};

/** details.agentCapabilities.agents（action=list capabilities=true）→ 紧凑行数据 */
function capabilityRows(details: Record<string, unknown> | null): CapabilityRow[] {
  const snapshot = details?.agentCapabilities;
  if (typeof snapshot !== 'object' || snapshot === null) return [];
  const agents = (snapshot as Record<string, unknown>).agents;
  return Array.isArray(agents) ? agents as CapabilityRow[] : [];
}

function chipEl(label: string, value: string): ReactNode {
  return (
    <span
      key={`${label}:${value}`}
      className="inline-flex max-w-[220px] items-center gap-1 rounded border border-[var(--dsw-border-l1)] bg-[var(--dsw-layer-2)] px-1.5 py-0.5 text-[9.5px]"
      title={`${label}: ${value}`}
    >
      <span className="shrink-0 text-muted-foreground/60">{label}</span>
      <span className="truncate font-mono text-foreground/80">{value}</span>
    </span>
  );
}

export function SubagentManagementBody({ message }: { message: ChatMessage }) {
  const args = (typeof message.toolArgs === 'object' && message.toolArgs !== null
    ? message.toolArgs
    : {}) as Record<string, unknown>;
  const action = argStr(args, 'action') ?? 'management';
  const meta = actionMeta(action);
  const Icon = meta.icon;

  const details = getToolDetails(message.toolResult);
  const isError = (typeof message.toolResult === 'object' && message.toolResult !== null
    && (message.toolResult as Record<string, unknown>).isError === true);
  const resultText = extractResultText(message.toolResult).trim();
  const isExecuting = message.toolResult === undefined;

  // 目标 chips：目标代理 / 运行 id / 子索引 / 目录 / 视图等定位参数
  const chips: ReactNode[] = [];
  const agent = argStr(args, 'agent');
  if (agent) chips.push(chipEl('agent', agent));
  const runId = argStr(args, 'id', 'runId');
  if (runId) chips.push(chipEl('id', runId));
  const dir = argStr(args, 'dir');
  if (dir) chips.push(chipEl('dir', dir));
  const index = argVal(args, 'index');
  if (typeof index === 'number') chips.push(chipEl('index', `#${index}`));
  const view = argStr(args, 'view');
  if (view) chips.push(chipEl('view', view));
  const scope = argStr(args, 'agentScope', 'scope');
  if (scope) chips.push(chipEl('scope', scope));
  const schedule = argStr(args, 'at', 'every');
  if (schedule) chips.push(chipEl('trigger', schedule));

  // resume/steer/reply 携带的消息块
  const followUpMessage = argStr(args, 'message');

  const rows = capabilityRows(details);

  return (
    <div className="flex flex-col gap-1.5 px-2 py-1.5" data-testid="subagent-mgmt">
      {/* 操作行：动作徽章 + 目标 chips */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--dsw-border-l1)] bg-[var(--dsw-layer-1)] px-2 py-1.5">
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold',
            isError ? 'bg-destructive/15 text-destructive' : 'bg-chart-4/15 text-chart-4',
          )}
          data-testid="subagent-mgmt-action"
        >
          <Icon className="h-3 w-3 shrink-0" />
          {meta.label}
          {meta.label !== action && <span className="font-mono font-normal opacity-70">{action}</span>}
        </span>
        {chips}
        {isExecuting && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] text-primary">
            <ThinkingOrb state="weaving" size={20} theme="auto" />
            executing...
          </span>
        )}
      </div>

      {/* 跟进消息（resume 的续跑指令 / steer 的引导指令） */}
      {followUpMessage && (
        <div
          className="rounded-lg border border-[var(--dsw-border-l1)] bg-[var(--dsw-layer-1)] px-2 py-1.5"
          data-testid="subagent-mgmt-message"
        >
          <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/60">
            跟进消息
          </div>
          <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/85">
            {followUpMessage}
          </div>
        </div>
      )}

      {/* 能力快照（action=list capabilities=true）：紧凑 agent 行 */}
      {rows.length > 0 && (
        <div
          className="max-h-48 overflow-y-auto rounded-lg border border-[var(--dsw-border-l1)] bg-[var(--dsw-layer-1)] px-2 py-1"
          data-testid="subagent-mgmt-agents"
        >
          {rows.map((row, i) => {
            const name = typeof row.name === 'string' ? row.name : `agent-${i + 1}`;
            const model = typeof row.model?.value === 'string' ? row.model.value : undefined;
            const source = typeof row.source === 'string' ? row.source : undefined;
            const executable = row.executable !== false;
            return (
              <div key={name} className="flex items-center gap-2 border-b border-[var(--dsw-border-l1)] py-1 last:border-b-0">
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    executable ? 'bg-status-pass-foreground' : 'bg-muted-foreground/40',
                  )}
                  title={executable ? '可派遣' : '受限'}
                />
                <span className="min-w-0 shrink-0 text-[11px] font-medium text-foreground">{name}</span>
                {source && (
                  <span className="shrink-0 rounded bg-muted px-1 py-px text-[9px] uppercase tracking-[0.04em] text-muted-foreground">
                    {source}
                  </span>
                )}
                {model && (
                  <span className="min-w-0 flex-1 truncate text-right font-mono text-[9.5px] text-muted-foreground/70" title={model}>
                    {model}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 结果文本：管理操作返回纯文本，保留原文渲染（错误态标红） */}
      {!isExecuting && resultText && (
        <div
          className={cn(
            'max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border px-2 py-1.5 font-mono text-[10.5px] leading-relaxed',
            isError
              ? 'border-destructive/30 bg-destructive/5 text-destructive'
              : 'border-[var(--dsw-border-l1)] bg-[var(--dsw-layer-1)] text-muted-foreground',
          )}
          data-testid="subagent-mgmt-result"
        >
          {resultText}
        </div>
      )}
      {!isExecuting && !resultText && (
        <div className="px-1 font-mono text-[11px] text-muted-foreground/50">no output</div>
      )}
    </div>
  );
}
