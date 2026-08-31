import {
  useCallback,
  useEffect,
  useRef,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileText, Folder, Sparkles, X } from 'lucide-react';

/**
 * ComposerEditor —— 行内 chip 输入编辑器
 *
 * contentEditable 实现（非受控）：技能(/)与上下文(@)以原子 chip 的形式
 * 嵌入文本流中光标所在位置，chip 高度与文本行高一致(h-4 = leading-4)。
 *
 * 关键设计：
 * - React 不渲染 children，编辑器内容由命令式 DOM 操作维护
 * - 中文 IME：composition 期间不 sync，compositionend 后统一 sync
 * - 光标兜底：编辑器失焦（例如用鼠标点下拉列表）时使用最近一次光标位置
 * - 会话切换：innerHTML 快照保存在模块级 Map 中，恢复 chip 的行内位置
 */

/** 零宽空格：chip 后的光标锚点，文本提取时会被剔除 */
const ZWSP = '\u200B';

export type ChipKind = 'skill' | 'file';

export type ChipData = {
  kind: ChipKind;
  label: string;
  /** 技能名（kind=skill 时作为去重标识） */
  name?: string;
  /** 文件路径（kind=file 时作为去重标识） */
  path?: string;
  fileType?: 'file' | 'directory';
};

export type ComposerEditorApi = {
  /** 删除光标前匹配 removePattern 的触发文本（如 "@src"），并在该位置插入 chip */
  insertChip: (chip: ChipData, removePattern: RegExp) => void;
  /** 清空编辑器并通知 onInput('', '') */
  clear: () => void;
  focus: () => void;
  /** 恢复会话内容：优先用快照，否则用 fallback 文本 + chips（追加在文本后）重建 */
  restore: (sessionId: string, fallbackText: string, fallbackChips: ChipData[]) => void;
};

type Props = {
  sessionId: string;
  /** 外部动作注入的纯文本；与 contentEditable 当前文本相同则不重建 DOM。 */
  externalText?: string;
  placeholder: string;
  disabled?: boolean;
  className?: string;
  /** 每次内容变化（含命令式修改）后回调：纯文本 + 光标前文本（均已剔除 chip/ZWSP） */
  onInput?: (text: string, textBeforeCaret: string) => void;
  /** chip 集合变化（插入/删除/X 点击/Backspace）后回调当前 DOM 中的全部 chip */
  onChipsChange?: (chips: ChipData[]) => void;
  /** Enter 已被编辑器 preventDefault，父级只需处理发送；Shift+Enter 由编辑器内部换行 */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  /** 父级先处理（如图片粘贴）；未 preventDefault 时编辑器降级为纯文本粘贴 */
  onPaste?: (e: ReactClipboardEvent<HTMLDivElement>) => void;
  apiRef?: RefObject<ComposerEditorApi | null>;
};

// ── DOM 文本模型 ────────────────────────────────────────────────

/** 单个可见字符在 DOM 中的位置：文本节点内为 (textNode, offset)，<br> 为 (parent, childIndex) */
export type CharPos = { container: Node; offset: number };
export type EditorTextInfo = { text: string; pos: CharPos[] };

/**
 * 提取编辑器纯文本模型：跳过 chip 子树、剔除 ZWSP、<br> 映射为 \n。
 * pos[i] 与 text[i] 一一对应，供触发文本定位/删除使用。
 */
export function collectEditorText(root: HTMLElement): EditorTextInfo {
  const chars: string[] = [];
  const pos: CharPos[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue ?? '';
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === ZWSP) continue;
        chars.push(raw[i]);
        pos.push({ container: node, offset: i });
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.hasAttribute('data-chip')) return; // chip 是原子，不参与文本
    if (el.tagName === 'BR') {
      chars.push('\n');
      const parent = el.parentNode;
      if (parent) {
        pos.push({ container: parent, offset: Array.prototype.indexOf.call(parent.childNodes, el) });
      }
      return;
    }
    Array.from(el.childNodes).forEach(walk);
  };
  Array.from(root.childNodes).forEach(walk);
  return { text: chars.join(''), pos };
}

