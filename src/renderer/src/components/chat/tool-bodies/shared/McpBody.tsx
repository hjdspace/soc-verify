import { tryParseJSON } from '@renderer/components/chat/tool-helpers';

/** MCP tool body: renders server info header + args + result. */
export function McpBody({ serverName, toolName, args, resultText }: {
  serverName?: string;
  toolName?: string;
  args: unknown;
  resultText: string;
}) {
  const hasArgs = args != null && typeof args === 'object' && Object.keys(args as object).length > 0;
  const parsed = tryParseJSON(resultText);
  const isJsonResult = parsed != null;

  return (
    <div className="text-[11px] leading-relaxed">
      <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-[10px] text-warning-foreground/80">
        <span className="text-muted-foreground/50">mcp:</span>{serverName ?? 'unknown'}{' / '}{toolName ?? 'tool'}
      </div>
      {hasArgs && (
        <div>
          <div className="border-b border-border/30 bg-background/30 px-2.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/60">args</div>
          <pre className="overflow-x-auto px-2.5 py-1 text-[10px] text-muted-foreground">{JSON.stringify(args, null, 2)}</pre>
        </div>
      )}
      {resultText && (
        <div>
          <div className="border-b border-border/30 bg-background/30 px-2.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/60">result</div>
          {isJsonResult ? (
            <pre className="max-h-72 overflow-auto px-2.5 py-1 text-[10px] text-muted-foreground">{JSON.stringify(parsed, null, 2)}</pre>
          ) : (
            <pre className="max-h-72 overflow-auto px-2.5 py-1 text-[10px] text-muted-foreground">{resultText}</pre>
          )}
        </div>
      )}
      {!hasArgs && !resultText && <div className="px-2.5 py-2 text-muted-foreground/50">no output</div>}
    </div>
  );
}
