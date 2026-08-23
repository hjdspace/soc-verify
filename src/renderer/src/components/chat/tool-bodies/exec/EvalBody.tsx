import { argStr } from '@renderer/components/chat/tool-helpers';

export function EvalBody({ args, resultText }: { args: unknown; resultText: string }) {
  const code = argStr(args, 'code') ?? '';
  return (
    <div className="text-[11px] leading-relaxed">
      <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-violet-foreground">
        <span className="text-muted-foreground/50">{'\u203a'} </span>{code}
      </div>
      <pre className="max-h-72 overflow-auto px-2.5 py-1.5 text-muted-foreground">
        <span className="text-status-pass-foreground">{'\u2190'} </span>{resultText || '\u00A0'}
      </pre>
    </div>
  );
}
