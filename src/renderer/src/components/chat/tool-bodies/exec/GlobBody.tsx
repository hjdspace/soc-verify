import { argStr } from '@renderer/components/chat/tool-helpers';

export function GlobBody({ args, resultText }: { args: unknown; resultText: string }) {
  const pattern = argStr(args, 'pattern') ?? '';
  const files = resultText.split('\n').filter(Boolean);
  return (
    <div className="max-h-80 overflow-auto px-2.5 py-1.5 text-[11px] leading-relaxed">
      {pattern && <div className="mb-1 text-[10px] text-muted-foreground/60">pattern: {pattern}</div>}
      {files.map((file, i) => (
        <div key={i} className="py-0.5 text-muted-foreground">
          <span className="text-chart-1">{'\u00b0'} </span>{file}
        </div>
      ))}
      {files.length === 0 && <div className="text-muted-foreground/50">no files found</div>}
    </div>
  );
}
