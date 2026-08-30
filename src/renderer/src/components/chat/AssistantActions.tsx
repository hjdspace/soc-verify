import { memo, useMemo, useState } from 'react';
import { Check, Copy, CornerDownRight, RefreshCw } from 'lucide-react';
import { openReviewAwareFile } from '@renderer/stores/diff-review';
import { useSessionMessagesStore } from '@renderer/stores/session-messages';
import type { ChatMessage, SessionEntry } from '@renderer/stores/session-types';
import { extractMessageReferences } from './MarkdownRenderer';
import { SourceIcon } from './SourceIcon';

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
  const sendMessage = useSessionMessagesStore((s) => s.sendMessage);

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
  const isLastAssistant = !!session && message.id === lastAssistantId;
  const canRegenerate = isLastAssistant
    && !!session
    && (session.status === 'idle' || session.status === 'error');
  // 建议追问只挂在最后一条助手消息上（生成完成且未被新回合清除后出现）
  const followUps = isLastAssistant ? session?.followUps : undefined;

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

  const handleFollowUp = (text: string) => {
    void sendMessage(text);
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
            data-testid="assistant-sources-toggle"
            className="ap-turnaction-btn ap-sources-pill"
          >
            <span className="ap-sources-stack">
              {refs.slice(0, 3).map((ref) => (
                <SourceIcon
                  key={ref.kind === 'file' ? `file:${ref.path}:${ref.line ?? ''}` : ref.uri}
                  source={ref}
                  variant="stack"
                />
              ))}
            </span>
            <span>引用 {refs.length} 项</span>
          </button>
        )}
      </div>

      {refs.length > 0 && (
        <div className="ap-sources-collapse" data-open={sourcesOpen}>
          <div className="ap-sources-collapse-clip">
            <div className="ap-turnactions-sources" data-testid="assistant-sources">
              {refs.map((ref) => {
                if (ref.kind === 'file') {
                  const name = ref.path.split('/').pop() ?? ref.path;
                  const dir = ref.path.includes('/') ? ref.path.slice(0, ref.path.lastIndexOf('/')) : '';
                  const location =
                    `${dir}${ref.line ? `:${ref.line}${ref.endLine ? `-${ref.endLine}` : ''}` : ''}`;
                  return (
                    <button
                      key={`file:${ref.path}:${ref.line ?? ''}`}
                      type="button"
                      className="ap-turnactions-source"
                      title={`点击打开: ${ref.path}${ref.line ? `:${ref.line}` : ''}`}
                      onClick={() => openReviewAwareFile(ref.path, name)}
                    >
                      <SourceIcon source={ref} variant="row" />
                      <span className="ap-source-name">{name}</span>
                      {location && <span className="ap-source-meta font-mono">{location}</span>}
                    </button>
                  );
                }
                const scheme = ref.uri.slice(0, ref.uri.indexOf('://'));
                return (
                  <span key={ref.uri} className="ap-turnactions-source" title={ref.uri}>
                    <SourceIcon source={ref} variant="row" />
                    <span className="ap-source-name">{ref.display}</span>
                    <span className="ap-source-meta font-mono">{scheme}://</span>
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {followUps && followUps.length > 0 && (
        <div className="ap-followups" data-testid="assistant-followups">
          <p className="ap-followups-label">建议追问</p>
          {followUps.map((text, index) => (
            <button
              key={`${index}:${text}`}
              type="button"
              className="ap-followup-item"
              style={{ animationDelay: `${120 + index * 90}ms` }}
              onClick={() => handleFollowUp(text)}
            >
              <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
              <span className="truncate">{text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
