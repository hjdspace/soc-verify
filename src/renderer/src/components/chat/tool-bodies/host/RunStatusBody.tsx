import { argStr, tryParseJSON } from '@renderer/components/chat/tool-helpers';
import { StatusBadge } from '../shared/HostTableBody';
import { GenericBody } from '../shared/GenericBody';

export function RunStatusBody({ args, resultText }: { args: unknown; resultText: string }) {
  const parsed = tryParseJSON(resultText) as Record<string, unknown> | null;
  const runId = argStr(args, 'runId') ?? '';

  if (!parsed) {
    return <GenericBody args={args} resultText={resultText} />;
  }

  const status = String(parsed.status ?? parsed.state ?? 'unknown');
  const fields = Object.entries(parsed).filter(([k]) => k !== 'status' && k !== 'state');

  return (
    <div className="px-2.5 py-2 text-[11px] leading-relaxed">
      <div className="mb-1.5 flex items-center gap-2">
        {runId && <span className="font-semibold text-foreground">{runId}</span>}
        <StatusBadge status={status} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-muted-foreground/70">
        {fields.map(([k, v]) => (
          <span key={k}>{k}: {String(v)}</span>
        ))}
      </div>
    </div>
  );
}
