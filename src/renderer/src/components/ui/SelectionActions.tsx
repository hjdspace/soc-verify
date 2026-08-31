import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ArrowUp, Check, ChevronDown, Copy, Expand, Languages, MessageCircleQuestion, RotateCcw, Scissors, Sparkles, X } from 'lucide-react';
import { Shimmer } from '@renderer/components/ui/Shimmer';
import { MarkdownRenderer } from '@renderer/components/chat/MarkdownRenderer';
import type { SelectionAnchor } from '@renderer/hooks/use-selection-anchor';
import type { SelectionPhase, SelectionRunRequest } from '@renderer/hooks/use-selection-run';

/**
 * 划选 AI 操作条（issues #5）。
 *
 * 视觉/交互参考 beautiful-ui:
 * D:\AI\beautiful-ui\components\primitives\SelectionActions.tsx
 * （491 行；iconoir 图标 10 个全换 lucide；StreamText 以流式预览 +
 * 复用 ai-panel.css 的 .ap-stream-tail 模糊尾缘替代）
 *
 * 36px 胶囊包 28px 控件（4px 内缩，同心圆角）。全受控组件：锚点/可见性/
 * 状态机 phase 均由 props 驱动（宿主接 useSelectionAnchor +
 * useSelectionRun），UI 测试直接传 props 断言，不模拟真实划选。
 *
 * 与参考实现的偏差：
 * - 标签/占位符中文化，快捷动作面向「引用 AI 回复再问」场景
 * - streaming 阶段在条内预览实时回复文本（尾缘字符数 PREVIEW_TAIL_CHARS，
 *   当前 0 = 禁用尾缘），
 *   而非参考 demo 的选区文本原地替换——本项目回复走会话消息流
 * - busy 态末尾追加可动的关闭按钮：真实会话回合无法在条内取消，
 *   必须给用户脱离浮条的出口（回合照常进行）
 * - WAAPI 宽度过渡（320ms）在缺少 Element.animate 的环境（jsdom）
 *   直接跳到终态宽度
 */

/** 快捷动作定义：icon/label/条内展示归组件，指令文案归宿主 */
export type SelectionActionDef = {
  key: string;
  label: string;
  /** busy 阶段的进行时标签（渲染时追加省略号） */
  busyLabel: string;
  icon: ReactNode;
};

const iconProps = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** 查阅型动作 key 集合：这类动作在浮窗下展示结果，不走 Keep/Discard 回合 */
export const POPUP_ACTIONS = new Set(['explain', 'translate', 'prompt']);

/** 默认快捷动作：前两项常驻，后三项收进展开区（chevron 切换） */
export const SELECTION_ACTIONS: SelectionActionDef[] = [
  { key: 'explain', label: '解释', busyLabel: '解释中', icon: <MessageCircleQuestion {...iconProps} /> },
  { key: 'improve', label: '改进', busyLabel: '改进中', icon: <Sparkles {...iconProps} /> },
  { key: 'shorten', label: '精简', busyLabel: '精简中', icon: <Scissors {...iconProps} /> },
  { key: 'expand', label: '展开', busyLabel: '展开中', icon: <Expand {...iconProps} /> },
  { key: 'translate', label: '翻译', busyLabel: '翻译中', icon: <Languages {...iconProps} /> },
];

/** 流式预览的模糊尾缘字符数（与 MarkdownRenderer STREAM_TAIL_CHARS 对齐）；0 = 禁用尾缘 */
const PREVIEW_TAIL_CHARS = 0;

// 折叠/展开区的 max-width 常量：内容固定（5 个动作、中文双字标签），
// 与参考实现一致采用定值；调整动作集合或标签时需同步校对
const IDLE_PROMPT_W = 150;
const ACTIONS_W = 196;
const ACTIONS_EXPANDED_W = 408;
const SEND_W = 30;

/** 流式预览文本切分：settled 正文 + 尾缘模糊段（复用 .ap-stream-tail）。
 *  tail 切点必须用 text.length - N 计算：slice(-N) 在 N 为 0 时退化为
 *  slice(0) 返回整串文本，会把整条预览打上 blur */
export function splitStreamPreview(text: string): { settled: string; tail: string } {
  if (text.length <= PREVIEW_TAIL_CHARS) return { settled: '', tail: text };
  return {
    settled: text.slice(0, text.length - PREVIEW_TAIL_CHARS),
    tail: text.slice(text.length - PREVIEW_TAIL_CHARS),
  };
}

