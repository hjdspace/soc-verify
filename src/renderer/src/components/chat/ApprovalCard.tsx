import { memo, useState } from 'react';
import { ShieldAlert, ShieldCheck, ShieldX, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { ApprovalRequest } from '@renderer/stores/session-types';

interface ApprovalCardProps {
  request: ApprovalRequest;
  onResolve: (requestId: string, approved: boolean) => void;
}

/** 工具风险层级标签 */
const TOOL_TIER_LABELS: Record<string, string> = {
  bash: '执行命令',
  eval: '执行代码',
  edit: '编辑文件',
  write: '写入文件',
  ast_edit: '编辑代码',
  read: '读取文件',
  grep: '搜索',
  glob: '搜索',
};

function getTierLabel(toolName: string): string {
  return TOOL_TIER_LABELS[toolName] ?? '工具调用';
}

/** 安全地格式化工具参数为可读字符串 */
function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/**
 * 审批卡（DSH §10.3 形态）：琥珀警示条 + 圆角卡，
 * 底部右对齐 拒绝（outline）/ 允许（primary）。
 */
export const ApprovalCard = memo(function ApprovalCard({ request, onResolve }: ApprovalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [resolved, setResolved] = useState<'approved' | 'denied' | null>(null);
  const tier = getTierLabel(request.toolName);
  const argsStr = formatArgs(request.args);

  const handleResolve = (approved: boolean) => {
    setResolved(approved ? 'approved' : 'denied');
    onResolve(request.requestId, approved);
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border text-xs transition-colors',
        resolved === 'approved'
          ? 'border-status-pass/40 bg-status-pass/5'
          : resolved === 'denied'
            ? 'border-destructive/40 bg-destructive/5'
            : 'border-[var(--dsw-warn-secondary)] bg-[var(--dsw-input-major)] shadow-[var(--dsw-shadow-lv2)]',
      )}
    >
      {/* 琥珀警示条 / 决议结果条 */}
      <div
        className={cn(
          'flex items-center gap-1.5 px-3 py-1',
          resolved === 'approved' && 'bg-status-pass/10 text-status-pass-foreground',
          resolved === 'denied' && 'bg-destructive/10 text-destructive',
          !resolved && 'bg-[var(--dsw-warn-tertiary)] text-[var(--dsw-warn-label)]',
        )}
      >
        {resolved === 'approved' ? (
          <ShieldCheck className="h-3 w-3 shrink-0" />
        ) : resolved === 'denied' ? (
          <ShieldX className="h-3 w-3 shrink-0" />
        ) : (
          <>
            <span className={cn('h-2 w-2 shrink-0 rounded-full', 'bg-[var(--dsw-warn)]')} />
            <ShieldAlert className="h-3 w-3 shrink-0" />
          </>
        )}
        <span className="font-medium">
          {resolved === 'approved' ? '已允许' : resolved === 'denied' ? '已拒绝' : '等待审批'}
        </span>
        {!resolved && (
          <span className="ml-auto font-mono text-[9px] opacity-80">{request.toolName} · {tier}</span>
        )}
      </div>

      {/* Body */}
      <div className="px-3 py-2">
        <div className="text-[12px] font-medium leading-[18px] text-foreground">
          AI 请求{['bash', 'eval'].includes(request.toolName) ? '执行' : '修改'}操作（{tier}）
        </div>

        {/* Tool args preview */}
        {argsStr && (
          <div className="mt-1.5">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            >
              {expanded ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
              <span>{expanded ? '收起详情' : '查看详情'}</span>
            </button>
            {expanded && (
              <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-[var(--dsw-border-l1)] bg-[var(--dsw-code-block)] p-1.5 font-mono text-[9px] leading-relaxed text-muted-foreground">
                <code>{argsStr}</code>
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Action buttons：右对齐 拒绝(outline) / 允许(primary) */}
      {!resolved && (
        <div className="flex items-center justify-end gap-2 px-3 pb-2.5">
          <button
            onClick={() => handleResolve(false)}
            className="rounded-lg border border-[var(--dsw-border-l2)] px-3 py-1 text-[11px] text-foreground transition-colors hover:border-destructive hover:bg-destructive/5 hover:text-destructive"
          >
            拒绝
          </button>
          <button
            onClick={() => handleResolve(true)}
            className="rounded-lg bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:opacity-90"
          >
            允许
          </button>
        </div>
      )}
    </div>
  );
});
