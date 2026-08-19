import { create } from 'zustand';

// ── 持久化 key ─────────────────────────────────────────────────

const STORAGE_KEY = 'socverify:editor';

// ── 持久化数据结构 ─────────────────────────────────────────────

type PersistedEditor = {
  vimEnabled: boolean;
  minimapEnabled: boolean;
};

// ── 编辑器 Store ───────────────────────────────────────────────

interface EditorState {
  /** Vim 模式是否启用 */
  vimEnabled: boolean;
  /** 设置 Vim 模式开关 */
  setVimEnabled: (enabled: boolean) => void;
  /** Minimap 缩略图是否启用 */
  minimapEnabled: boolean;
  /** 设置 Minimap 开关 */
  setMinimapEnabled: (enabled: boolean) => void;
  /** 从 localStorage 恢复状态（应用启动时调用） */
  initEditor: () => void;
}

function loadPersisted(): PersistedEditor | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedEditor>;
    return {
      vimEnabled: parsed.vimEnabled ?? false,
      minimapEnabled: parsed.minimapEnabled ?? false,
    };
  } catch {
    return null;
  }
}

function savePersisted(vimEnabled: boolean, minimapEnabled: boolean) {
  const data: PersistedEditor = { vimEnabled, minimapEnabled };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export const useEditorStore = create<EditorState>((set, get) => ({
  vimEnabled: false,
  minimapEnabled: false,

  setVimEnabled: (enabled: boolean) => {
    savePersisted(enabled, get().minimapEnabled);
    set({ vimEnabled: enabled });
  },

  setMinimapEnabled: (enabled: boolean) => {
    savePersisted(get().vimEnabled, enabled);
    set({ minimapEnabled: enabled });
  },

  initEditor: () => {
    const persisted = loadPersisted();
    set({
      vimEnabled: persisted?.vimEnabled ?? false,
      minimapEnabled: persisted?.minimapEnabled ?? false,
    });
  },
}));
