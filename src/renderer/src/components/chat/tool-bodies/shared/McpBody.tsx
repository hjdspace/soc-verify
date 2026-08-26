import { tryParseJSON } from '@renderer/components/chat/tool-helpers';

/** MCP tool body: server 信息条 + IN/OUT 卡（DSH §6.1 兜底几何）。 */
export function McpBody({ serverName, toolName, args, resultText }: {
  serverName?: string;
  toolName?: string;
  args: unknown;
  resultText: string;
}) {
  const hasArgs = args != null && typeof args === 'object' && Object.keys(args as object).length > 0;
  const parsed = tryParseJSON(resultText);
  const outText = parsed != null ? JSON.stringify(parsed, null, 2) : resultText;

  if (!hasArgs && !resultText) {
    return <div className="px-2.5 py-2 font-mono text-[11px] text-muted-foreground/50">no output</div>;
  }

  return (
    <div className="overflow-hidden rounded-lg font-mono text-[11px]">
      <div className="ap-banner-min truncate">
        mcp: {serverName ?? 'unknown'} / {toolName ?? 'tool'}
      </div>
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
            <pre className="ap-io-body m-0" data-err={/^error|error:/i.test(outText.slice(0, 200)) ? 'true' : undefined}>
              {outText}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
