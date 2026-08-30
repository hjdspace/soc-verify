import { useRef, type ReactNode } from 'react';
import { SelectionActions, SELECTION_ACTIONS } from '@renderer/components/ui/SelectionActions';
import { useSelectionAnchor, type SelectionAnchor, type SelectionSnapshot } from '@renderer/hooks/use-selection-anchor';
import { useSelectionRun, type SelectionRunRequest } from '@renderer/hooks/use-selection-run';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import { useSessionMessagesStore } from '@renderer/stores/session-messages';
import type { SessionEntry } from '@renderer/stores/session-types';

/**
 * 划选 AI 操作条的宿主（issues #5；issues #11 扩展到文件/产物表面）。
 *
 * 包住可划选内容（AI 气泡 MarkdownRenderer、FileEditor 的 md 预览与
 * CodeMirror 编辑区）：内部跑 useSelectionAnchor（划选监听/锚点）与
 * useSelectionRun（回合状态机），把快捷动作与自定义 prompt 组装成一条
 * 带引用上下文的消息走现有 session 发送链路（sendMessage）；Discard/
 * Retry 经 removeMessagesFrom 移除本回合新增消息、恢复提交前的会话状态。
 *
 * 会话解析：显式 `session` prop（气泡宿主，会话即消息所属会话）优先；
 * 否则回退到 session-core 的当前会话（文件宿主与 AI 无绑定会话，落
 * currentSessionId）。无任何会话时禁用划选监听——动作无发送目标。
 * 多宿主并存（气泡 × N + 文件 × 1）靠 useSelectionAnchor 的 host
 * containment 过滤天然互斥：只有包含选区的宿主弹出浮条。
 *
 * enabled 关闭（回合进行中/流式中）时停止划选监听，但已开始的回合
 * （request 非空）仍继续驱动浮条直到 Keep/Discard/dismiss。
 */

/** 划选来源：决定引用块标注（「引用自你的回复」/「引用自文件 <path>」） */
export type SelectionQuoteSource = { kind: 'reply' } | { kind: 'file'; path: string };

/** 引用块携带的最大字符数，超出截断（防极端长选区撑爆消息） */
const QUOTE_MAX_CHARS = 2000;

/** 快捷动作 key → 发送消息的指令文案 */
const ACTION_INSTRUCTIONS: Record<string, string> = {
  explain: '请解释下面引用的这段内容',
  improve: '请改进下面引用的这段内容的表达，使其更清晰专业',
  shorten: '请精简下面引用的这段内容，保留关键信息',
  expand: '请展开说明下面引用的这段内容，补充必要的细节',
  translate: '请翻译下面引用的这段内容（中文译英文，英文译中文）',
};

function quoteSourceLabel(source: SelectionQuoteSource): string {
  return source.kind === 'file' ? `引用自文件 ${source.path}` : '引用自你的回复';
}

function buildQuotedMessage(request: SelectionRunRequest, quote: string, source: SelectionQuoteSource): string {
  const clipped = quote.length > QUOTE_MAX_CHARS ? `${quote.slice(0, QUOTE_MAX_CHARS)}…` : quote;
  const quoted = clipped
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const instruction = request.prompt ?? ACTION_INSTRUCTIONS[request.action] ?? `请${request.label}下面引用的这段内容`;
  return `${instruction}\n\n> ${quoteSourceLabel(source)}：\n${quoted}`;
}

export function SelectionActionsHost({
  session,
  source = { kind: 'reply' },
  enabled = true,
  className,
  children,
}: {
  /** 会话（气泡宿主显式传入）；缺省时回退当前会话，无会话则禁用划选 */
  session?: SessionEntry;
  /** 划选来源（引用块标注），默认「你的回复」 */
  source?: SelectionQuoteSource;
  /** 划选监听开关（气泡流式中/回合执行中关闭） */
  enabled?: boolean;
  /** 宿主容器附加类（文件宿主需要接管原容器的 h-full/max-w 等布局类） */
  className?: string;
  children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<SelectionSnapshot | null>(null);
  // 提交前的消息数——Discard/Retry 删除本回合消息（恢复原文）的截断点
  const baselineRef = useRef<number | null>(null);

  // 文件宿主不传 session：回退当前会话（find 返回 store 内的对象引用，
  // 消息流更新才会触发重渲染）。sendMessage 本就发往 currentSessionId
  const currentSession = useSessionCoreStore((s) =>
    s.currentSessionId ? s.sessions.find((entry) => entry.id === s.currentSessionId) : undefined,
  );
  const activeSession = session ?? currentSession;

  const sendMessage = useSessionMessagesStore((s) => s.sendMessage);
  const removeMessagesFrom = useSessionMessagesStore((s) => s.removeMessagesFrom);
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const removeRef = useRef(removeMessagesFrom);
  removeRef.current = removeMessagesFrom;

  const run = useSelectionRun({
    session: activeSession,
    onSubmit: (request) => {
      if (!activeSession) return;
      // 基线取 live store 而非渲染闭包里的 session：Retry 在同一事件
      // 内先 onCancel（截断）再重提，prop 尚未重渲染，用 prop 会拿到截断
      // 前的消息数，后续 Discard 将截不到任何消息
      const live = useSessionCoreStore
        .getState()
        .sessions.find((s) => s.id === activeSession.id);
      baselineRef.current = (live ?? activeSession).messages.length;
      const quote = selectionRef.current?.text ?? '';
      void sendMessageRef.current(buildQuotedMessage(request, quote, source));
    },
    onCancel: () => {
      const sessionId = activeSession?.id;
      if (sessionId && baselineRef.current !== null) {
        removeRef.current(sessionId, baselineRef.current);
        baselineRef.current = null;
      }
    },
  });

  const { selection, anchor } = useSelectionAnchor({
    hostRef,
    // 无会话时动作无发送目标，禁用划选；回合进行中 enabled 会随宿主门控
    // 翻转——已开始的回合必须继续驱动浮条
    enabled: (enabled && !!activeSession) || run.request !== null,
  });
  selectionRef.current = selection;

  // 选区折叠（用户点了别处）后锚点清空——回合进行中浮条不得跳位，
  // 停留在最后锚点处直到 Keep/Discard/dismiss
  const lastAnchorRef = useRef<SelectionAnchor | null>(null);
  if (anchor) lastAnchorRef.current = anchor;
  const barAnchor = anchor ?? lastAnchorRef.current;
  const visible = barAnchor !== null && (run.request !== null || selection !== null);

  const actionLabel = (key: string) => SELECTION_ACTIONS.find((a) => a.key === key)?.label ?? key;

  return (
    <div ref={hostRef} className={className ? `relative ${className}` : 'relative'}>
      {children}
      <SelectionActions
        actions={SELECTION_ACTIONS}
        anchor={barAnchor}
        visible={visible}
        phase={run.phase}
        request={run.request}
        streamText={run.streamText}
        onSelectAction={(key) => run.run({ action: key, label: actionLabel(key), prompt: null })}
        onSubmitPrompt={(prompt) => run.run({ action: 'prompt', label: prompt, prompt })}
        onKeep={run.keep}
        onDiscard={run.discard}
        onRetry={run.retry}
        onDismiss={run.dismiss}
      />
    </div>
  );
}
