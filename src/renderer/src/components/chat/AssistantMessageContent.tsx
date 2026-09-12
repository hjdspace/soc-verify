import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { ChatMessage } from '@renderer/stores/session-types';
import { ThinkingBlock } from './ThinkingBlock';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ErrorMessage } from './ErrorMessage';

/** Shared message body for the main conversation and child transcripts. */
export function AssistantMessageContent({ message, children }: {
  message: ChatMessage;
  children?: ReactNode;
}) {
  return <>
    {message.thinking && <ThinkingBlock thinking={message.thinking}
      isStreaming={message.isStreaming === true} hasContent={!!message.content} />}
    {children ?? (message.content?.trimStart().startsWith('[错误]')
      ? <ErrorMessage content={message.content} />
      : message.content
        ? <MarkdownRenderer content={message.content} streaming={message.isStreaming === true} />
        : message.isStreaming && !message.thinking
          ? <div className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /><span className="text-[10px]">思考中...</span>
            </div> : null)}
  </>;
}
