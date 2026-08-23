import { argStr, tryParseJSON } from '@renderer/components/chat/tool-helpers';

export function WebSearchBody({ args, resultText }: { args: unknown; resultText: string }) {
  const query = argStr(args, 'query', 'q') ?? '';
  const parsed = tryParseJSON(resultText);

  type SearchResult = { title: string; url: string; snippet: string };
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
      {query && <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-[10px] text-muted-foreground/60">query: "{query}"</div>}
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
