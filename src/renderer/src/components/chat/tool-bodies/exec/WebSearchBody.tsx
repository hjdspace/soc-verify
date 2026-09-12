import { argStr, argVal, getToolDetails, tryParseJSON } from '@renderer/components/chat/tool-helpers';

/**
 * web_search 工具结果卡片（pi-web-access 扩展）。
 *
 * pi-web-access 的 content 是「带来源引用的综合答案」markdown 文本，结构化
 * 摘要（queries/queryCount/successfulQueries/totalResults/searchId）在
 * details。兼容旧的 JSON 数组结果格式（omp 引擎 / 通用 web_search）。
 */

type WebSearchDetails = {
  queries?: unknown;
  queryCount?: number;
  successfulQueries?: number;
  totalResults?: number;
  searchId?: string;
};

function readQueryList(args: unknown, details: Record<string, unknown> | null): string[] {
  const queriesArg = argVal(args, 'queries');
  if (Array.isArray(queriesArg) && queriesArg.length > 0) {
    return queriesArg.map((q) => String(q));
  }
  if (details && Array.isArray(details.queries) && details.queries.length > 0) {
    return (details.queries as unknown[]).map((q) => String(q));
  }
  const single = argStr(args, 'query', 'q');
  return single ? [single] : [];
}

function readSearchMeta(details: Record<string, unknown> | null): {
  queryCount: number;
  successfulQueries: number;
  totalResults: number;
  searchId: string;
} | null {
  if (!details) return null;
  const queryCount = Number(details.queryCount ?? 0);
  if (!Number.isFinite(queryCount) || queryCount <= 0) return null;
  return {
    queryCount,
    successfulQueries: Number(details.successfulQueries ?? queryCount),
    totalResults: Number(details.totalResults ?? 0),
    searchId: typeof details.searchId === 'string' ? details.searchId : '',
  };
}

type SearchResult = { title: string; url: string; snippet: string };

export function WebSearchBody({ args, result, resultText }: { args: unknown; result?: unknown; resultText: string }) {
  const details = getToolDetails(result) as WebSearchDetails | null;
  const meta = readSearchMeta(details);
  const queries = readQueryList(args, details);

  // pi-web-access：markdown 答案文本 + 结构化 meta
  if (meta) {
    return (
      <div className="text-[11px] leading-relaxed">
        <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-[10px] text-muted-foreground/60">
          {meta.successfulQueries}/{meta.queryCount} queries {' \u00b7 '}{meta.totalResults} results
          {meta.searchId ? ` \u00b7 ${meta.searchId}` : ''}
        </div>
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap px-2.5 py-1.5 font-sans text-muted-foreground">{resultText || '\u00A0'}</pre>
      </div>
    );
  }

  // 旧格式兼容：JSON 数组 → 结果表格；纯文本 → 逐行
  const parsed = tryParseJSON(resultText);
  let results: SearchResult[] = [];
  if (Array.isArray(parsed)) {
    results = (parsed as Array<Record<string, unknown>>).map((obj) => ({
      title: String(obj.title ?? obj.name ?? ''),
      url: String(obj.url ?? obj.link ?? obj.href ?? ''),
      snippet: String(obj.snippet ?? obj.description ?? obj.summary ?? ''),
    })).filter((r) => r.title || r.url);
  } else {
    results = resultText.split('\n').filter(Boolean).map((line) => ({ title: line, url: '', snippet: '' }));
  }

  return (
    <div className="text-[11px] leading-relaxed">
      {queries.length > 0 && (
        <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-[10px] text-muted-foreground/60">
          query: &quot;{queries.join(' | ')}&quot;
        </div>
      )}
      {results.length > 0 ? results.map((r, i) => (
        <div key={i} className="border-b border-border/30 px-2.5 py-1.5 last:border-b-0">
          <div className="font-medium text-status-fail-foreground">{r.title}</div>
          {r.url && <div className="text-[10px] text-muted-foreground/50">{r.url}</div>}
          {r.snippet && <div className="mt-0.5 text-muted-foreground">{r.snippet}</div>}
        </div>
      )) : <pre className="px-2.5 py-1.5 text-muted-foreground">{resultText || '\u00A0'}</pre>}
    </div>
  );
}
