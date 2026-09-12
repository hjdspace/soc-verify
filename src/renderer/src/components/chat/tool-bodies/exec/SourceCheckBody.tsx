import { argStr, getToolDetails } from '@renderer/components/chat/tool-helpers';

/**
 * source_check 工具结果卡片（pi-web-access 扩展）。
 *
 * 结构化核查产物在 details.artifact（ResearchArtifact）：
 *   claim + sources[{rank,url,title,snippet,quality}] + claims[{status,confidence}]
 * 判定状态：supported / contradicted / unclear / missing-evidence。
 */

type ResearchSourceShape = { rank?: unknown; url?: unknown; title?: unknown; snippet?: unknown; quality?: unknown };
type ClaimAssessmentShape = { claim?: unknown; status?: unknown; confidence?: unknown };

type SourceCheckDetails = {
  sourceCount?: number;
  passageCount?: number;
  artifact?: {
    query?: unknown;
    sources?: ResearchSourceShape[];
    claims?: ClaimAssessmentShape[];
    provider?: unknown;
  };
};

const VERDICT_LABELS: Record<string, { label: string; className: string }> = {
  supported: { label: '已证实', className: 'text-status-pass-foreground border-status-pass-foreground/40' },
  contradicted: { label: '已证伪', className: 'text-status-fail-foreground border-status-fail-foreground/40' },
  unclear: { label: '证据不足', className: 'text-muted-foreground border-border' },
  'missing-evidence': { label: '缺证据', className: 'text-muted-foreground border-border' },
};

export function SourceCheckBody({ args, result, resultText }: { args: unknown; result?: unknown; resultText: string }) {
  const details = getToolDetails(result) as SourceCheckDetails | null;
  const artifact = details?.artifact;
  const claim = argStr(args, 'claim') || String(artifact?.query ?? '');
  const sources = Array.isArray(artifact?.sources) ? artifact!.sources! : [];
  const assessments = Array.isArray(artifact?.claims) ? artifact!.claims! : [];
  const primary = assessments[0];
  const status = typeof primary?.status === 'string' ? primary.status : '';
  const verdict = status ? VERDICT_LABELS[status] : undefined;
  const confidence = typeof primary?.confidence === 'number' ? Math.round(primary.confidence * 100) : null;
  const sourceCount = Number(details?.sourceCount ?? sources.length ?? 0);
  const passageCount = Number(details?.passageCount ?? 0);

  return (
    <div className="text-[11px] leading-relaxed">
      <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-[10px] text-muted-foreground/60">
        <div className="truncate">claim: &quot;{claim}&quot;</div>
        {(sourceCount > 0 || passageCount > 0) && (
          <div>{sourceCount} sources{' \u00b7 '}{passageCount} passages{artifact?.provider ? ` \u00b7 ${String(artifact.provider)}` : ''}</div>
        )}
      </div>
      {verdict && (
        <div className="flex items-center gap-2 border-b border-border/30 px-2.5 py-1.5">
          <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${verdict.className}`}>{verdict.label}</span>
          {confidence !== null && <span className="text-[10px] text-muted-foreground/60">confidence {confidence}%</span>}
        </div>
      )}
      {sources.length > 0 ? sources.slice(0, 10).map((s, i) => (
        <div key={i} className="border-b border-border/30 px-2.5 py-1.5 last:border-b-0">
          <div className="font-medium text-status-fail-foreground">
            {typeof s.rank === 'number' ? `${s.rank}. ` : ''}{String(s.title ?? '')}
          </div>
          {typeof s.url === 'string' && s.url && <div className="text-[10px] text-muted-foreground/50">{s.url}</div>}
          {typeof s.snippet === 'string' && s.snippet && <div className="mt-0.5 line-clamp-2 text-muted-foreground">{s.snippet}</div>}
        </div>
      )) : <pre className="px-2.5 py-1.5 text-muted-foreground">{resultText || '\u00A0'}</pre>}
    </div>
  );
}
