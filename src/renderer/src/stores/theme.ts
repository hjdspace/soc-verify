import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';

// ── 主题定义 ──────────────────────────────────────────────────
// 每个主题对应 globals.css 中 [data-theme="<id>"] 的 CSS 变量集。
// 三套主题各自拒绝一种 EDA / 工程师工具的常见反射，详见各主题注释。

export type ThemeMode = 'light' | 'dark';

export interface ThemeDefinition {
  id: string;
  name: string;
  mode: ThemeMode;
  /** 用于色板预览的主色（hex 仅用于 swatch UI 显示） */
  swatch: string;
  description: string;
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'drafting',
    name: 'Drafting',
    mode: 'light',
    swatch: '#7c3a9e',
    description: '暖纸白底 + 深紫梅强调。荧光灯实验室、白板、纸质文档场景。',
  },
  {
    id: 'bench',
    name: 'Bench',
    mode: 'dark',
    swatch: '#3ddc84',
    description: '暖深底 + 磷光绿强调。长时间跑 8 小时回归，暖色降低视疲劳。',
  },
  {
    id: 'slate',
    name: 'Slate',
    mode: 'dark',
    swatch: '#d08a4e',
    description: '冷石板底 + 铜色强调。三显示器扫表找失败行，冷底色压低反差噪声。',
  },
  {
    id: 'daylight',
    name: 'Daylight',
    mode: 'light',
    swatch: '#3b5bdb',
    description: '极浅灰白底 + 靛蓝强调。参考 Cursor / Windsurf 等流行 AI IDE 浅色主题。',
  },
  {
    id: 'apple-light',
    name: 'Apple Light',
    mode: 'light',
    swatch: '#0071e3',
    description: 'macOS 浅色：灰白底 + 系统蓝 + 毛玻璃浮层 + 10px 圆角。',
  },
  {
    id: 'apple-dark',
    name: 'Apple Dark',
    mode: 'dark',
    swatch: '#0a84ff',
    description: 'macOS 深色：石墨底 + 亮蓝 + 毛玻璃浮层，浮层比卡片亮一档。',
  },
];

const STORAGE_KEY = 'socverify:theme';
const DEFAULT_THEME = 'bench';

// 旧 6 主题 ID → 新主题 ID 映射（迁移已保存的偏好）
const LEGACY_THEME_MIGRATION: Record<string, string> = {
  light: 'daylight',
  'solarized-light': 'drafting',
  dark: 'bench',
  midnight: 'bench',
  carbon: 'slate',
  nord: 'slate',
};

// ── 主题 Store ─────────────────────────────────────────────────

interface ThemeState {
  currentTheme: string;
  themes: ThemeDefinition[];
  setTheme: (id: string) => void;
  initTheme: () => void;
}

/**
 * 主题切换跨帧淡入（View Transitions）。
 *
 * 为什么不用 `.theme-transition *`（全局 transition）：那会在切换瞬间给
 * 数千个 DOM 元素同时启动 color/border 过渡，主线程要持续 200ms 逐帧
 * 计算样式 + 重绘，列表/树重的视图直接掉帧。View Transition 由合成器
 * 承担新旧两帧的交叉淡化，DOM 只需一次变量翻转，主线程零逐帧成本。
 * 不支持时（旧内核 / jsdom）退化为立即切换——主题本身是离散值，
 * 无动画不影响正确性。
 */
function applyTheme(id: string) {
  const theme = THEMES.find((t) => t.id === id);
  const root = document.documentElement;
  const doApply = () => {
    root.dataset.theme = id;
    // 明暗档位（light/dark）：供局部设计语言（如 AI 面板 dsw 色板）切换亮暗令牌
    root.dataset.shade = theme?.mode ?? 'dark';
    // 设置 color-scheme 让原生控件（scrollbar 等）也跟随
    root.style.colorScheme = theme?.mode ?? 'dark';
  };
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (prefersReducedMotion || !document.startViewTransition) {
    doApply();
  } else {
    const transition = document.startViewTransition(doApply);
    // 快速连续切换（如 initTheme 的 localStorage 同步应用 + 主进程异步回填）
    // 会跳过前一个过渡：ready/finished 以 AbortError 拒绝，属预期行为。
    // 显式吞掉，避免控制台 unhandled rejection 噪音。
    transition.ready.catch(() => undefined);
    transition.finished.catch(() => undefined);
  }
}

function resolveThemeId(saved: string | null): string {
  if (!saved) return DEFAULT_THEME;
  if (THEMES.some((t) => t.id === saved)) return saved;
  // 旧主题迁移
  if (LEGACY_THEME_MIGRATION[saved]) {
    const migrated = LEGACY_THEME_MIGRATION[saved];
    localStorage.setItem(STORAGE_KEY, migrated);
    return migrated;
  }
  return DEFAULT_THEME;
}

export const useThemeStore = create<ThemeState>((set) => ({
  currentTheme: DEFAULT_THEME,
  themes: THEMES,

  setTheme: (id: string) => {
    applyTheme(id);
    localStorage.setItem(STORAGE_KEY, id);
    set({ currentTheme: id });
    // 同步到主进程文件级持久化（确保重启后恢复）
    void trpc.settings.setTheme.mutate({ theme: id }).catch(() => {
      // best-effort — localStorage 仍然有效
    });
  },

  initTheme: () => {
    // 1. 先从 localStorage 同步读取（用于 anti-flash）
    const saved = localStorage.getItem(STORAGE_KEY);
    const id = resolveThemeId(saved);
    applyTheme(id);
    set({ currentTheme: id });

    // 2. 再从主进程文件级持久化异步读取（更可靠）
    //    如果文件中有不同的主题，覆盖 localStorage 的值
    void trpc.settings.getTheme.query().then((fileTheme) => {
      if (fileTheme && fileTheme !== id) {
        const resolved = resolveThemeId(fileTheme);
        if (resolved !== id) {
          applyTheme(resolved);
          localStorage.setItem(STORAGE_KEY, resolved);
          set({ currentTheme: resolved });
        }
      } else if (fileTheme === null && saved) {
        // localStorage 有值但文件中没有（旧用户迁移）——同步到文件
        void trpc.settings.setTheme.mutate({ theme: id }).catch(() => {});
      }
    }).catch(() => {
      // tRPC 不可用时回退到 localStorage
    });
  },
}));
