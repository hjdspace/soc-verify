import { memo, useMemo, useState } from 'react';
import { Check, ChevronDown, Copy, FileText, RefreshCw } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { openReviewAwareFile } from '@renderer/stores/diff-review';
import { useSessionMessagesStore } from '@renderer/stores/session-messages';
import type { ChatMessage, SessionEntry } from '@renderer/stores/session-types';
import { extractMessageReferences } from './MarkdownRenderer';

interface AssistantActionsProps {
  message: ChatMessage;
  session?: SessionEntry;
}

/**
 * 回合收尾操作栏（呈现模式参考 beautiful-ui StreamingText 的 done 态）：
 * 助手消息流式结束后淡入——复制、重新生成（仅最后一条助手消息可用）、
 * 以及该消息引用的来源（host URI + 项目文件）可展开列表。
 */
export const AssistantActions = memo(function AssistantActions({ message, session }: AssistantActionsProps) {
  const [copied, setCopied] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const regenerateLast = useSessionMessagesStore((s) => s.regenerateLast);

  const refs = useMemo(() => extractMessageReferences(message.content), [message.content]);

  const lastAssistantId = useMemo(() => {
    if (!session) return undefined;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === 'assistant') return session.messages[i].id;
    }
    return undefined;
  }, [session]);

  // 重新生成只在「本会话最后一条助手消息 + 会话空闲/上次发送失败」时可用——
  // 引擎侧回退分支基于最新一条用户消息，回退更早的消息会丢弃其后的所有轮次。
  const canRegenerate = !!session
    && message.id === lastAssistantId
    && (session.status === 'idle' || session.status === 'error');

  const handleCopy = () => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      // DSH 规范：复制反馈 1000ms 后复原
      setTimeout(() => setCopied(false), 1000);
    });
  };

  const handleRegenerate = () => {
    void regenerateLast();
  };

  return (
    <div className="ap-turnactions" data-testid="assistant-actions">
      <div className="ap-turnactions-row">
        <button
          type="button"
          onClick={handleCopy}
          title="复制"
          aria-label="复制回复"
          className="ap-turnaction-btn"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
        {canRegenerate && (
          <button
            type="button"
            onClick={handleRegenerate}
            title="重新生成"
            aria-label="重新生成回复"
            data-testid="assistant-regenerate"
            className="ap-turnaction-btn"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        )}
        {refs.length > 0 && (
          <button
            type="button"
            onClick={() => setSourcesOpen((v) => !v)}
            aria-expanded={sourcesOpen}
            title="引用来源"
            className="ap-turnaction-btn ap-turnaction-sources-toggle"
          >
            <span>引用 {refs.length} 项</span>
            <ChevronDown className={cn('h-3 w-3 transition-transform', sourcesOpen && 'rotate-180')} />
          </button>
        )}
      </div>

      {sourcesOpen && (
        <div className="ap-turnactions-sources" data-testid="assistant-sources">
          {refs.map((ref) =>
            ref.kind === 'file' ? (
              <button
                key={`file:${ref.path}:${ref.line ?? ''}`}
                type="button"
                className="ap-turnactions-source"
                title={`点击打开: ${ref.path}${ref.line ? `:${ref.line}` : ''}`}
                onClick={() => openReviewAwareFile(ref.path, ref.path.split('/').pop() ?? ref.path)}
              >
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                <span className="truncate font-mono">{ref.display}</span>
              </button>
            ) : (
              <span key={ref.uri} className="ap-turnactions-source" title={ref.uri}>
                <span className="truncate font-mono">{ref.uri}</span>
              </span>
            ),
          )}
        </div>
      )}
    </div>
  );
});
