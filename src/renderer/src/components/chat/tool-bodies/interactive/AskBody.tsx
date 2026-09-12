import { cn } from '@renderer/lib/utils';
import { argStr, argVal } from '@renderer/components/chat/tool-helpers';

/** Normalise an untrusted options array into { label, description? } objects. */
function normalizeAskOptions(raw: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    if (typeof o === 'string') return { label: o };
    if (o && typeof o === 'object') {
      const obj = o as Record<string, unknown>;
      const label = typeof obj.label === 'string' ? obj.label : String(obj.label ?? '');
      const description = typeof obj.description === 'string' && obj.description.trim() ? obj.description.trim() : undefined;
      return description ? { label, description } : { label };
    }
    return { label: String(o) };
  });
}

/** Normalise untrusted `questions` array args into a renderable structure. */
function normalizeAskQuestions(raw: unknown): Array<{
  id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multi?: boolean;
  recommended?: number;
}> {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') return { id: '?', question: '', options: [] };
    const q = entry as Record<string, unknown>;
    return {
      id: typeof q.id === 'string' ? q.id : '?',
      question: typeof q.question === 'string' ? q.question : '',
      options: normalizeAskOptions(q.options),
      multi: q.multi === true,
      recommended: typeof q.recommended === 'number' ? q.recommended : undefined,
    };
  });
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip the two-space indentation the backend adds to multi-line custom input. */
function dedentLines(text: string): string {
  return text
    .split('\n')
    .map((l) => (l.startsWith('  ') ? l.slice(2) : l))
    .join('\n')
    .trim();
}

type ParsedAskAnswer = { labels: string[]; customText?: string };

/**
 * Extract one question's answer from the tool result text.
 *
 * Result formats produced by the host (session-manager.handleAskToolCall):
 *  - single question:  `User selected: A` / `User selected: A, B` /
 *                      `User provided custom input: X` (multi-line indented)
 *  - multi question:   `User answers:\n<id>: A\n<id>: [a, b]\n<id>: "X"`
 *
 * Both formats must be handled for every question count: the multi-question
 * branch renders even a single question, and the per-question `<id>:` format
 * may also appear for a lone question.
 */
function extractAskAnswer(
  resultText: string,
  qid: string,
  allIds: string[],
  isOnlyQuestion: boolean,
): ParsedAskAnswer | null {
  // ── Per-question `<id>:` format ─────────────────────────
  // Capture may span lines (multi-line custom input embeds raw newlines);
  // stop at the next `<otherId>:` line or end of text.
  const others = allIds.filter((id) => id !== qid).map(escapeRegExp).join('|');
  const idPattern = others
    ? `${escapeRegExp(qid)}:\\s*([\\s\\S]*?)\\s*(?=\\n(?:${others}):|$)`
    : `${escapeRegExp(qid)}:\\s*([\\s\\S]*)`;
  const idMatch = resultText.match(new RegExp(idPattern));
  if (idMatch) {
    const raw = idMatch[1];
    if (raw.startsWith('[') && raw.endsWith(']')) {
      return { labels: raw.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean) };
    }
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      return { labels: [], customText: raw.slice(1, -1) };
    }
    const label = raw.trim();
    return label ? { labels: [label] } : null;
  }

  // ── Single-question natural-language formats ────────────
  if (isOnlyQuestion) {
    const selectedMatch = resultText.match(/^User selected:\s*([\s\S]+)$/);
    if (selectedMatch) {
      return { labels: selectedMatch[1].split(',').map((s) => s.trim()).filter(Boolean) };
    }
    const customMatch = resultText.match(/^User provided custom input:\s*([\s\S]+)$/);
    if (customMatch) {
      return { labels: [], customText: dedentLines(customMatch[1]) };
    }
  }
  return null;
}

/** Parse the tool result text for the legacy single-question args format. */
function parseLegacyAskResult(resultText: string): ParsedAskAnswer | null {
  const selectedMatch = resultText.match(/^User selected:\s*([\s\S]+)$/);
  if (selectedMatch) {
    return { labels: selectedMatch[1].split(',').map((s) => s.trim()).filter(Boolean) };
  }
  const customMatch = resultText.match(/^User provided custom input:\s*([\s\S]+)$/);
  if (customMatch) {
    return { labels: [], customText: dedentLines(customMatch[1]) };
  }
  return null;
}

