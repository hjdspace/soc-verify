import { useRef, type ReactNode } from 'react';
import { SelectionActions, SELECTION_ACTIONS } from '@renderer/components/ui/SelectionActions';
import { useSelectionAnchor, type SelectionAnchor, type SelectionSnapshot } from '@renderer/hooks/use-selection-anchor';
import { useSelectionRun, type SelectionRunRequest } from '@renderer/hooks/use-selection-run';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import { useSessionMessagesStore } from '@renderer/stores/session-messages';
import type { SessionEntry } from '@renderer/stores/session-types';

/**
 * 划选 AI 操作条的气泡宿主（issues #5）。
 *
 * 包住 AI 消息气泡内容（MarkdownRenderer）：内部跑 useSelectionAnchor
 * （划选监听/锚点）与 useSelectionRun（回合状态机），把快捷动作与自定义
 * prompt 组装成一条带引用上下文的消息走现有 session 发送链路
 * （sendMessage）；Discard/Retry 经 removeMessagesFrom 移除本回合新增
 * 消息、恢复提交前的会话状态。
 *
 * enabled 关闭（回合进行中/流式中）时停止划选监听，但已开始的回合
 * （request 非空）仍继续驱动浮条直到 Keep/Discard/dismiss。
 */

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

function buildQuotedMessage(request: SelectionRunRequest, quote: string): string {
  const clipped = quote.length > QUOTE_MAX_CHARS ? `${quote.slice(0, QUOTE_MAX_CHARS)}…` : quote;
  const quoted = clipped
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const instruction = request.prompt ?? ACTION_INSTRUCTIONS[request.action] ?? `请${request.label}下面引用的这段内容`;
  return `${instruction}\n\n> 引用自你的回复：\n${quoted}`;
}

export function SelectionActionsHost({
  session,
  enabled,
  children,
}: {
  session?: SessionEntry;
  /** 划选监听开关（气泡流式中/回合执行中关闭） */
  enabled: boolean;
  children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<SelectionSnapshot | null>(null);
  // 提交前的消息数——Discard/Retry 删除本回合消息（恢复原文）的截断点
  const baselineRef = useRef<number | null>(null);

  const sendMessage = useSessionMessagesStore((s) => s.sendMessage);
  const removeMessagesFrom = useSessionMessagesStore((s) => s.removeMessagesFrom);
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const removeRef = useRef(removeMessagesFrom);
  removeRef.current = removeMessagesFrom;

  const run = useSelectionRun({
    session,
    onSubmit: (request) => {
      if (!session) return;
      // 基线取 live store 而非渲染闭包里的 session prop：Retry 在同一事件
      // 内先 onCancel（截断）再重提，prop 尚未重渲染，用 prop 会拿到截断
      // 前的消息数，后续 Discard 将截不到任何消息
      const live = useSessionCoreStore
        .getState()
        .sessions.find((s) => s.id === session.id);
      baselineRef.current = (live ?? session).messages.length;
      const quote = selectionRef.current?.text ?? '';
      void sendMessageRef.current(buildQuotedMessage(request, quote));
    },
    onCancel: () => {
      const sessionId = session?.id;
      if (sessionId && baselineRef.current !== null) {
        removeRef.current(sessionId, baselineRef.current);
        baselineRef.current = null;
      }
    },
  });

  const { selection, anchor } = useSelectionAnchor({
    hostRef,
    // 回合进行中 enabled 会随宿主门控翻转——已开始的回合必须继续驱动浮条
    enabled: enabled || run.request !== null,
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
    <div ref={hostRef} className="relative">
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
