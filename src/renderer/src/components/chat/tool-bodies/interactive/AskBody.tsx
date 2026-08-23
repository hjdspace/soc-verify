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

/** Parse the tool result text to extract user answers for display. */
function parseAskResult(resultText: string): { selectedLabels: string[]; customInput?: string } | null {
  if (!resultText) return null;
  const selectedMatch = resultText.match(/User selected:\s*(.+)/);
  if (selectedMatch) {
    return { selectedLabels: selectedMatch[1].split(',').map((s) => s.trim()).filter(Boolean) };
  }
  const customMatch = resultText.match(/User provided custom input:\s*(.+)/);
  if (customMatch) {
    return { selectedLabels: [], customInput: customMatch[1].trim() };
  }
  if (resultText.startsWith('User answers:')) {
    return { selectedLabels: [resultText] };
  }
  return null;
}

export function AskBody({ args, resultText }: { args: unknown; resultText: string }) {
  const questionsArg = argVal(args, 'questions');
  const questions = normalizeAskQuestions(questionsArg);

  // Multi-question format: render each question with its options
  if (questions.length > 0) {
    const hasResult = resultText.trim().length > 0;
    return (
      <div className="px-2.5 py-2 text-[11px] leading-relaxed">
        {questions.map((q, qi) => {
          const answerRegex = new RegExp(`${q.id}:\\s*(.+)`);
          const answerMatch = hasResult ? resultText.match(answerRegex) : null;
          const answerText = answerMatch ? answerMatch[1].trim() : null;
          const isCustomAnswer = answerText != null && answerText.startsWith('"') && answerText.endsWith('"');
          const customText = isCustomAnswer && answerText != null ? answerText.slice(1, -1) : undefined;
          const isMultiAnswer = answerText != null && answerText.startsWith('[') && answerText.endsWith(']');
          const multiLabels = isMultiAnswer && answerText != null ? answerText.slice(1, -1).split(',').map((s) => s.trim()) : [];

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
                  const isSelected = hasResult && (
                    (isMultiAnswer && multiLabels.includes(opt.label)) ||
                    (!isMultiAnswer && !isCustomAnswer && answerText === opt.label)
                  );
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

              {hasResult && !answerText && (
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
  const parsedResult = hasResult ? parseAskResult(resultText) : null;
  const selectedSet = new Set(parsedResult?.selectedLabels ?? []);

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
      {parsedResult?.customInput && (
        <div className="mt-1 flex items-start gap-1.5 rounded bg-status-pass/10 px-2 py-0.5">
          <span className="mt-0.5 shrink-0 text-[10px] text-status-pass-foreground">✎</span>
          <span className="text-[10px] text-status-pass-foreground">{parsedResult.customInput}</span>
        </div>
      )}
      {hasResult && !parsedResult && (
        <div className="mt-1 text-[10px] text-status-pass-foreground">{resultText}</div>
      )}
    </div>
  );
}
