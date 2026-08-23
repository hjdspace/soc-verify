import { parseJsonArray } from '@renderer/components/chat/tool-helpers';
import { cn } from '@renderer/lib/utils';

export function CompileErrorsBody({ resultText }: { resultText: string }) {
  const parsed = parseJsonArray(resultText);
  let errors: Array<{ severity: string; message: string; file?: string; line?: number }> = [];

  if (parsed) {
    errors = parsed.map((item) => ({
      severity: String(item.severity ?? item.level ?? 'error'),
      message: String(item.message ?? item.text ?? item.msg ?? ''),
      file: item.file ? String(item.file) : item.path ? String(item.path) : undefined,
      line: typeof item.line === 'number' ? item.line : typeof item.lineNumber === 'number' ? item.lineNumber : undefined,
    }));
  } else {
    errors = resultText.split('\n').filter(Boolean).map((line) => {
      const match = line.match(/^(error|warning|info)[:\s]+(.+?)(?:\s+at\s+(.+):(\d+))?$/i);
      if (match) return { severity: match[1].toLowerCase(), message: match[2], file: match[3], line: match[4] ? parseInt(match[4], 10) : undefined };
      return { severity: 'error', message: line };
    });
  }

  if (errors.length === 0) {
    return <div className="px-2.5 py-2 text-[11px] text-status-pass-foreground">No compilation errors found.</div>;
  }

  return (
    <div className="max-h-80 overflow-auto text-[11px] leading-relaxed">
      {errors.map((err, i) => {
        const isError = err.severity === 'error' || err.severity === 'fatal';
        return (
          <div key={i} className="border-b border-border/30 px-2.5 py-1.5 last:border-b-0">
            <div className="flex items-center gap-1.5">
              <span className={cn(
                'rounded px-1 py-0.5 text-[9px] font-bold uppercase',
                isError ? 'bg-status-fail/15 text-status-fail-foreground' : 'bg-warning/15 text-warning-foreground',
              )}>{err.severity}</span>
              <span className="text-foreground">{err.message}</span>
            </div>
            {err.file && (
              <div className="mt-0.5 font-mono text-[10px] text-status-running-foreground">
                {err.file}{err.line ? `:${err.line}` : ''}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