/** 计算光标在纯文本中的索引；无有效选区返回 -1。可显式传入范围用于失焦场景。 */
export function caretTextIndex(root: HTMLElement, info: EditorTextInfo, selRange?: Range): number {
  let caret: Range | null = selRange ?? null;
  if (!caret) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return -1;
    caret = sel.getRangeAt(0);
  }
  if (!caret.collapsed) return -1;
  if (!root.contains(caret.startContainer)) return -1;
  let count = 0;
  for (const p of info.pos) {
    // pos 按文档序排列，首个落在光标之后的字符即可终止
    const r = document.createRange();
    try {
      r.setStart(p.container, p.offset);
      r.setEnd(p.container, p.offset + 1);
    } catch {
      return count;
    }
    // START_TO_END = this.end vs source.start：字符整体位于光标前才算数
    if (r.compareBoundaryPoints(Range.START_TO_END, caret) <= 0) count++;
    else break;
  }
  return count;
}

/**
 * 在光标前查找触发文本（pattern 需锚定结尾，如 /@\\S*$/），
 * 返回覆盖该文本的 Range（可安全 deleteContents），未命中返回 null。
 */
export function findTriggerRange(
  root: HTMLElement,
  info: EditorTextInfo,
  pattern: RegExp,
  selRange?: Range,
): { range: Range; match: string } | null {
  const caret = caretTextIndex(root, info, selRange);
  if (caret < 0) return null;
  const before = info.text.slice(0, caret);
  const m = before.match(pattern);
  if (!m || m.index === undefined || m[0].length === 0) return null;
  const startIdx = m.index;
  const endIdx = m.index + m[0].length;
  const startPos = info.pos[startIdx];
  const lastPos = info.pos[endIdx - 1];
  if (!startPos || !lastPos) return null;
  const range = document.createRange();
  try {
    range.setStart(startPos.container, startPos.offset);
    range.setEnd(lastPos.container, lastPos.offset + 1);
  } catch {
    return null;
  }
  // 防御：触发文本不应跨越 chip；一旦跨过（异常 DOM）放弃删除
  if (range.cloneContents().querySelector('[data-chip]')) return null;
  return { range, match: m[0] };
}

// ── Chip DOM ───────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function chipIdentity(chip: ChipData): string {
  return chip.kind === 'skill' ? `skill:${chip.name ?? chip.label}` : `file:${chip.path ?? chip.label}`;
}

const iconMarkup = {
  skill: renderToStaticMarkup(<Sparkles className="h-2.5 w-2.5 shrink-0" />),
  file: renderToStaticMarkup(<FileText className="h-2.5 w-2.5 shrink-0" />),
  directory: renderToStaticMarkup(<Folder className="h-2.5 w-2.5 shrink-0" />),
  close: renderToStaticMarkup(<X className="h-2.5 w-2.5" />),
};

// 高度与文本行高一致：h-4 = leading-4 = 16px
const CHIP_BASE_CLASS =
  'mx-px inline-flex h-4 max-w-[220px] items-center gap-0.5 rounded-sm px-1 align-middle';

/** 创建原子 chip 节点（contenteditable=false，含删除按钮） */
export function createChipElement(chip: ChipData): HTMLSpanElement {
  const el = document.createElement('span');
  el.setAttribute('data-chip', chip.kind);
  el.setAttribute('data-identity', chipIdentity(chip));
  el.setAttribute('data-label', chip.label);
  if (chip.name) el.setAttribute('data-name', chip.name);
  if (chip.path) el.setAttribute('data-path', chip.path);
  if (chip.fileType) el.setAttribute('data-file-type', chip.fileType);
  el.setAttribute('contenteditable', 'false');
  el.className =
    chip.kind === 'skill'
      ? `${CHIP_BASE_CLASS} bg-primary/15 text-primary`
      : `${CHIP_BASE_CLASS} bg-accent text-foreground`;
  const icon =
    chip.kind === 'skill' ? iconMarkup.skill : chip.fileType === 'directory' ? iconMarkup.directory : iconMarkup.file;
  el.innerHTML =
    `${icon}` +
    `<span class="max-w-[140px] truncate text-[10px] font-medium leading-none">${escapeHtml(chip.label)}</span>` +
    `<button type="button" tabindex="-1" data-chip-remove class="shrink-0 rounded-sm hover:bg-foreground/10">${iconMarkup.close}</button>`;
  return el;
}

/** 读取编辑器中当前全部 chip（按 DOM 顺序） */
export function chipsFromDom(root: HTMLElement): ChipData[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-chip]')).map((el) => ({
    kind: (el.getAttribute('data-chip') === 'skill' ? 'skill' : 'file') as ChipKind,
    label: el.getAttribute('data-label') ?? '',
    name: el.getAttribute('data-name') ?? undefined,
    path: el.getAttribute('data-path') ?? undefined,
    fileType: (el.getAttribute('data-file-type') as 'file' | 'directory' | null) ?? undefined,
  }));
}

