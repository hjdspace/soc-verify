import { useState, useEffect, memo, useRef } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { ThinkingOrb } from '@renderer/components/visual';

interface ThinkingBlockProps {
  /** The thinking/reasoning text from the LLM. */
  thinking: string;
  /** Whether the parent message is still streaming. */
  isStreaming: boolean;
  /** Whether the main response text (content) has started appearing. */
  hasContent: boolean;
}

/**
 * Think 推理折叠行（DSH §5.2 形态）。
 *
 * Behavior:
 * - While the LLM is actively outputting thinking (streaming + has thinking + no text yet):
 *   auto-expanded with a pulsing indicator + 行内扫光.
 * - When thinking is complete (text starts appearing or streaming stops):
 *   auto-collapses to a single-line summary row.
 * - User can always manually toggle expand/collapse after auto-collapse.
 */
export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  isStreaming,
  hasContent,
}: ThinkingBlockProps) {
  // Thinking is "active" when streaming, thinking content exists, but no text response yet.
  const isThinkingActive = isStreaming && !!thinking && !hasContent;

  const [expanded, setExpanded] = useState(isThinkingActive);
  // Track whether the user has manually toggled — once they do, stop auto-updating.
  const userToggledRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-expand when thinking starts, auto-collapse when thinking completes.
  useEffect(() => {
    if (!userToggledRef.current) {
      setExpanded(isThinkingActive);
    }
  }, [isThinkingActive]);

  // Auto-scroll thinking content to bottom while streaming.
  useEffect(() => {
    if (expanded && isThinkingActive && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [thinking, expanded, isThinkingActive]);

  const handleToggle = () => {
    userToggledRef.current = true;
    setExpanded((v) => !v);
  };

  if (!thinking) return null;

  // 折叠摘要：流式中跟随最新一行，完成后取首行
  const lines = thinking.split('\n').filter((l) => l.trim());
  const summary = isThinkingActive
    ? (lines[lines.length - 1] ?? '')
    : (lines[0] ?? '');

  return (
    <div className={cn('rounded-lg', isThinkingActive && 'ap-sweep')}>
      {/* Header — clickable to toggle */}
      <button
        onClick={handleToggle}
        className="flex min-h-[24px] w-full select-none items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--dsw-hover-bg)]"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {isThinkingActive ? (
            /* Semantic breathing orb while AI is thinking */
            <ThinkingOrb state="breathing" size={20} theme="auto" />
          ) : (
            <Brain className="h-3 w-3 shrink-0 text-muted-foreground/70" />
          )}
        </span>
        <span
          className={cn(
            'shrink-0 text-[11px] font-medium',
            isThinkingActive ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          Think
        </span>
        <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-[var(--dsw-label-caption)]" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {summary}
        </span>
        <ChevronDown
          className={cn(
            'ml-auto h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {/* Thinking content — collapsible */}
      {expanded && (
        <div className="px-1 pt-0.5">
          <div
            ref={scrollRef}
            className="max-h-60 overflow-y-auto rounded-lg bg-[var(--dsw-code-block)] px-2.5 py-1.5"
          >
            <div className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-muted-foreground">
              {thinking}
              {isThinkingActive && (
                <span className="ml-0.5 inline-block h-2.5 w-0.5 animate-pulse bg-primary align-middle" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