export function AskBody({ args, resultText }: { args: unknown; resultText: string }) {
  const questionsArg = argVal(args, 'questions');
  const questions = normalizeAskQuestions(questionsArg);

  // Multi-question format: render each question with its options
  if (questions.length > 0) {
    const hasResult = resultText.trim().length > 0;
    const allIds = questions.map((q) => q.id);
    return (
      <div className="px-2.5 py-2 text-[11px] leading-relaxed">
        {questions.map((q, qi) => {
          const parsed = hasResult
            ? extractAskAnswer(resultText, q.id, allIds, questions.length === 1)
            : null;
          const customText = parsed?.customText;
          const selectedLabels = new Set(parsed?.labels ?? []);

          return (
            <div key={q.id} className={cn(qi > 0 && 'mt-2 border-t border-border/30 pt-2')}>
              <div className="mb-1 flex items-start gap-1.5">
                <span className="shrink-0 text-[9px] font-bold text-chart-2">Q{qi + 1}</span>
                <span className="flex-1 font-medium text-foreground whitespace-pre-wrap break-words">{q.question}</span>
                {q.multi && (
                  <span className="shrink-0 rounded bg-secondary/60 px-1 py-0.5 text-[8px] text-muted-foreground">多选</span>
                )}
              </div>

              <div className="flex flex-col gap-0.5">
                {q.options.map((opt, oi) => {
                  const isSelected = selectedLabels.has(opt.label);
                  return (
                    <div key={oi} className={cn(
                      'flex items-start gap-1.5 rounded px-2 py-0.5 transition-colors',
                      isSelected && 'bg-status-pass/10',
                    )}>
                      <span className="mt-0.5 shrink-0 text-[10px]">
                        {q.multi ? (isSelected ? '☑' : '☐') : (isSelected ? '◉' : '○')}
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className={cn('text-[10px]', isSelected ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                          {opt.label}
                        </span>
                        {opt.description && (
                          <div className="text-[9px] text-muted-foreground/60">{opt.description}</div>
                        )}
                      </div>
                      {q.recommended === oi && !hasResult && (
                        <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[8px] font-medium text-primary">推荐</span>
                      )}
                    </div>
                  );
                })}
              </div>

              {customText && (
                <div className="mt-1 flex items-start gap-1.5 rounded bg-status-pass/10 px-2 py-0.5">
                  <span className="mt-0.5 shrink-0 text-[10px] text-status-pass-foreground">✎</span>
                  <span className="text-[10px] text-status-pass-foreground">{customText}</span>
                </div>
              )}

              {hasResult && !parsed && (
                <div className="mt-1 text-[10px] text-muted-foreground/50">(无答案)</div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Legacy single-question format
  const question = argStr(args, 'question', 'prompt') ?? '';
  const optionsArg = argVal(args, 'options');
  const options = normalizeAskOptions(optionsArg);
  const hasResult = resultText.trim().length > 0;
  const parsedResult = hasResult ? parseLegacyAskResult(resultText) : null;
  const selectedSet = new Set(parsedResult?.labels ?? []);

  return (
    <div className="px-2.5 py-2 text-[11px] leading-relaxed">
      <div className="mb-1.5 flex items-start gap-1.5">
        <span className="shrink-0 text-[9px] font-bold text-chart-2">Q</span>
        <span className="flex-1 font-medium text-foreground whitespace-pre-wrap break-words">{question}</span>
      </div>
      {options.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {options.map((opt, oi) => {
            const isSelected = selectedSet.has(opt.label);
            return (
              <div key={oi} className={cn(
                'flex items-start gap-1.5 rounded px-2 py-0.5 transition-colors',
                isSelected && 'bg-status-pass/10',
              )}>
                <span className="mt-0.5 shrink-0 text-[10px]">
                  {isSelected ? '◉' : '○'}
                </span>
                <div className="min-w-0 flex-1">
                  <span className={cn('text-[10px]', isSelected ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                    {opt.label}
                  </span>
                  {opt.description && (
                    <div className="text-[9px] text-muted-foreground/60">{opt.description}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {parsedResult?.customText && (
        <div className="mt-1 flex items-start gap-1.5 rounded bg-status-pass/10 px-2 py-0.5">
          <span className="mt-0.5 shrink-0 text-[10px] text-status-pass-foreground">✎</span>
          <span className="text-[10px] text-status-pass-foreground">{parsedResult.customText}</span>
        </div>
      )}
      {hasResult && !parsedResult && (
        <div className="mt-1 text-[10px] text-status-pass-foreground">{resultText}</div>
      )}
    </div>
  );
}
