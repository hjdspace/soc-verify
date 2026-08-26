/** Generic fallback body: IN/OUT 卡（DSH §6.1 兜底几何）。 */
export function GenericBody({ args, resultText }: { args: unknown; resultText: string }) {
  const hasArgs = args != null && typeof args === 'object' && Object.keys(args as object).length > 0;

  if (!hasArgs && !resultText) {
    return <div className="px-2.5 py-2 font-mono text-[11px] text-muted-foreground/50">no output</div>;
  }

  return (
    <div className="overflow-hidden rounded-lg font-mono text-[11px]">
      <div className="ap-inout">
        {hasArgs && (
          <>
            <span className="ap-io-label">IN</span>
            <pre className="ap-io-body m-0">{JSON.stringify(args, null, 2)}</pre>
          </>
        )}
        {resultText && (
          <>
            <span className="ap-io-label">OUT</span>
            <pre className="ap-io-body m-0" data-err={/error/i.test(resultText.slice(0, 200)) ? 'true' : undefined}>
              {resultText}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