export function SelectionActions({
  actions,
  anchor,
  visible,
  phase,
  request,
  streamText = '',
  onSelectAction,
  onSubmitPrompt,
  onKeep,
  onDiscard,
  onRetry,
  onDismiss,
}: {
  actions: SelectionActionDef[];
  /** 浮条锚点（相对宿主容器，px）；null 时保持在最后位置仅隐藏 */
  anchor: SelectionAnchor | null;
  visible: boolean;
  phase: SelectionPhase;
  /** 当前动作（busy/result 阶段取 busyLabel；null 时回落「处理中」） */
  request: SelectionRunRequest | null;
  /** streaming 阶段的实时回复文本（条内逐字预览） */
  streamText?: string;
  onSelectAction: (key: string) => void;
  onSubmitPrompt: (prompt: string) => void;
  onKeep: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  // 查阅型动作（explain/translate/prompt）在浮窗下展示结果 Popover，
  // 不走 Keep/Discard 回合管理。busy 阶段在条内显示精简预览（同改写型），
  // streaming/result 阶段在浮条下方展开结果浮窗展示完整回复。
  const isPopupAction = request ? POPUP_ACTIONS.has(request.action) : false;
  const showResultPopover = visible && isPopupAction && (phase === 'streaming' || phase === 'result') && streamText.length > 0;
  const [prompt, setPrompt] = useState('');
  const [typingWidth, setTypingWidth] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  const barRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const previousPhaseRef = useRef<SelectionPhase>('idle');
  const lastWidthRef = useRef(0);
  const widthAnimationRef = useRef<Animation | null>(null);
  // 浮条边界 clamp 偏移：当选区靠近容器边缘时，浮条不超出宿主范围。
  // translateX(-50%) 居中后，左/右越界时追加偏移修正。jsdom 中宽度为 0
  // 不触发偏移，不影响测试断言。
  const [clampOffset, setClampOffset] = useState(0);

  const hasPrompt = prompt.trim().length > 0;
  const busy = phase === 'thinking' || phase === 'streaming';
  // busyLabel 按动作 key 从动作表取（自定义 prompt 无对应项，回落「处理中」）
  const busyLabel = actions.find((action) => action.key === request?.action)?.busyLabel ?? '处理中';

  // mousedown 默认行为会折叠文档选区——在条上拦截所有元素（含 input），
  // 保证点击浮条任何位置时引用文本仍处于选中态；input 点击后手动 focus
  // （preventDefault 阻止选区折叠，不影响 focus() 调用）
  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.target instanceof HTMLInputElement) {
      event.target.focus();
    }
  };

  const handlePromptInput = (next: string) => {
    // 从空到非空：锁定当前条宽（后续宽度变化交由 WAAPI 过渡），
    // 避免动作区塌缩时条宽跳变；清空则解除锁定
    if (!prompt.trim() && next.trim()) {
      setTypingWidth(Math.ceil(barRef.current?.getBoundingClientRect().width ?? 0) || null);
    } else if (!next.trim()) {
      setTypingWidth(null);
    }
    setPrompt(next);
  };

  const submitPrompt = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onSubmitPrompt(trimmed);
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setPrompt('');
      setTypingWidth(null);
    }
  };

  /* 内容切换（idle→thinking→streaming→result）时，把条从上一宽度
   * WAAPI 过渡到新内容的固有宽度，避免布局宽度跳变。 */
  useLayoutEffect(() => {
    const bar = barRef.current;
    const content = contentRef.current;
    if (!bar || !content) return;

    const nextWidth = Math.ceil(content.getBoundingClientRect().width) + 8;
    const previousWidth = lastWidthRef.current || Math.ceil(bar.getBoundingClientRect().width);

    if (
      previousPhaseRef.current !== phase &&
      Math.abs(nextWidth - previousWidth) > 1 &&
      typeof bar.animate === 'function'
    ) {
      widthAnimationRef.current?.cancel();
      const animation = bar.animate(
        [{ width: `${previousWidth}px` }, { width: `${nextWidth}px` }],
        // 与映射层 --ease-out-strong 同曲线（WAAPI 需字面量）
        { duration: 320, easing: 'cubic-bezier(0.23,1,0.32,1)' },
      );
      widthAnimationRef.current = animation;
      animation.onfinish = () => {
        lastWidthRef.current = nextWidth;
        widthAnimationRef.current = null;
      };
    } else {
      lastWidthRef.current = nextWidth;
    }

    previousPhaseRef.current = phase;
  }, [phase]);

  // 浮条宽度或锚点变化后重算 clamp 偏移（防止左右越界宿主容器）
  useLayoutEffect(() => {
    const bar = barRef.current;
    const layer = layerRef.current;
    if (!bar || !layer) return;
    const barWidth = bar.getBoundingClientRect().width;
    if (barWidth === 0) return;
    const host = layer.parentElement;
    if (!host) return;
    const hostWidth = host.getBoundingClientRect().width;
    if (hostWidth === 0) return;
    const ax = anchor?.x ?? 0;
    const halfWidth = barWidth / 2;
    const leftEdge = ax - halfWidth;
    const rightEdge = ax + halfWidth;
    let offset = 0;
    if (leftEdge < 0) offset = -leftEdge;
    else if (rightEdge > hostWidth) offset = hostWidth - rightEdge;
    setClampOffset((prev) => (Math.abs(prev - offset) < 0.5 ? prev : offset));
  }, [phase, streamText, anchor?.x, visible, expanded, prompt]);

  // 动画未运行期间的宽度漂移（如流式预览增长）同步进 lastWidth
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;
    const observer = new ResizeObserver(() => {
      if (widthAnimationRef.current?.playState === 'running') return;
      lastWidthRef.current = Math.ceil(content.getBoundingClientRect().width) + 8;
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      widthAnimationRef.current?.cancel();
    };
  }, []);

  const preview = splitStreamPreview(streamText);
  const widthLocked = phase === 'idle' && hasPrompt && typingWidth ? typingWidth : undefined;

  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    const text = streamText;
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      ref={layerRef}
      data-testid="selection-bar"
      className="ap-sel-layer"
      style={{
        transform: `translate3d(${anchor?.x ?? 0}px, ${anchor?.y ?? 0}px, 0) translateX(${clampOffset === 0 ? '-50%' : `calc(-50% + ${clampOffset}px)`})`,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
      }}
      onMouseDown={handleMouseDown}
    >
      <div
        ref={barRef}
        data-testid="selection-pill"
        className="ap-sel-pill"
        style={{
          width: widthLocked,
          ...(visible ? { animation: 'pop-in 220ms var(--ease-out-strong) both' } : {}),
        }}
      >
        <div ref={contentRef} className="ap-sel-row">
          {busy && (
            <span className="ap-sel-busy" data-testid="selection-busy">
              <span className="ap-sel-spinner" aria-hidden />
              {phase === 'thinking' ? (
                <Shimmer className="text-[12.5px]">{busyLabel}…</Shimmer>
              ) : streamText && !isPopupAction ? (
                <span className="ap-sel-preview" data-testid="selection-preview">
                  <span>{preview.settled}</span>
                  {preview.tail && <span className="ap-stream-tail">{preview.tail}</span>}
                </span>
              ) : (
                <span>{busyLabel}…</span>
              )}
              <button
                type="button"
                aria-label="关闭浮条"
                title="关闭浮条（回合照常进行）"
                data-testid="selection-dismiss"
                onClick={onDismiss}
                className="ap-sel-iconbtn"
              >
                <X {...iconProps} />
              </button>
            </span>
          )}

          {phase === 'result' && !isPopupAction && (
            <>
              <button type="button" data-testid="selection-keep" onClick={onKeep} className="ap-sel-primary">
                <Check {...iconProps} />
                保留
              </button>
              <button type="button" data-testid="selection-discard" onClick={onDiscard} className="ap-sel-control">
                <X {...iconProps} />
                放弃
              </button>
              <span className="ap-sel-divider" aria-hidden />
              <button
                type="button"
                aria-label={`重试${request?.label ?? ''}`}
                title={`重试${request?.label ?? ''}`}
                data-testid="selection-retry"
                onClick={onRetry}
                className="ap-sel-iconbtn"
              >
                <RotateCcw {...iconProps} />
              </button>
            </>
          )}

          {phase === 'result' && isPopupAction && (
            <span className="ap-sel-busy" data-testid="selection-busy">
              <Check {...iconProps} />
              {request?.label ?? '完成'}
              <button
                type="button"
                aria-label="关闭浮条"
                title="关闭浮条"
                data-testid="selection-dismiss"
                onClick={onDismiss}
                className="ap-sel-iconbtn"
              >
                <X {...iconProps} />
              </button>
            </span>
          )}

          {phase === 'idle' && (
            <>
              <div
                className="ap-sel-slot"
                style={{
                  maxWidth: expanded ? 0 : hasPrompt && typingWidth ? typingWidth - 40 : IDLE_PROMPT_W,
                  opacity: expanded ? 0 : 1,
                  transform: expanded ? 'translateX(-8px)' : 'translateX(0)',
                }}
              >
                <form
                  className="ap-sel-form"
                  style={{ width: hasPrompt && typingWidth ? typingWidth - 40 : IDLE_PROMPT_W }}
                  onSubmit={submitPrompt}
                >
                  <input
                    value={prompt}
                    onChange={(event) => handlePromptInput(event.target.value)}
                    onKeyDown={handleInputKeyDown}
                    aria-label="描述你要的操作"
                    placeholder="描述你要的操作…"
                    data-testid="selection-prompt"
                    className="ap-sel-input"
                  />
                </form>
              </div>

              <div
                className="ap-sel-slot"
                style={{
                  maxWidth: hasPrompt ? 0 : expanded ? ACTIONS_EXPANDED_W : ACTIONS_W,
                  opacity: hasPrompt ? 0 : 1,
                  transform: hasPrompt ? 'translateX(-8px)' : 'translateX(0)',
                }}
              >
                {!expanded && <span className="ap-sel-divider ap-sel-divider--strong" aria-hidden />}
                {actions.map((action, index) => {
                  // 前两项常驻，其余仅在展开区渲染（参考实现同款分层）
                  if (index >= 2 && !expanded) return null;
                  return (
                    <button
                      key={action.key}
                      type="button"
                      data-testid={`selection-action-${action.key}`}
                      onClick={() => onSelectAction(action.key)}
                      className="ap-sel-control"
                    >
                      {action.icon}
                      {action.label}
                    </button>
                  );
                })}
                <span className="ap-sel-divider" aria-hidden />
                <button
                  type="button"
                  aria-label={expanded ? '收起更多动作' : '展开更多动作'}
                  aria-expanded={expanded}
                  title={expanded ? '收起更多动作' : '展开更多动作'}
                  data-testid="selection-expand"
                  onClick={() => setExpanded((value) => !value)}
                  className="ap-sel-iconbtn"
                >
                  <span
                    className="flex transition-transform duration-300"
                    style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                  >
                    <ChevronDown {...iconProps} />
                  </span>
                </button>
              </div>

              <div
                className="ap-sel-slot ap-sel-slot--send"
                style={{
                  maxWidth: hasPrompt ? SEND_W : 0,
                  opacity: hasPrompt ? 1 : 0,
                  transform: hasPrompt ? 'scale(1)' : 'scale(0.88)',
                }}
              >
                <button
                  type="button"
                  aria-label="发送操作"
                  data-testid="selection-send"
                  onClick={() => submitPrompt()}
                  className="ap-sel-send"
                >
                  <ArrowUp size={16} strokeWidth={2.4} aria-hidden />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {showResultPopover && (
        <div
          data-testid="selection-result-popover"
          className="ap-sel-popover"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="ap-sel-popover-header">
            <span className="ap-sel-popover-title">
              {actions.find((a) => a.key === request?.action)?.icon}
              {request?.label ?? '结果'}
            </span>
            <button
              type="button"
              aria-label="关闭"
              data-testid="selection-popover-close"
              onClick={onDismiss}
              className="ap-sel-iconbtn"
            >
              <X {...iconProps} />
            </button>
          </div>
          <div className="ap-sel-popover-body" data-testid="selection-popover-body">
            <MarkdownRenderer content={streamText} streaming={phase === 'streaming'} />
          </div>
          <div className="ap-sel-popover-footer">
            {phase === 'streaming' && (
              <span className="ap-sel-popover-status">
                <span className="ap-sel-spinner" aria-hidden />
                回复中
              </span>
            )}
            <button
              type="button"
              aria-label="复制结果"
              data-testid="selection-popover-copy"
              onClick={handleCopy}
              className="ap-sel-control"
            >
              {copied ? <Check {...iconProps} /> : <Copy {...iconProps} />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
