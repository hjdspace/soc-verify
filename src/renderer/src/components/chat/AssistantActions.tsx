import { memo, useMemo, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { openReviewAwareFile } from '@renderer/stores/diff-review';
import { useSessionMessagesStore } from '@renderer/stores/session-messages';
import type { ChatMessage, SessionEntry } from '@renderer/stores/session-types';
import { extractMessageReferences, type MessageReference } from './MarkdownRenderer';
import { refIdentity, SourceIcon, type SourceHue } from './SourceIcon';
import { ContextCardList, deriveBadge, type ContextChunk, type ContextTone } from '@renderer/components/ui/ContextCard';
import { RecommendationCard, type RecommendationOption } from '@renderer/components/ui/RecommendationCard';

// SourceHue→chunk 卡 badge 语义色（blue/violet 收敛为 accent，teal 收敛为 green）
const HUE_TONE: Record<SourceHue, ContextTone> = {
  blue: 'accent',
  green: 'green',
  orange: 'orange',
  violet: 'accent',
  teal: 'green',
  rose: 'red',
  amber: 'orange',
};

/**
 * 把消息引用来源映射为 chunk 卡数据：标题=文件名/URI 显示，meta=行号区间，
 * body=全路径/全 URI（来源定位），底部 chip=目录/scheme 前缀，文件项可点击打开。
 */
function refToChunk(ref: MessageReference): ContextChunk {
  if (ref.kind === 'file') {
    const name = ref.path.split('/').pop() ?? ref.path;
    const dir = ref.path.includes('/') ? ref.path.slice(0, ref.path.lastIndexOf('/')) : '';
    const lineMeta = ref.line
      ? ref.endLine
        ? `L${ref.line}–${ref.endLine}`
        : `L${ref.line}`
      : undefined;
    return {
      key: `file:${ref.path}:${ref.line ?? ''}`,
      icon: <SourceIcon source={ref} variant="row" />,
      title: name,
      meta: lineMeta,
      body: ref.path,
      source: dir || ref.path,
      badge: deriveBadge(ref.path),
      tone: HUE_TONE[refIdentity(ref).hue],
      onClick: () => openReviewAwareFile(ref.path, name),
    };
  }
  const scheme = ref.uri.slice(0, ref.uri.indexOf('://'));
  return {
    key: ref.uri,
    icon: <SourceIcon source={ref} variant="row" />,
    title: ref.display,
    body: ref.uri,
    source: `${scheme}://`,
  };
}

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
  const chunks = useMemo(() => refs.map(refToChunk), [refs]);

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

  // 追问建议接入通用建议卡（RecommendationCard 第二场景）：首条为当前建议，
  // 其余进备选抽屉；无置信度语义，不渲染信号条（signal/tone/label 缺省）。
  const followUpOptions = useMemo<RecommendationOption[]>(
    () =>
      (followUps ?? []).map((text, i) => ({
        key: `${i}:${text}`,
        body: text,
        short: text,
        cta: '发送追问',
        ctaVariant: 'primary' as const,
      })),
    [followUps],
  );

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
            <div data-testid="assistant-sources">
              <ContextCardList chunks={chunks} active={sourcesOpen} />
            </div>
          </div>
        </div>
      )}

      {followUpOptions.length > 0 && (
        <div className="ap-followups" data-testid="assistant-followups">
          <RecommendationCard
            options={followUpOptions}
            title="建议追问"
            acceptedLabel="已发送"
            onAccept={(o) => handleFollowUp(o.short)}
          />
        </div>
      )}
    </div>
  );
});
