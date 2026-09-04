import { parseOmpEditResult } from '@renderer/components/chat/tool-helpers';

/** Render the warnings section from an edit result. */
export function EditWarningBlock({ resultText }: { resultText: string }) {
  const { warnings } = parseOmpEditResult(resultText);
  if (warnings.length === 0) return null;
  return (
    <div className="border-t border-warning/30 bg-warning/5 px-2.5 py-1">
      <div className="text-[9px] font-semibold uppercase tracking-[0.06em] text-warning-foreground">Warnings</div>
      {warnings.map((w, i) => (
        <div key={i} className="text-[10px] text-warning-foreground/80">{w}</div>
      ))}
    </div>
  );
}
