import { tryParseJSON } from '@renderer/components/chat/tool-helpers';
import { GenericBody } from '../shared/GenericBody';

export function SimOptionsSchemaBody({ resultText }: { resultText: string }) {
  const parsed = tryParseJSON(resultText) as Record<string, unknown> | null;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return <GenericBody args={null} resultText={resultText} />;
  }

  const fields = Object.entries(parsed).map(([key, val]) => {
    const v = (val ?? {}) as Record<string, unknown>;
    return {
      key,
      label: typeof v.label === 'string' ? v.label : key,
      type: typeof v.type === 'string' ? v.type : 'string',
      default: v.default,
      enumValues: Array.isArray(v.enumValues) ? v.enumValues as string[] : undefined,
      description: typeof v.description === 'string' ? v.description : undefined,
    };
  });

  if (fields.length === 0) {
    return <div className="px-2.5 py-2 text-[11px] text-muted-foreground">无仿真选项</div>;
  }

  return (
    <div className="max-h-80 overflow-auto text-[11px] leading-relaxed">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border/40 bg-background/50">
            <th className="px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">Option</th>
            <th className="px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">Type</th>
            <th className="px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">Default</th>
            <th className="px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">Description</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.key} className="border-b border-border/30 last:border-b-0">
              <td className="px-2.5 py-1">
                <span className="font-mono text-foreground">{f.key}</span>
                <span className="ml-1 text-[10px] text-muted-foreground/50">{f.label !== f.key ? f.label : ''}</span>
              </td>
              <td className="px-2.5 py-1">
                <span className="rounded bg-secondary/60 px-1 py-0.5 text-[9px] font-medium text-muted-foreground">{f.type}</span>
              </td>
              <td className="px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
                {f.enumValues ? (
                  <span className="text-chart-1">{f.enumValues.join(' | ')}</span>
                ) : f.default !== undefined ? (
                  String(f.default)
                ) : (
                  <span className="text-muted-foreground/40">—</span>
                )}
              </td>
              <td className="px-2.5 py-1 text-[10px] text-muted-foreground/70">
                {f.description ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
