import { cn } from '@renderer/lib/utils';
import type { CompileError } from '@shared/types';

export function CompileErrorView({ errors, runId }: { errors: CompileError[]; runId: string | null }) {
  if (!runId) {
    return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">无选中的运行</div>;
  }

  if (errors.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        无编译错误
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b bg-secondary/20 px-3 py-1.5">
        <span className="text-xs font-semibold text-foreground">编译错误 — {runId.slice(-6)}</span>
        <span className="ml-2 text-[11px] text-muted-foreground">{errors.length} 项</span>
      </div>
      <div className="flex-1 overflow-auto p-2">
        {errors.map((err, i) => (
          <div
            key={i}
            className={cn(
              'mb-1 rounded-md border p-2 text-xs',
              err.severity === 'error'
                ? 'border-status-fail/30 bg-status-fail/5'
                : 'border-status-pending/30 bg-status-pending/5',
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'rounded px-1 py-0.5 text-[10px] font-semibold uppercase',
                  err.severity === 'error'
                    ? 'bg-status-fail/20 text-status-fail-foreground'
                    : 'bg-status-pending/20 text-status-pending-foreground',
                )}
              >
                {err.severity}
              </span>
              <span className="font-medium text-foreground">{err.file}:{err.line}</span>
              {err.column && <span className="text-muted-foreground">:{err.column}</span>}
            </div>
            <div className="mt-1 text-muted-foreground">{err.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
