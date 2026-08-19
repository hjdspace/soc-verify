import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { vim, getCM, type CodeMirror } from '@replit/codemirror-vim';

// ── Vim 模式类型 ──────────────────────────────────────────────

export type VimMode = 'normal' | 'insert' | 'visual' | 'command';

// ── Vim 模式监听 Extension ─────────────────────────────────────
//
// @replit/codemirror-vim 的 vim() extension 返回一个包含 CodeMirror 适配器的
// Extension。我们通过 EditorView.plugin 读取其内部状态来获取当前模式。
// 但由于该 API 不直接暴露 React state，我们使用 updateListener
// 的方式来轮询模式变化，然后通过回调通知外部。

let currentMode: VimMode = 'normal';
const modeChangeListeners = new Set<(mode: VimMode) => void>();

function detectMode(cm: CodeMirror | null): VimMode {
  if (!cm) return 'normal';
  const vimState = cm.state?.vim;
  if (!vimState) return 'normal';
  if (vimState.insertMode) return 'insert';
  if (vimState.visualMode) return 'visual';
  if (vimState.exMode) return 'command';
  return 'normal';
}

function notifyModeChange(mode: VimMode) {
  if (mode === currentMode) return;
  currentMode = mode;
  for (const listener of modeChangeListeners) {
    listener(mode);
  }
}

/**
 * 创建一个 CodeMirror extension 用于监听 Vim 模式变化。
 * 通过 updateListener 在每次视图更新时检查当前 Vim 模式。
 */
function vimModeListener(getView: () => EditorView | null): Extension {
  return EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.docChanged && !update.selectionSet && !update.focusChanged) return;
    const view = getView();
    if (!view) return;
    const cm = getCM(view);
    notifyModeChange(detectMode(cm));
  });
}

/**
 * 订阅 Vim 模式变化。返回取消订阅函数。
 */
export function onVimModeChange(listener: (mode: VimMode) => void): () => void {
  modeChangeListeners.add(listener);
  return () => modeChangeListeners.delete(listener);
}

/**
 * 获取当前 Vim 模式。
 */
export function getVimMode(): VimMode {
  return currentMode;
}

/**
 * 创建一个 ViewPlugin，在编辑器初始化时获取 CodeMirror 实例，
 * 并将 :w 命令绑定到外部保存回调。
 */
function createSavePlugin(onSave: () => void): Extension {
  const plugin = ViewPlugin.define((view: EditorView) => {
    const cm = getCM(view);
    if (cm) {
      // 覆盖 save 命令，使 :w 触发我们的保存逻辑
      (cm.constructor as typeof CodeMirror).commands.save = onSave;
    }
    return {
      destroy() {
        const cm2 = getCM(view);
        if (cm2) {
          (cm2.constructor as typeof CodeMirror).commands.save = undefined;
        }
      },
    };
  });
  return plugin;
}

/**
 * 创建 Vim 扩展集合，包括 vim() 本身、模式监听器和 :w 保存命令。
 * @param getView - 返回当前 EditorView 的函数（用于在 updateListener 中读取 vim 状态）
 * @param onSave - :w 命令触发时的保存回调
 */
export function createVimExtensions(
  getView: () => EditorView | null,
  onSave: () => void,
): Extension[] {
  return [vim(), createSavePlugin(onSave), vimModeListener(getView)];
}

/**
 * 重置内部模式状态（在 Vim 关闭时调用）。
 */
export function resetVimMode() {
  currentMode = 'normal';
}
