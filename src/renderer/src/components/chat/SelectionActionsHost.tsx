import { useEffect, useRef, useState, type ReactNode } from 'react';
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
 * 带引用上下文的消息走现有 session 发送链路（sendMessage）。
 *
 * 动作分两类（issue #2/#3 行为优化）：
 * - 查阅型（explain/translate/prompt）：创建临时会话发送，不写入当前会话，
 *   不打断当前工作流。回复落定后自动 dismiss，临时会话保留在 tab 列表
 *   供后续查看。
 * - 改写型（improve/shorten/expand）：写入当前会话，保持 Keep/Discard/Retry
 *   回合管理。Discard/Retry 经 removeMessagesFrom 移除本回合新增消息、
 *   恢复提交前的会话状态。
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

/** 查阅型动作：在临时会话中发送，回复落定后自动 dismiss，不显示 Keep/Discard/Retry */
const TRANSIENT_ACTIONS = new Set(['explain', 'translate', 'prompt']);

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

/** 生成临时会话名称（基于动作标签） */
function transientSessionName(label: string): string {
  return `[查阅] ${label}`;
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

  // ── 查阅型动作的临时会话 ───────────────────────────────────
  // 查阅型动作（explain/translate/prompt）在独立临时会话中发送，
  // 不写入当前会话、不打断当前工作流。临时会话加入 sessions[] 但
  // 不切换 currentSessionId——当前 tab 保持不变。
  //
  // transientTick：useState 触发重渲染的开关；ref 在闭包中实时可取。
  // selector 在 transientSessionId 为 null 时返回 undefined（不订阅
  // sessions 变化），只在查阅型动作期间订阅临时会话的消息流更新。
  const transientSessionIdRef = useRef<string | null>(null);
  const [transientTick, setTransientTick] = useState(0);
  const transientSessionId = transientSessionIdRef.current;
  const transientSession = useSessionCoreStore((s) => {
    // 当 tick=0（无查阅型动作）时直接返回 undefined，不触发 find
    if (transientTick === 0 || !transientSessionId) return undefined;
    return s.sessions.find((e) => e.id === transientSessionId);
  });

  // useSelectionRun 的 session prop：查阅型动作期间指向临时会话，
  // 否则指向当前会话（改写型动作）
  const runSession = transientSession ?? activeSession;

  // 待执行的 run 请求——查阅型动作需要先创建临时会话再 run，
  // 在 transientSession 出现后经 useEffect 触发
  const pendingRunRef = useRef<SelectionRunRequest | null>(null);

  const sendMessage = useSessionMessagesStore((s) => s.sendMessage);
  const removeMessagesFrom = useSessionMessagesStore((s) => s.removeMessagesFrom);
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const removeRef = useRef(removeMessagesFrom);
  removeRef.current = removeMessagesFrom;

  const run = useSelectionRun({
    session: runSession,
    onSubmit: (request) => {
      // 查阅型动作发送到临时会话；改写型发送到当前会话
      // 从 live store + ref 取目标会话，避免渲染闭包过期
      const isTransient = TRANSIENT_ACTIONS.has(request.action);
      const targetId = isTransient
        ? transientSessionIdRef.current
        : activeSession?.id;
      if (!targetId) return;
      const live = useSessionCoreStore
        .getState()
        .sessions.find((s) => s.id === targetId);
      if (!live) return;
      baselineRef.current = live.messages.length;
      const quote = selectionRef.current?.text ?? '';
      void sendMessageRef.current(
        buildQuotedMessage(request, quote, source),
        undefined,
        targetId,
      );
    },
    onCancel: () => {
      // 查阅型动作截断临时会话；改写型截断当前会话
      const sessionId = runSession?.id;
      if (sessionId && baselineRef.current !== null) {
        removeRef.current(sessionId, baselineRef.current);
        baselineRef.current = null;
      }
    },
  });

  // transientSession 出现后，如果有 pending run 请求，执行它
  //（查阅型动作需要先创建临时会话，等 store 更新后才能 run）
  useEffect(() => {
    if (transientSession && pendingRunRef.current) {
      const pending = pendingRunRef.current;
      pendingRunRef.current = null;
      run.run(pending);
    }
  }, [transientSession, run]);

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

  // input 聚焦态保活：用户点击浮条 input 后浏览器折叠文档选区，
  // selectionchange → selection 变 null——但 input 仍聚焦，浮条不应消失。
  // 跟踪 input 聚焦/失焦状态，与 selection/run.request 联合判定 visible
  const [inputFocused, setInputFocused] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const onFocusIn = () => {
      const active = document.activeElement;
      if (active && active.closest('[data-testid="selection-bar"]')) {
        setInputFocused(true);
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      // relatedTarget 是下一个聚焦元素；如果不在浮条内则失焦
      const next = e.relatedTarget as Element | null;
      if (!next || !next.closest('[data-testid="selection-bar"]')) {
        setInputFocused(false);
      }
    };
    host.addEventListener('focusin', onFocusIn);
    host.addEventListener('focusout', onFocusOut);
    return () => {
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('focusout', onFocusOut);
    };
  }, []);
  const visible = barAnchor !== null && (run.request !== null || selection !== null || inputFocused);

  const actionLabel = (key: string) => SELECTION_ACTIONS.find((a) => a.key === key)?.label ?? key;

  // ── 动作分流入口 ───────────────────────────────────────────
  // 查阅型动作：创建临时会话（不切换 tab）→ 等 store 更新后 run
  // 改写型动作：直接 run（写入当前会话）
  const handleAction = (key: string, label: string, prompt: string | null) => {
    const request: SelectionRunRequest = { action: key, label, prompt };
    if (TRANSIENT_ACTIONS.has(key) && activeSession) {
      // 查阅型：创建临时会话（不切换 currentSessionId）
      const sessionId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const transientEntry: SessionEntry = {
        id: sessionId,
        projectId: activeSession.projectId,
        cwd: activeSession.cwd,
        name: transientSessionName(label),
        status: 'idle',
        messages: [],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: Date.now(),
        model: activeSession.model,
        approvalMode: activeSession.approvalMode,
        thinkingLevel: activeSession.thinkingLevel,
        transient: true,
      };
      // 预置空会话，sendMessage 调用时会 append user+assistant 消息
      useSessionCoreStore.setState((s) => ({
        sessions: [...s.sessions, transientEntry],
        // 不改 currentSessionId——当前 tab 保持不变
      }));
      transientSessionIdRef.current = sessionId;
      setTransientTick((v) => v + 1);
      pendingRunRef.current = request;
    } else {
      // 改写型：直接 run
      run.run(request);
    }
  };

  // 查阅型动作回复落定后在结果浮窗展示（不自动 dismiss），
  // 用户看完后手动关闭浮窗 → dismiss → 清理临时会话引用

  // run.request 变 null（dismiss/keep/discard 后）时清理临时会话引用 +
  // 从 sessions 列表中移除瞬态会话（不留 tab）
  useEffect(() => {
    if (run.request === null && transientSessionIdRef.current) {
      const tid = transientSessionIdRef.current;
      transientSessionIdRef.current = null;
      setTransientTick((v) => v + 1);
      // 从 sessions 中移除瞬态会话（后台完成，不留 tab）
      useSessionCoreStore.setState((s) => ({
        sessions: s.sessions.filter((sess) => sess.id !== tid),
      }));
    }
  }, [run.request]);

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
        onSelectAction={(key) => handleAction(key, actionLabel(key), null)}
        onSubmitPrompt={(prompt) => handleAction('prompt', prompt, prompt)}
        onKeep={run.keep}
        onDiscard={run.discard}
        onRetry={run.retry}
        onDismiss={run.dismiss}
      />
    </div>
  );
}