/** 会话 → 编辑器 innerHTML 快照（内存级），跨会话切换保留 chip 行内位置 */
const editorSnapshots = new Map<string, string>();

type CaretPoint = { container: Node; offset: number };

function placeCaret(where: CaretPoint): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  try {
    range.setStart(where.container, where.offset);
  } catch {
    return;
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ── 组件 ───────────────────────────────────────────────────────

export function ComposerEditor({
  sessionId,
  externalText,
  placeholder,
  disabled = false,
  className,
  onInput,
  onChipsChange,
  onKeyDown,
  onPaste,
  apiRef,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  // 回调经 ref 转发，保证命令式 API 不会捕获过期闭包
  const propsRef = useRef({ onInput, onChipsChange, onKeyDown, onPaste, sessionId });
  propsRef.current = { onInput, onChipsChange, onKeyDown, onPaste, sessionId };
  const composingRef = useRef(false);
  const lastCaretRef = useRef<Range | null>(null);
  const lastChipsRef = useRef<string>('');

  const sync = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    // 清理"仅剩 <br>/ZWSP"的伪空内容，保证 :empty 占位符生效
    if (!root.querySelector('[data-chip]')) {
      const info0 = collectEditorText(root);
      if (info0.text === '' || info0.text === '\n') {
        root.innerHTML = '';
        placeCaret({ container: root, offset: 0 });
      }
    }
    const info = collectEditorText(root);
    const caret = caretTextIndex(root, info);
    if (caret >= 0) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) lastCaretRef.current = sel.getRangeAt(0).cloneRange();
    }
    const sid = propsRef.current.sessionId;
    if (sid) editorSnapshots.set(sid, root.innerHTML);
    const chips = chipsFromDom(root);
    const serialized = chips.map(chipIdentity).join('\u0001');
    if (serialized !== lastChipsRef.current) {
      lastChipsRef.current = serialized;
      propsRef.current.onChipsChange?.(chips);
    }
    const before = caret >= 0 ? info.text.slice(0, caret) : '';
    propsRef.current.onInput?.(info.text, before);
  }, []);

  /** 取当前有效插入锚点：选区 → 最近光标 → 内容末尾 */
  const resolveAnchor = useCallback((root: HTMLElement): Range => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).startContainer)) {
      return sel.getRangeAt(0).cloneRange();
    }
    const last = lastCaretRef.current;
    if (last && root.contains(last.startContainer)) return last.cloneRange();
    const end = document.createRange();
    end.selectNodeContents(root);
    end.collapse(false);
    return end;
  }, []);

  const insertChip = useCallback(
    (chip: ChipData, removePattern: RegExp) => {
      const root = rootRef.current;
      if (!root) return;
      // 失焦场景（鼠标点下拉项）依赖 Range 的活性：先克隆锚点，删除触发文本后锚点自动收敛到删除点
      const anchor = resolveAnchor(root);
      const anchorRange = anchor.cloneRange();
      root.focus();
      const info = collectEditorText(root);
      const trigger = findTriggerRange(root, info, removePattern, anchorRange);
      if (trigger) trigger.range.deleteContents();
      const identity = chipIdentity(chip);
      const exists = Array.from(root.querySelectorAll<HTMLElement>('[data-chip]')).some(
        (el) => el.getAttribute('data-identity') === identity,
      );
      if (!exists) {
        const chipEl = createChipElement(chip);
        anchor.insertNode(chipEl);
        const zwsp = document.createTextNode(ZWSP);
        chipEl.after(zwsp);
        placeCaret({ container: zwsp, offset: 1 });
        if (typeof chipEl.scrollIntoView === 'function') chipEl.scrollIntoView({ block: 'nearest' });
      } else {
        // 已有同标识 chip：仅删除触发文本，光标落在删除点
        placeCaret({ container: anchor.startContainer, offset: anchor.startOffset });
      }
      sync();
    },
    [resolveAnchor, sync],
  );

  const clear = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    root.innerHTML = '';
    const sid = propsRef.current.sessionId;
    if (sid) editorSnapshots.set(sid, '');
    lastChipsRef.current = '';
    propsRef.current.onInput?.('', '');
  }, []);

  const focus = useCallback(() => {
    rootRef.current?.focus();
  }, []);

  const restore = useCallback((sid: string, fallbackText: string, fallbackChips: ChipData[]) => {
    const root = rootRef.current;
    if (!root) return;
    const snap = editorSnapshots.get(sid);
    if (snap !== undefined) {
      root.innerHTML = snap;
    } else {
      root.innerHTML = '';
      const lines = fallbackText.split('\n');
      lines.forEach((line, i) => {
        if (i > 0) root.appendChild(document.createElement('br'));
        if (line) root.appendChild(document.createTextNode(line));
      });
      const identities = new Set(
        Array.from(root.querySelectorAll<HTMLElement>('[data-chip]')).map((el) => el.getAttribute('data-identity')),
      );
      for (const chip of fallbackChips) {
        const id = chipIdentity(chip);
        if (identities.has(id)) continue;
        identities.add(id);
        root.appendChild(createChipElement(chip));
        root.appendChild(document.createTextNode(ZWSP));
      }
    }
    lastChipsRef.current = chipsFromDom(root).map(chipIdentity).join('\u0001');
    const currentSid = propsRef.current.sessionId;
    if (currentSid) editorSnapshots.set(currentSid, root.innerHTML);
    // 静默恢复：不重放光标前文本，避免切换会话时误开 @ 下拉
    const info = collectEditorText(root);
    propsRef.current.onInput?.(info.text, '');
  }, []);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { insertChip, clear, focus, restore };
  }, [apiRef, insertChip, clear, focus, restore]);

  // Selection actions 等外部动作会先写入 composer store。编辑器本身是
  // 非受控 contentEditable，因此只在 store 文本与 DOM 不一致时同步，
  // 避免普通键入时重建 DOM 导致光标跳动。
  useEffect(() => {
    if (externalText === undefined) return;
    const root = rootRef.current;
    if (!root || collectEditorText(root).text === externalText) return;
    root.innerHTML = '';
    externalText.split('\n').forEach((line, index) => {
      if (index > 0) root.appendChild(document.createElement('br'));
      if (line) root.appendChild(document.createTextNode(line));
    });
    lastChipsRef.current = '';
    const sid = propsRef.current.sessionId;
    if (sid) editorSnapshots.set(sid, root.innerHTML);
  }, [externalText]);

  // ── 事件处理 ──────────────────────────────────────────────

  const handleInputEvent = (e: FormEvent<HTMLDivElement>) => {
    if ((e.nativeEvent as InputEvent).isComposing || composingRef.current) return;
    sync();
  };

  const handleCompositionStart = () => {
    composingRef.current = true;
  };

  const handleCompositionEnd = () => {
    composingRef.current = false;
    sync();
  };

  const insertLineBreak = () => {
    const root = rootRef.current;
    if (!root) return;
    if (typeof document.execCommand === 'function') {
      document.execCommand('insertLineBreak');
    } else {
      // jsdom 等环境兜底
      const br = document.createElement('br');
      resolveAnchor(root).insertNode(br);
      placeCaret({ container: br.parentNode ?? root, offset: (br.parentNode?.childNodes.length ?? 1) - 1 });
    }
    sync();
  };

  const handleInternalKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || composingRef.current) return;
    if (e.key === 'Enter') {
      // 始终阻止默认，避免 contentEditable 产生 <div>
      e.preventDefault();
      if (e.shiftKey) insertLineBreak();
      else propsRef.current.onKeyDown?.(e);
      return;
    }
    propsRef.current.onKeyDown?.(e);
  };

  const handlePasteEvent = (e: ReactClipboardEvent<HTMLDivElement>) => {
    propsRef.current.onPaste?.(e);
    if (e.defaultPrevented) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    e.preventDefault();
    if (!text) return;
    const root = rootRef.current;
    if (!root) return;
    if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) {
      sync();
      return;
    }
    resolveAnchor(root).insertNode(document.createTextNode(text));
    sync();
  };

  // chip 整体原子化：阻止其内部获得光标/选区；删除按钮走 click 委托
  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-chip]')) e.preventDefault();
  };

  const handleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('[data-chip-remove]');
    if (!btn) return;
    btn.closest('[data-chip]')?.remove();
    rootRef.current?.focus();
    sync();
  };

  return (
    <div
      ref={rootRef}
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      aria-disabled={disabled}
      contentEditable={!disabled}
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onInput={handleInputEvent}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onKeyDown={handleInternalKeyDown}
      onPaste={handlePasteEvent}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      className={`${className ?? ''}${disabled ? ' cursor-not-allowed opacity-50' : ''}`}
    />
  );
}
