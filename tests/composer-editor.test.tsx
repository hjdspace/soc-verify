// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { createElement } from 'react';
import {
  ComposerEditor,
  collectEditorText,
  caretTextIndex,
  findTriggerRange,
  createChipElement,
  chipsFromDom,
  chipIdentity,
  type ComposerEditorApi,
  type ChipData,
} from '@renderer/components/layout/ComposerEditor';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function buildRoot(innerHtml: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = innerHtml;
  document.body.appendChild(div);
  return div;
}

function setCaret(container: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(container, offset);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

beforeEach(() => {
  document.body.innerHTML = '';
  const sel = window.getSelection();
  sel?.removeAllRanges();
});

// ── 纯 DOM 工具函数 ─────────────────────────────────────────────

describe('collectEditorText', () => {
  it('剔除 chip 文本与 ZWSP，<br> 映射为换行', () => {
    const chip = createChipElement({ kind: 'file', label: 'main.ts', path: '/x/main.ts', fileType: 'file' });
    const root = buildRoot('');
    root.append('帮我检查 ');
    root.appendChild(chip);
    root.appendChild(document.createTextNode('\u200B'));
    const br = document.createElement('br');
    root.appendChild(br);
    root.append('模块');

    const info = collectEditorText(root);
    expect(info.text).toBe('帮我检查 \n模块');
    expect(info.pos).toHaveLength(info.text.length);
  });

  it('纯文本内容原样保留', () => {
    const root = buildRoot('hello world');
    expect(collectEditorText(root).text).toBe('hello world');
  });
});

describe('caretTextIndex', () => {
  it('返回光标前的字符数', () => {
    const root = buildRoot('hello');
    const textNode = root.firstChild as Text;
    setCaret(textNode, 3);
    const info = collectEditorText(root);
    expect(caretTextIndex(root, info)).toBe(3);
  });

  it('chip 后的光标索引不计 chip 文本', () => {
    const root = buildRoot('ab');
    const chip = createChipElement({ kind: 'skill', label: 'S', name: 'S' });
    const zwsp = document.createTextNode('\u200B');
    root.insertBefore(chip, root.lastChild);
    root.insertBefore(zwsp, root.lastChild);
    // 光标放在 ZWSP 后（chip 之后、"ab" 之前）→ 无字符在光标前
    setCaret(zwsp, 1);
    const info = collectEditorText(root);
    expect(info.text).toBe('ab');
    expect(caretTextIndex(root, info)).toBe(0);
  });

  it('无选区时返回 -1', () => {
    const root = buildRoot('hello');
    expect(caretTextIndex(root, collectEditorText(root))).toBe(-1);
  });
});

describe('findTriggerRange', () => {
  it('定位光标前的 @ 触发文本并可用 deleteContents 删除', () => {
    const root = buildRoot('看看 @src/mai n');
    // 光标放在 "mai" 之后（"看看 @src/mai" 共 11 个字符）
    const textNode = root.firstChild as Text;
    setCaret(textNode, '看看 @src/mai'.length);
    const info = collectEditorText(root);
    const trigger = findTriggerRange(root, info, /@\S*$/);
    expect(trigger?.match).toBe('@src/mai');
    trigger?.range.deleteContents();
    expect(collectEditorText(root).text).toBe('看看  n');
  });

  it('触发文本不匹配时返回 null', () => {
    const root = buildRoot('hello world');
    const textNode = root.firstChild as Text;
    setCaret(textNode, 11);
    const info = collectEditorText(root);
    expect(findTriggerRange(root, info, /@\S*$/)).toBeNull();
  });
});

describe('createChipElement / chipsFromDom', () => {
  it('chip 携带完整元数据且可从 DOM 还原', () => {
    const chip: ChipData = { kind: 'file', label: 'src/', path: '/p/src', fileType: 'directory' };
    const el = createChipElement(chip);
    const root = buildRoot('');
    root.appendChild(el);
    root.appendChild(document.createTextNode('\u200B'));

    const restored = chipsFromDom(root);
    expect(restored).toEqual([chip]);
    expect(el.getAttribute('contenteditable')).toBe('false');
    // 高度与文本行高一致（h-4 = leading-4 = 16px）
    expect(el.className).toContain('h-4');
    expect(el.querySelector('[data-chip-remove]')).toBeTruthy();
  });

  it('chipIdentity 按类型区分标识', () => {
    expect(chipIdentity({ kind: 'skill', label: 'a', name: 'a' })).toBe('skill:a');
    expect(chipIdentity({ kind: 'file', label: 'a', path: '/a' })).toBe('file:/a');
  });
});

// ── 组件行为 ────────────────────────────────────────────────────

function setupEditor(props: Partial<Parameters<typeof ComposerEditor>[0]> = {}) {
  const apiRef = { current: null } as { current: ComposerEditorApi | null };
  const onInput = vi.fn();
  const onChipsChange = vi.fn();
  const utils = render(
    createElement(ComposerEditor, {
      sessionId: 's-test',
      placeholder: '输入消息...',
      onInput,
      onChipsChange,
      apiRef,
      ...props,
    }),
  );
  const root = utils.container.querySelector('[contenteditable]') as HTMLElement;
  return { apiRef, onInput, onChipsChange, root, ...utils };
}

describe('ComposerEditor 组件', () => {
  it('输入文本时回调 onInput(纯文本, 光标前文本)', () => {
    const { root, onInput } = setupEditor();
    root.textContent = 'hello';
    fireEvent.input(root);
    expect(onInput).toHaveBeenCalledWith('hello', expect.any(String));
  });

  it('外部注入文本时同步到非受控编辑器', () => {
    const { root, rerender } = setupEditor({ externalText: '' });
    rerender(
      createElement(ComposerEditor, {
        sessionId: 's-test',
        placeholder: '输入消息...',
        externalText: '请精简下面引用的内容',
      }),
    );
    expect(collectEditorText(root).text).toBe('请精简下面引用的内容');
  });

  it('insertChip 删除触发文本并在原位置插入行内 chip', () => {
    const { apiRef, root, onInput, onChipsChange } = setupEditor();
    root.textContent = '帮我 @src';
    const textNode = root.firstChild as Text;
    setCaret(textNode, '帮我 @src'.length);

    act(() => {
      apiRef.current?.insertChip(
        { kind: 'file', label: 'main.ts', path: '/x/main.ts', fileType: 'file' },
        /@\S*$/,
      );
    });

    // 触发文本被删除，chip 不计入纯文本
    expect(collectEditorText(root).text).toBe('帮我 ');
    const chipEl = root.querySelector('[data-chip]');
    expect(chipEl).toBeTruthy();
    expect(chipEl?.getAttribute('data-identity')).toBe('file:/x/main.ts');
    // chip 位于文本之后（行内混排）
    expect(root.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(chipEl?.previousSibling?.textContent).toBe('帮我 ');
    expect(onChipsChange).toHaveBeenCalledWith([
      { kind: 'file', label: 'main.ts', name: undefined, path: '/x/main.ts', fileType: 'file' },
    ]);
    expect(onInput).toHaveBeenCalledWith('帮我 ', '帮我 ');
  });

  it('同标识 chip 重复插入时只删除触发文本', () => {
    const { apiRef, root } = setupEditor();
    root.textContent = 'a /sk';
    const textNode = root.firstChild as Text;
    setCaret(textNode, 'a /sk'.length);
    act(() => {
      apiRef.current?.insertChip({ kind: 'skill', label: 'sk', name: 'sk' }, /\/\S*$/);
    });
    expect(root.querySelectorAll('[data-chip]')).toHaveLength(1);
    root.appendChild(document.createTextNode(' /sk'));
    setCaret(root.lastChild as Text, 4);
    act(() => {
      apiRef.current?.insertChip({ kind: 'skill', label: 'sk', name: 'sk' }, /\/\S*$/);
    });
    expect(root.querySelectorAll('[data-chip]')).toHaveLength(1);
    expect(collectEditorText(root).text).toBe('a  ');
  });

  it('点击 X 删除 chip 并回调 onChipsChange', () => {
    const { apiRef, root, onChipsChange } = setupEditor();
    act(() => {
      apiRef.current?.restore('s-test', '文本', [
        { kind: 'skill', label: 'sk', name: 'sk' },
      ]);
    });
    expect(root.querySelector('[data-chip]')).toBeTruthy();
    const removeBtn = root.querySelector('[data-chip-remove]') as HTMLElement;
    fireEvent.click(removeBtn);
    expect(root.querySelector('[data-chip]')).toBeNull();
    expect(onChipsChange).toHaveBeenLastCalledWith([]);
  });

  it('clear 清空编辑器并通知空输入', () => {
    const { apiRef, root, onInput } = setupEditor();
    act(() => {
      apiRef.current?.restore('s-test', '残留', []);
    });
    act(() => {
      apiRef.current?.clear();
    });
    expect(collectEditorText(root).text).toBe('');
    expect(onInput).toHaveBeenLastCalledWith('', '');
  });

  it('restore 无快照时用 fallback 文本与 chips 重建', () => {
    const { apiRef, root, onInput } = setupEditor();
    act(() => {
      apiRef.current?.restore('fresh-session', '第一行\n第二行', [
        { kind: 'file', label: 'a.ts', path: '/a.ts', fileType: 'file' },
      ]);
    });
    const info = collectEditorText(root);
    expect(info.text).toBe('第一行\n第二行');
    expect(root.querySelectorAll('[data-chip]')).toHaveLength(1);
    expect(onInput).toHaveBeenLastCalledWith('第一行\n第二行', '');
    expect(root.querySelectorAll('br')).toHaveLength(1);
  });

  it('restore 优先使用快照，保留 chip 行内位置', () => {
    const { apiRef, root } = setupEditor();
    root.textContent = '前 @f';
    setCaret(root.firstChild as Text, '前 @f'.length);
    act(() => {
      apiRef.current?.insertChip({ kind: 'file', label: 'f', path: '/f', fileType: 'file' }, /@\S*$/);
    });
    // 快照已保存；restore 同一会话时以快照为准（fallback 参数被忽略）
    act(() => {
      apiRef.current?.restore('s-test', 'whatever', []);
    });
    expect(collectEditorText(root).text).toBe('前 ');
    expect(root.querySelectorAll('[data-chip]')).toHaveLength(1);
  });

  it('Enter 与其他按键透传给父级处理', () => {
    const onKeyDown = vi.fn();
    const { root } = setupEditor({ onKeyDown });
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(root, { key: 'ArrowUp' });
    expect(onKeyDown).toHaveBeenCalledTimes(2);
  });

  it('Shift+Enter 插入换行', () => {
    const { apiRef, root, onInput } = setupEditor();
    root.textContent = 'a';
    setCaret(root.firstChild as Text, 1);
    fireEvent.keyDown(root, { key: 'Enter', shiftKey: true });
    expect(collectEditorText(root).text).toBe('a\n');
    expect(onInput).toHaveBeenCalled();
    void apiRef;
  });

  it('IME 组合期间 input 事件不触发 sync，compositionEnd 后统一 sync', () => {
    const { root, onInput } = setupEditor();
    root.textContent = '中文';
    fireEvent.compositionStart(root);
    fireEvent.input(root);
    expect(onInput).not.toHaveBeenCalled();
    fireEvent.compositionEnd(root);
    expect(onInput).toHaveBeenCalled();
  });
});
