/** Generic fallback body: shows args + result as JSON/text. */
export function GenericBody({ args, resultText }: { args: unknown; resultText: string }) {
  const hasArgs = args != null && typeof args === 'object' && Object.keys(args as object).length > 0;
  return (
    <div className="text-[11px] leading-relaxed">
      {hasArgs && (
        <div>
          <div className="border-b border-border/30 bg-background/50 px-2.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/60">args</div>
          <pre className="overflow-x-auto px-2.5 py-1 text-[10px] text-muted-foreground">{JSON.stringify(args, null, 2)}</pre>
        </div>
      )}
      {resultText && (
        <div>
          <div className="border-b border-border/30 bg-background/50 px-2.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/60">result</div>
          <pre className="max-h-48 overflow-auto px-2.5 py-1 text-[10px] text-muted-foreground">{resultText}</pre>
        </div>
      )}
      {!hasArgs && !resultText && <div className="px-2.5 py-2 text-muted-foreground/50">no output</div>}
    </div>
  );
}
