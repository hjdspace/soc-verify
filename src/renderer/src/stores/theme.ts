import { create } from 'zustand';

// ── 主题定义 ──────────────────────────────────────────────────
// 每个主题对应 globals.css 中 [data-theme="<id>"] 的 CSS 变量集

export type ThemeMode = 'light' | 'dark';

export interface ThemeDefinition {
  id: string;
  name: string;
  mode: ThemeMode;
  /** 用于色板预览的主色 */
  swatch: string;
  description: string;
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'light',
    name: '浅色',
    mode: 'light',
    swatch: '#ffffff',
    description: '干净明亮的浅色主题，适合白天工作环境',
  },
  {
    id: 'dark',
    name: '深色',
    mode: 'dark',
    swatch: '#0f0f14',
    description: '经典深色主题，高对比度，适合夜间工作',
  },
  {
    id: 'midnight',
    name: '午夜蓝',
    mode: 'dark',
    swatch: '#1a1b2e',
    description: '深蓝色调暗色主题，长时间使用不伤眼',
  },
  {
    id: 'carbon',
    name: '碳灰',
    mode: 'dark',
    swatch: '#1c1c1c',
    description: '工业风碳灰色暗色主题，冷色调',
  },
  {
    id: 'nord',
    name: '极地',
    mode: 'dark',
    swatch: '#2e3440',
    description: 'Nord 极地配色，蓝灰冷色调，护眼舒适',
  },
  {
    id: 'solarized-light',
    name: 'Solarized 浅',
    mode: 'light',
    swatch: '#fdf6e3',
    description: '暖色调浅色主题，Solarized 配色方案',
  },
];

const STORAGE_KEY = 'socverify:theme';

// ── 主题 Store ─────────────────────────────────────────────────

interface ThemeState {
  currentTheme: string;
  themes: ThemeDefinition[];
  setTheme: (id: string) => void;
  initTheme: () => void;
}

function applyTheme(id: string) {
  const theme = THEMES.find((t) => t.id === id);
  const root = document.documentElement;
  root.dataset.theme = id;
  // 设置 color-scheme 让原生控件（scrollbar 等）也跟随
  root.style.colorScheme = theme?.mode ?? 'dark';
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  currentTheme: 'dark',
  themes: THEMES,

  setTheme: (id: string) => {
    applyTheme(id);
    localStorage.setItem(STORAGE_KEY, id);
    set({ currentTheme: id });
  },

  initTheme: () => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const id = saved && THEMES.some((t) => t.id === saved) ? saved : 'dark';
    applyTheme(id);
    set({ currentTheme: id });
  },
}));
