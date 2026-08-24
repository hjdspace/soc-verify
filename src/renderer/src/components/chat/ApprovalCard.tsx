import { memo, useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, Check, X, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { ApprovalRequest } from '@renderer/stores/session-types';

interface ApprovalCardProps {
  request: ApprovalRequest;
  onResolve: (requestId: string, approved: boolean) => void;
}

/** 工具风险层级标签 */
const TOOL_TIER_LABELS: Record<string, { label: string; color: string }> = {
  bash: { label: '执行命令', color: 'text-destructive' },
  eval: { label: '执行代码', color: 'text-destructive' },
  edit: { label: '编辑文件', color: 'text-status-warn-foreground' },
  write: { label: '写入文件', color: 'text-status-warn-foreground' },
  ast_edit: { label: '编辑代码', color: 'text-status-warn-foreground' },
  read: { label: '读取文件', color: 'text-status-pass-foreground' },
  grep: { label: '搜索', color: 'text-status-pass-foreground' },
  glob: { label: '搜索', color: 'text-status-pass-foreground' },
};

function getTierLabel(toolName: string): { label: string; color: string } {
  return TOOL_TIER_LABELS[toolName] ?? { label: '工具调用', color: 'text-muted-foreground' };
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

export const ApprovalCard = memo(function ApprovalCard({ request, onResolve }: ApprovalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [resolved, setResolved] = useState<'approved' | 'denied' | null>(null);
  const tier = getTierLabel(request.toolName);
  const argsStr = formatArgs(request.args);
  const isDangerous = ['bash', 'eval'].includes(request.toolName);

  const handleResolve = (approved: boolean) => {
    setResolved(approved ? 'approved' : 'denied');
    onResolve(request.requestId, approved);
  };

  return (
    <div
      className={cn(
        'rounded-lg border p-2.5 text-xs transition-colors',
        resolved === 'approved' && 'border-status-pass/40 bg-status-pass/5',
        resolved === 'denied' && 'border-destructive/40 bg-destructive/5',
        !resolved && isDangerous && 'border-destructive/30 bg-destructive/5',
        !resolved && !isDangerous && 'border-status-warn/30 bg-status-warn/5',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5">
        {isDangerous ? (
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
        ) : (
          <ShieldX className="h-3.5 w-3.5 shrink-0 text-status-warn-foreground" />
        )}
        <span className="font-semibold text-foreground">
          AI 请求{isDangerous ? '执行' : '修改'}操作
        </span>
        <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-medium', tier.color, 'bg-current/10')}>
          {tier.label}
        </span>
        <span className="ml-auto text-[9px] text-muted-foreground">
          {request.toolName}
        </span>
      </div>

      {/* Tool args preview */}
      {argsStr && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
            <span>{expanded ? '收起详情' : '查看详情'}</span>
          </button>
          {expanded && (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/50 p-1.5 text-[9px] text-foreground/80">
              <code>{argsStr}</code>
            </pre>
          )}
        </div>
      )}

      {/* Action buttons */}
      {!resolved && (
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            onClick={() => handleResolve(true)}
            className="flex items-center gap-1 rounded bg-status-pass/15 px-2 py-1 text-[10px] font-medium text-status-pass-foreground transition-colors hover:bg-status-pass/25"
          >
            <Check className="h-3 w-3" />
            <span>允许</span>
          </button>
          <button
            onClick={() => handleResolve(false)}
            className="flex items-center gap-1 rounded bg-destructive/15 px-2 py-1 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/25"
          >
            <X className="h-3 w-3" />
            <span>拒绝</span>
          </button>
        </div>
      )}

      {/* Resolved state */}
      {resolved && (
        <div className="mt-2.5 flex items-center gap-1 text-[10px]">
          {resolved === 'approved' ? (
            <>
              <ShieldCheck className="h-3 w-3 text-status-pass-foreground" />
              <span className="text-status-pass-foreground">已允许</span>
            </>
          ) : (
            <>
              <ShieldX className="h-3 w-3 text-destructive" />
              <span className="text-destructive">已拒绝</span>
            </>
          )}
        </div>
      )}
    </div>
  );
});
