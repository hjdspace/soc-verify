/**
 * Interactive question card for the `ask` tool.
 *
 * When the AI calls the `ask` tool, the host emits an `askRequest` event
 * containing one or more questions with selectable options. This component
 * renders an interactive card that lets the user pick options (radio for
 * single-select, checkbox for multi-select), type a custom "Other" answer,
 * and submit — resolving the pending ask request.
 */
import { memo, useState, useCallback } from 'react';
import { HelpCircle, Check, ChevronDown, ChevronUp, Send } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { AskAnswer, AskOption, AskQuestion } from '@shared/ask-types';

interface AskQuestionCardProps {
  requestId: string;
  questions: AskQuestion[];
  onResolve: (requestId: string, answers: AskAnswer[]) => void;
}

/** Suffix appended to the recommended option label. */
const RECOMMENDED_BADGE = '推荐';

export const AskQuestionCard = memo(function AskQuestionCard({
  requestId,
  questions,
  onResolve,
}: AskQuestionCardProps) {
  // ── Per-question answer state ──────────────────────────
  // selectedOptions: questionId → Set of selected option labels
  // customInputs:    questionId → custom text (when "Other" is chosen)
  // otherMode:       questionId → true when the user picked "Other"
  const [selectedOptions, setSelectedOptions] = useState<Record<string, Set<string>>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [otherMode, setOtherMode] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [expandedQuestions, setExpandedQuestions] = useState<Set<string>>(
    () => new Set(questions.map((q) => q.id)),
  );

  const toggleQuestionExpanded = useCallback((qid: string) => {
    setExpandedQuestions((prev) => {
      const next = new Set(prev);
      if (next.has(qid)) next.delete(qid);
      else next.add(qid);
      return next;
    });
  }, []);

  const handleSelectOption = useCallback((qid: string, option: string, multi?: boolean) => {
    if (multi) {
      setSelectedOptions((prev) => {
        const current = new Set(prev[qid] ?? []);
        if (current.has(option)) current.delete(option);
        else current.add(option);
        return { ...prev, [qid]: current };
      });
    } else {
      setSelectedOptions((prev) => ({ ...prev, [qid]: new Set([option]) }));
      // Switching away from "Other"
      setOtherMode((prev) => ({ ...prev, [qid]: false }));
    }
  }, []);

  const handleToggleOther = useCallback((qid: string) => {
    setOtherMode((prev) => {
      const next = { ...prev, [qid]: !prev[qid] };
      // When leaving "Other" mode, clear the custom input from selections
      if (!next[qid]) {
        setCustomInputs((prevCI) => ({ ...prevCI, [qid]: '' }));
      }
      return next;
    });
  }, []);

  const handleCustomInputChange = useCallback((qid: string, value: string) => {
    setCustomInputs((prev) => ({ ...prev, [qid]: value }));
  }, []);

  // ── Validation: all questions must have an answer ──────
  const allAnswered = questions.every((q) => {
    if (otherMode[q.id]) return (customInputs[q.id] ?? '').trim().length > 0;
    return (selectedOptions[q.id]?.size ?? 0) > 0;
  });

  const handleSubmit = useCallback(() => {
    if (!allAnswered) return;
    const answers: AskAnswer[] = questions.map((q) => {
      if (otherMode[q.id]) {
        return {
          questionId: q.id,
          selectedOptions: [],
          customInput: (customInputs[q.id] ?? '').trim(),
        };
      }
      return {
        questionId: q.id,
        selectedOptions: Array.from(selectedOptions[q.id] ?? []),
      };
    });
    setSubmitted(true);
    onResolve(requestId, answers);
  }, [allAnswered, questions, otherMode, customInputs, selectedOptions, requestId, onResolve]);

  if (submitted) {
    return (
      <div className="rounded-lg border border-status-pass/40 bg-status-pass/5 p-2.5 text-xs">
        <div className="flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 shrink-0 text-status-pass-foreground" />
          <span className="font-semibold text-status-pass-foreground">答案已提交</span>
        </div>
        <div className="mt-2 space-y-2">
          {questions.map((q, qi) => {
            const ans = otherMode[q.id]
              ? (customInputs[q.id] ?? '').trim()
              : Array.from(selectedOptions[q.id] ?? []).join(', ');
            return (
              <div key={q.id} className="text-[10px]">
                <div className="font-medium text-foreground/80">
                  Q{qi + 1}: {q.question}
                </div>
                <div className="mt-0.5 text-status-pass-foreground">
                  ➡️ {ans || '(无答案)'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs">
      {/* Header */}
      <div className="flex items-center gap-1.5">
        <HelpCircle className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="font-semibold text-foreground">
          AI 提问
        </span>
        <span className="ml-auto text-[9px] text-muted-foreground">
          {questions.length} 个问题
        </span>
      </div>

      {/* Questions */}
      <div className="mt-2 space-y-2.5">
        {questions.map((q, qi) => {
          const isExpanded = expandedQuestions.has(q.id);
          const qSelected = selectedOptions[q.id] ?? new Set<string>();
          const qOtherMode = otherMode[q.id] ?? false;
          return (
            <div key={q.id} className="rounded-md border border-border/40 bg-background/50">
              {/* Question header (clickable to collapse) */}
              <button
                onClick={() => toggleQuestionExpanded(q.id)}
                className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left"
              >
                <span className="shrink-0 text-[9px] font-bold text-primary">Q{qi + 1}</span>
                <span className="flex-1 min-w-0 text-[11px] font-medium text-foreground whitespace-pre-wrap break-words">
                  {q.question}
                </span>
                {isExpanded ? (
                  <ChevronUp className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                )}
              </button>

              {/* Options (when expanded) */}
              {isExpanded && (
                <div className="border-t border-border/30 px-2 py-1.5">
                  <QuestionOptions
                    question={q}
                    selected={qSelected}
                    otherMode={qOtherMode}
                    onSelectOption={handleSelectOption}
                    onToggleOther={handleToggleOther}
                    customInput={customInputs[q.id] ?? ''}
                    onCustomInputChange={handleCustomInputChange}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Submit button */}
      <div className="mt-2.5 flex items-center justify-end gap-1.5">
        <button
          onClick={handleSubmit}
          disabled={!allAnswered}
          className={cn(
            'flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
            allAnswered
              ? 'bg-primary/15 text-primary hover:bg-primary/25'
              : 'bg-secondary text-muted-foreground/50 cursor-not-allowed',
          )}
        >
          <Send className="h-3 w-3" />
          <span>提交答案</span>
        </button>
      </div>
    </div>
  );
});

// ── Sub-component: Question Options ──────────────────────

interface QuestionOptionsProps {
  question: AskQuestion;
  selected: Set<string>;
  otherMode: boolean;
  customInput: string;
  onSelectOption: (qid: string, option: string, multi?: boolean) => void;
  onToggleOther: (qid: string) => void;
  onCustomInputChange: (qid: string, value: string) => void;
}

function QuestionOptions({
  question,
  selected,
  otherMode,
  customInput,
  onSelectOption,
  onToggleOther,
  onCustomInputChange,
}: QuestionOptionsProps) {
  const { id: qid, options, multi, recommended } = question;

  return (
    <div className="flex flex-col gap-1">
      {options.map((opt, oi) => {
        const isSelected = selected.has(opt.label);
        const isRecommended = recommended === oi;
        return (
          <OptionItem
            key={`${qid}-${oi}`}
            option={opt}
            isSelected={isSelected}
            isRecommended={isRecommended}
            multi={multi}
            onClick={() => onSelectOption(qid, opt.label, multi)}
          />
        );
      })}

      {/* "Other" option */}
      <button
        onClick={() => onToggleOther(qid)}
        className={cn(
          'flex items-start gap-1.5 rounded border px-2 py-1 text-left transition-colors',
          otherMode
            ? 'border-primary/40 bg-primary/10 text-foreground'
            : 'border-border/40 text-muted-foreground hover:border-primary/30 hover:bg-primary/5',
        )}
      >
        <span className="mt-0.5 shrink-0 text-[10px]">
          {multi ? (otherMode ? '☑' : '☐') : (otherMode ? '◉' : '○')}
        </span>
        <span className="text-[11px] italic">其他（自定义输入）</span>
      </button>

      {/* Custom input textarea when "Other" is selected */}
      {otherMode && (
        <textarea
          value={customInput}
          onChange={(e) => onCustomInputChange(qid, e.target.value)}
          placeholder="输入你的回答..."
          rows={2}
          autoFocus
          className="resize-none rounded border border-primary/30 bg-background px-2 py-1 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
        />
      )}
    </div>
  );
}

// ── Sub-component: Single Option Item ────────────────────

interface OptionItemProps {
  option: AskOption;
  isSelected: boolean;
  isRecommended: boolean;
  multi?: boolean;
  onClick: () => void;
}

function OptionItem({ option, isSelected, isRecommended, multi, onClick }: OptionItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-start gap-1.5 rounded border px-2 py-1 text-left transition-colors',
        isSelected
          ? 'border-primary/40 bg-primary/10 text-foreground'
          : 'border-border/40 text-muted-foreground hover:border-primary/30 hover:bg-primary/5',
      )}
    >
      <span className="mt-0.5 shrink-0 text-[10px]">
        {multi ? (isSelected ? '☑' : '☐') : (isSelected ? '◉' : '○')}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className={cn('text-[11px]', isSelected && 'font-medium text-foreground')}>
            {option.label}
          </span>
          {isRecommended && (
            <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[8px] font-medium text-primary">
              {RECOMMENDED_BADGE}
            </span>
          )}
        </div>
        {option.description && (
          <div className="mt-0.5 text-[9px] text-muted-foreground/70 line-clamp-2">
            {option.description}
          </div>
        )}
      </div>
    </button>
  );
}
