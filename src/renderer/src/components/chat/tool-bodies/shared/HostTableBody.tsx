import { cn } from '@renderer/lib/utils';

export type TableColumn = { key: string; label: string; type?: 'badge' | 'text' };

export function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const cls = s === 'pass' || s === 'passed' || s === 'done' || s === 'success'
    ? 'bg-status-pass/15 text-status-pass-foreground'
    : s === 'fail' || s === 'failed' || s === 'error'
      ? 'bg-status-fail/15 text-status-fail-foreground'
      : s === 'running' || s === 'active'
        ? 'bg-primary/15 text-primary'
        : 'bg-secondary text-muted-foreground';
  return <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]', cls)}>{status || 'unknown'}</span>;
}

/** Host table body: renders JSON array as a table with configurable columns. */
export function HostTableBody({ resultText, columns, emptyMessage }: { resultText: string; columns: TableColumn[]; emptyMessage?: string }) {
  const items = (() => {
    const parsed = tryParseJSONLocal(resultText);
    return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : null;
  })();

  if (!items || items.length === 0) {
    const parsed = tryParseJSONLocal(resultText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed) {
      return <div className="px-2.5 py-2 text-[11px] text-status-fail-foreground">{String((parsed as Record<string, unknown>).error)}</div>;
    }
    return <div className="px-2.5 py-2 text-[11px] text-muted-foreground">{emptyMessage ?? '无数据'}</div>;
  }

  return (
    <div className="max-h-80 overflow-auto text-[11px] leading-relaxed">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border/40 bg-background/50">
            {columns.map((col) => (
              <th key={col.key} className="px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/60">{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i} className="border-b border-border/30 last:border-b-0">
              {columns.map((col) => {
                const val = item[col.key];
                if (col.type === 'badge') {
                  return <td key={col.key} className="px-2.5 py-1"><StatusBadge status={String(val ?? '').toLowerCase()} /></td>;
                }
                return <td key={col.key} className="px-2.5 py-1 text-muted-foreground">{val != null ? String(val) : ''}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline JSON parse to avoid circular import with tool-helpers. */
function tryParseJSONLocal(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
