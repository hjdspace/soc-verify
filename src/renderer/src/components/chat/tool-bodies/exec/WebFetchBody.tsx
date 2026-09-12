import { argStr, argVal, getToolDetails } from '@renderer/components/chat/tool-helpers';

/**
 * pi-web-access 扩展的抓取/检索类工具卡片：
 *   - WebFetchBody          → fetch_content（URL 抓取为 markdown）
 *   - GetSearchContentBody  → get_search_content（从缓存检索已存内容）
 */

function readUrlList(args: unknown): string[] {
  const urlsArg = argVal(args, 'urls');
  if (Array.isArray(urlsArg) && urlsArg.length > 0) return urlsArg.map((u) => String(u));
  const single = argStr(args, 'url');
  return single ? [single] : [];
}

export function WebFetchBody({ args, result, resultText }: { args: unknown; result?: unknown; resultText: string }) {
  const details = getToolDetails(result);
  const urls = readUrlList(args);
  const urlCount = Number(details?.urlCount ?? urls.length ?? 0);
  const successful = Number(details?.successful ?? 0);
  const totalChars = Number(details?.totalChars ?? 0);
  const responseId = typeof details?.responseId === 'string' ? details.responseId : '';
  const mode = argStr(args, 'mode') ?? 'readable';

  const metaParts: string[] = [mode];
  if (urlCount > 0) metaParts.push(`${successful}/${urlCount} fetched`);
  if (totalChars > 0) metaParts.push(`${totalChars} chars`);
  if (responseId) metaParts.push(responseId);

  return (
    <div className="text-[11px] leading-relaxed">
      <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-[10px] text-muted-foreground/60">
        {urls.length > 0 ? urls.map((u, i) => (
          <div key={i} className="truncate">{u}</div>
        )) : 'fetch'}
        <div>{metaParts.join(' \u00b7 ')}</div>
      </div>
      <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap px-2.5 py-1.5 font-sans text-muted-foreground">{resultText || '\u00A0'}</pre>
    </div>
  );
}

export function GetSearchContentBody({ args, result, resultText }: { args: unknown; result?: unknown; resultText: string }) {
  const details = getToolDetails(result);
  const responseId = typeof details?.responseId === 'string'
    ? details.responseId
    : argStr(args, 'responseId') ?? '';
  const returnedChars = Number(details?.returnedChars ?? 0);
  const truncated = details?.truncated === true;

  const metaParts: string[] = [];
  if (responseId) metaParts.push(`responseId: ${responseId}`);
  if (returnedChars > 0) metaParts.push(`${returnedChars} chars`);
  if (truncated) metaParts.push('truncated');

  return (
    <div className="text-[11px] leading-relaxed">
      <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-[10px] text-muted-foreground/60">
        {metaParts.join(' \u00b7 ') || 'search content'}
      </div>
      <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap px-2.5 py-1.5 font-sans text-muted-foreground">{resultText || '\u00A0'}</pre>
    </div>
  );
}
