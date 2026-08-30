import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, SessionEntry } from '@renderer/stores/session-types';

/**
 * 划选动作回合状态机（issues #5）。
 *
 * idle → thinking（动作已提交、回复未出首字）→ streaming（回复逐字增长）
 * → result（回合落定，Keep/Discard/Retry）。phase 从会话状态**派生**而非
 * 逐个事件推进：宿主只需传入当前 session 对象，hook 自尾扫描找出本回合
 * 新增的 assistant 消息（run 时不在场的 id），据此判定阶段；result 用
 * latch 锁存——回合结束后用户手动发起新回合不会把浮条拖回 busy 态。
 *
 * 实际执行（session 发送链路）与恢复原文（删除本回合消息）都由宿主
 * 回调承担：onSubmit / onCancel。测试直接构造假 session 对象驱动，
 * 无需 mock store（issue #5 测试缝）。
 */

export type SelectionPhase = 'idle' | 'thinking' | 'streaming' | 'result';

export type SelectionRunRequest = {
  /** 快捷动作 key；自定义 prompt 提交时为 'prompt' */
  action: string;
  /** 展示名（busy 标签 / 重试复现） */
  label: string;
  /** 自定义 prompt 文本；快捷动作为 null */
  prompt: string | null;
};

/** run 时在场的 assistant 消息之外，本回合新增的回复消息 */
function findTurnReply(messages: ChatMessage[], knownIds: ReadonlySet<string>): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'assistant' && !knownIds.has(message.id)) return message;
  }
  return undefined;
}

export function useSelectionRun(options: {
  /** 当前会话（phase 派生数据源）；undefined 时停在 thinking，浮条可 dismiss 兜底 */
  session?: SessionEntry;
  /** 提交动作（宿主发送带引用上下文的消息）。run 与 retry 都经过它 */
  onSubmit: (request: SelectionRunRequest) => void;
  /** 恢复原文（宿主删除本回合新增消息）。discard 与 retry 前清理都经过它 */
  onCancel?: (request: SelectionRunRequest) => void;
}): {
  phase: SelectionPhase;
  request: SelectionRunRequest | null;
  /** streaming/result 阶段本回合回复的实时文本（浮条预览） */
  streamText: string;
  run: (request: SelectionRunRequest) => void;
  /** 接受结果：回 idle（宿主负责清除选区等收尾） */
  keep: () => void;
  /** 放弃结果：恢复原文 + 回 idle */
  discard: () => void;
  /** 重跑当前动作：先恢复原文，再重新提交 */
  retry: () => void;
  /** busy 中脱离：回合照常进行，仅浮条关闭（不触发 onCancel） */
  dismiss: () => void;
} {
  const { session, onSubmit, onCancel } = options;

  const [request, setRequest] = useState<SelectionRunRequest | null>(null);
  const [resultLatch, setResultLatch] = useState(false);
  // run 时在场的 assistant 消息 id——本回合回复 = 首个不在场内的 assistant 消息。
  // 用 id 而非下标：discard/retry 删过消息后重试，新回合拿到的也是全新 id
  const knownIdsRef = useRef<ReadonlySet<string>>(new Set());
  // 回调经 ref 间接调用，保证 run/retry 闭包永远拿到宿主最新实现
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const reset = useCallback(() => {
    setRequest(null);
    setResultLatch(false);
    knownIdsRef.current = new Set();
  }, []);

  const run = useCallback((next: SelectionRunRequest) => {
    knownIdsRef.current = new Set(
      (session?.messages ?? [])
        .filter((m) => m.role === 'assistant')
        .map((m) => m.id),
    );
    setResultLatch(false);
    setRequest(next);
    onSubmitRef.current(next);
  }, [session]);

  const keep = useCallback(() => {
    reset();
  }, [reset]);

  const discard = useCallback(() => {
    if (request) onCancelRef.current?.(request);
    reset();
  }, [request, reset]);

  const retry = useCallback(() => {
    if (!request) return;
    const current = request;
    onCancelRef.current?.(current);
    // run 会以当前 session 重建在场 id 集——若宿主在 onCancel 里同步删了
    // 本回合消息，新回合 append 后的 id 依然不在旧集内，派生不受影响
    run(current);
  }, [request, run]);

  const dismiss = useCallback(() => {
    reset();
  }, [reset]);

  // ── phase 派生（渲染期计算，无 effect 时序问题）──────────────
  const messages = session?.messages;
  const reply = request ? findTurnReply(messages ?? [], knownIdsRef.current) : undefined;
  const toolsPending = (messages ?? []).some((m) => m.role === 'tool' && !m.toolResult);
  const settled =
    !!reply &&
    !reply.isStreaming &&
    !toolsPending &&
    (session?.status === 'idle' || session?.status === 'error');

  let phase: SelectionPhase = 'idle';
  if (request) {
    if (resultLatch) {
      phase = 'result';
    } else if (settled) {
      phase = 'result';
    } else if (reply && (reply.content.trim().length > 0 || !!reply.thinking)) {
      phase = 'streaming';
    } else {
      phase = 'thinking';
    }
  }

  // result 锁存：一旦落定，即使用户随后手动发起新回合（status 离开 idle、
  // 尾部出现新的流式消息）也保持 result，直到 keep/discard/retry/dismiss
  useEffect(() => {
    if (phase === 'result') setResultLatch(true);
  }, [phase]);

  const streamText =
    request && (phase === 'streaming' || phase === 'result') ? (reply?.content ?? '') : '';

  return { phase, request, streamText, run, keep, discard, retry, dismiss };
}
