import { create } from 'zustand';

// ── 字体定义 ──────────────────────────────────────────────────
// 字体栈使用系统可用字体，浏览器会按顺序回退。
// CSP 策略禁止加载远程字体，因此只使用系统已安装字体。

export interface FontDefinition {
  id: string;
  name: string;
  /** CSS font-family 栈，浏览器按顺序回退 */
  stack: string;
}

export type FontSizePreset = 'sm' | 'md' | 'lg' | 'xl';

export interface FontSizeDefinition {
  id: FontSizePreset;
  name: string;
  /** UI 基础字号 (px) */
  ui: number;
  /** 代码编辑器字号 (px) */
  code: number;
}

// ── UI 字体列表（无衬线） ──────────────────────────────────────

export const UI_FONTS: FontDefinition[] = [
  {
    id: 'system-ui',
    name: '系统默认',
    stack:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  {
    id: 'inter',
    name: 'Inter',
    stack: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  {
    id: 'segoe-ui',
    name: 'Segoe UI',
    stack: '"Segoe UI", system-ui, -apple-system, sans-serif',
  },
  {
    id: 'helvetica',
    name: 'Helvetica / Arial',
    stack: '"Helvetica Neue", Arial, system-ui, sans-serif',
  },
  {
    id: 'roboto',
    name: 'Roboto',
    stack: 'Roboto, "Segoe UI", system-ui, sans-serif',
  },
];

// ── 代码字体列表（等宽） ────────────────────────────────────────

export const CODE_FONTS: FontDefinition[] = [
  {
    id: 'system-mono',
    name: '系统等宽',
    stack:
      'ui-monospace, "SF Mono", "Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
  },
  {
    id: 'cascadia-code',
    name: 'Cascadia Code',
    stack: '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
  },
  {
    id: 'consolas',
    name: 'Consolas',
    stack: 'Consolas, "Courier New", monospace',
  },
  {
    id: 'fira-code',
    name: 'Fira Code',
    stack: '"Fira Code", "Cascadia Code", Consolas, monospace',
  },
  {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    stack: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  },
  {
    id: 'source-code-pro',
    name: 'Source Code Pro',
    stack: '"Source Code Pro", Consolas, "Courier New", monospace',
  },
];

// ── 字号预设 ──────────────────────────────────────────────────

export const FONT_SIZES: FontSizeDefinition[] = [
  { id: 'sm', name: '小', ui: 12, code: 11 },
  { id: 'md', name: '中', ui: 13, code: 12 },
  { id: 'lg', name: '大', ui: 14, code: 13 },
  { id: 'xl', name: '特大', ui: 15, code: 14 },
];

// ── 持久化 key ─────────────────────────────────────────────────

const STORAGE_KEY = 'socverify:font';
const DEFAULT_UI_FONT = 'system-ui';
const DEFAULT_CODE_FONT = 'system-mono';
const DEFAULT_SIZE: FontSizePreset = 'md';

interface PersistedFont {
  uiFont: string;
  codeFont: string;
  size: FontSizePreset;
}

// ── 字体 Store ─────────────────────────────────────────────────

interface FontState {
  uiFontId: string;
  codeFontId: string;
  sizePreset: FontSizePreset;
  uiFonts: FontDefinition[];
  codeFonts: FontDefinition[];
  fontSizes: FontSizeDefinition[];
  setUiFont: (id: string) => void;
  setCodeFont: (id: string) => void;
  setSizePreset: (preset: FontSizePreset) => void;
  initFont: () => void;
}

function resolveFontStack(id: string, list: FontDefinition[], fallbackId: string): string {
  const found = list.find((f) => f.id === id);
  if (found) return found.stack;
  const fallback = list.find((f) => f.id === fallbackId);
  return fallback?.stack ?? list[0].stack;
}

function applyFont(uiFontId: string, codeFontId: string, sizePreset: FontSizePreset) {
  const root = document.documentElement;
  const uiStack = resolveFontStack(uiFontId, UI_FONTS, DEFAULT_UI_FONT);
  const codeStack = resolveFontStack(codeFontId, CODE_FONTS, DEFAULT_CODE_FONT);
  const sizeDef = FONT_SIZES.find((s) => s.id === sizePreset) ?? FONT_SIZES[1];

  root.style.setProperty('--app-font-family-ui', uiStack);
  root.style.setProperty('--app-font-family-code', codeStack);
  root.style.setProperty('--app-font-size-ui', `${sizeDef.ui}px`);
  root.style.setProperty('--app-font-size-code', `${sizeDef.code}px`);
}

function loadPersisted(): PersistedFont | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedFont>;
    return {
      uiFont: parsed.uiFont ?? DEFAULT_UI_FONT,
      codeFont: parsed.codeFont ?? DEFAULT_CODE_FONT,
      size: (parsed.size as FontSizePreset) ?? DEFAULT_SIZE,
    };
  } catch {
    return null;
  }
}

function savePersisted(uiFont: string, codeFont: string, size: FontSizePreset) {
  const data: PersistedFont = { uiFont, codeFont, size };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function isValidPreset(v: string): v is FontSizePreset {
  return v === 'sm' || v === 'md' || v === 'lg' || v === 'xl';
}

export const useFontStore = create<FontState>((set) => ({
  uiFontId: DEFAULT_UI_FONT,
  codeFontId: DEFAULT_CODE_FONT,
  sizePreset: DEFAULT_SIZE,
  uiFonts: UI_FONTS,
  codeFonts: CODE_FONTS,
  fontSizes: FONT_SIZES,

  setUiFont: (id: string) => {
    set((s) => {
      applyFont(id, s.codeFontId, s.sizePreset);
      savePersisted(id, s.codeFontId, s.sizePreset);
      return { uiFontId: id };
    });
  },

  setCodeFont: (id: string) => {
    set((s) => {
      applyFont(s.uiFontId, id, s.sizePreset);
      savePersisted(s.uiFontId, id, s.sizePreset);
      return { codeFontId: id };
    });
  },

  setSizePreset: (preset: FontSizePreset) => {
    set((s) => {
      applyFont(s.uiFontId, s.codeFontId, preset);
      savePersisted(s.uiFontId, s.codeFontId, preset);
      return { sizePreset: preset };
    });
  },

  initFont: () => {
    const persisted = loadPersisted();
    const uiFontId = persisted?.uiFont ?? DEFAULT_UI_FONT;
    const codeFontId = persisted?.codeFont ?? DEFAULT_CODE_FONT;
    const sizePreset = persisted && isValidPreset(persisted.size) ? persisted.size : DEFAULT_SIZE;
    applyFont(uiFontId, codeFontId, sizePreset);
    set({ uiFontId, codeFontId, sizePreset });
  },
}));
