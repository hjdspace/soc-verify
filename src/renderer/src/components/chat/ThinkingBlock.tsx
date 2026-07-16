import { useState, useEffect, memo, useRef } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

interface ThinkingBlockProps {
  /** The thinking/reasoning text from the LLM. */
  thinking: string;
  /** Whether the parent message is still streaming. */
  isStreaming: boolean;
  /** Whether the main response text (content) has started appearing. */
  hasContent: boolean;
}

/**
 * Collapsible thinking/reasoning block.
 *
 * Behavior:
 * - While the LLM is actively outputting thinking (streaming + has thinking + no text yet):
 *   auto-expanded with a blinking indicator.
 * - When thinking is complete (text starts appearing or streaming stops):
 *   auto-collapses.
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

  return (
    <div className="mb-1 overflow-hidden rounded-md border border-border/40 bg-secondary/20">
      {/* Header — clickable to toggle */}
      <button
        onClick={handleToggle}
        className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left transition-colors hover:bg-secondary/40"
      >
        {isThinkingActive ? (
          /* Blinking dot indicator while thinking is active */
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
        ) : (
          <Brain className="h-2.5 w-2.5 shrink-0 text-muted-foreground/60" />
        )}
        <span
          className={cn(
            'text-[10px] font-medium',
            isThinkingActive ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          {isThinkingActive ? '思考中...' : '思考过程'}
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
        <div className="border-t border-border/30">
          <div
            ref={scrollRef}
            className="max-h-60 overflow-y-auto px-2.5 py-1.5"
          >
            <div className="whitespace-pre-wrap break-words text-[10px] leading-relaxed text-muted-foreground/80">
              {thinking}
              {isThinkingActive && (
                <span className="ml-0.5 inline-block h-2.5 w-0.5 animate-pulse bg-primary/60 align-middle" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
