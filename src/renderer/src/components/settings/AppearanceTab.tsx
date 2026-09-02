import { Check, Keyboard, Monitor, Palette, Type, Zap } from 'lucide-react';
import { useThemeStore, type ThemeDefinition } from '@renderer/stores/theme';
import {
  useTerminalThemeStore,
  type BuiltinTerminalTheme,
} from '@renderer/stores/terminal-theme';
import type { TerminalThemeMode } from '@shared/terminal-theme-types';
import { useFontStore } from '@renderer/stores/font';
import { useEditorStore } from '@renderer/stores/editor';
import { useUiStore } from '@renderer/stores/ui';
import { cn } from '@renderer/lib/utils';

/**
 * 外观 Tab — 主题选择 + 字体管理 + 编辑器设置 + AI 面板布局。
 */

export function AppearanceTab() {
  const currentTheme = useThemeStore((s) => s.currentTheme);
  const themes = useThemeStore((s) => s.themes);
  const setTheme = useThemeStore((s) => s.setTheme);

  const uiFontId = useFontStore((s) => s.uiFontId);
  const codeFontId = useFontStore((s) => s.codeFontId);
  const sizePreset = useFontStore((s) => s.sizePreset);
  const uiFonts = useFontStore((s) => s.uiFonts);
  const codeFonts = useFontStore((s) => s.codeFonts);
  const fontSizes = useFontStore((s) => s.fontSizes);
  const setUiFont = useFontStore((s) => s.setUiFont);
  const setCodeFont = useFontStore((s) => s.setCodeFont);
  const setSizePreset = useFontStore((s) => s.setSizePreset);

  const vimEnabled = useEditorStore((s) => s.vimEnabled);
  const setVimEnabled = useEditorStore((s) => s.setVimEnabled);
  const minimapEnabled = useEditorStore((s) => s.minimapEnabled);
  const setMinimapEnabled = useEditorStore((s) => s.setMinimapEnabled);

  const aiPanelMode = useUiStore((s) => s.aiPanelMode);
  const setAiPanelMode = useUiStore((s) => s.setAiPanelMode);

  // 终端主题（Issue #3）
  const terminalThemeMode = useTerminalThemeStore((s) => s.themeMode);
  const terminalThemeId = useTerminalThemeStore((s) => s.themeId);
  const builtinTerminalThemes = useTerminalThemeStore((s) => s.builtinThemes);
  const setTerminalThemeMode = useTerminalThemeStore((s) => s.setThemeMode);
  const setTerminalTheme = useTerminalThemeStore((s) => s.setTheme);

  return (
    <div className="space-y-4">
      {/* 主题选择（按明暗分组） */}
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
          <Palette className="h-3 w-3" />
          主题
        </div>
        <ThemeGroup label="浅色" themes={themes.filter((t) => t.mode === 'light')} currentTheme={currentTheme} onSelect={setTheme} />
        <ThemeGroup label="深色" themes={themes.filter((t) => t.mode === 'dark')} currentTheme={currentTheme} onSelect={setTheme} />
      </div>

      {/* 终端主题（Issue #3）：跟随 UI 或独立内置主题 */}
      <div className="space-y-3 border-t border-border/50 pt-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
          <Monitor className="h-3 w-3" />
          终端主题
        </div>

        {/* 模式切换开关 */}
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              {
                mode: 'follow-ui' as TerminalThemeMode,
                name: '跟随 UI',
                desc: '终端配色随上方 UI 主题自动联动',
              },
              {
                mode: 'independent' as TerminalThemeMode,
                name: '独立主题',
                desc: '选择独立于 UI 主题的终端配色',
              },
            ]
          ).map(({ mode, name, desc }) => (
            <button
              key={mode}
              onClick={() => setTerminalThemeMode(mode)}
              className={cn(
                'rounded-md border p-2.5 text-left transition-colors',
                terminalThemeMode === mode
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-accent',
              )}
            >
              <div className="text-xs font-medium text-foreground">{name}</div>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{desc}</p>
            </button>
          ))}
        </div>

        {/* 独立模式：内置主题卡片（色板预览 + 名称 + 描述） */}
        {terminalThemeMode === 'independent' && (
          <div className="grid grid-cols-2 gap-2">
            {builtinTerminalThemes.map((theme) => (
              <TerminalThemeCard
                key={theme.id}
                theme={theme}
                selected={terminalThemeId === theme.id}
                onSelect={() => setTerminalTheme(theme.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 字体管理 */}
      <div className="space-y-3 border-t border-border/50 pt-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
          <Type className="h-3 w-3" />
          字体
        </div>

        {/* UI 字体 */}
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">界面字体</label>
          <select
            value={uiFontId}
            onChange={(e) => setUiFont(e.target.value)}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
          >
            {uiFonts.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>

        {/* 代码字体 */}
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">代码字体</label>
          <select
            value={codeFontId}
            onChange={(e) => setCodeFont(e.target.value)}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
          >
            {codeFonts.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>

        {/* 字号预设 */}
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">字号大小</label>
          <div className="grid grid-cols-4 gap-1.5">
            {fontSizes.map((size) => (
              <button
                key={size.id}
                onClick={() => setSizePreset(size.id)}
                className={cn(
                  'rounded border py-1.5 text-center text-[11px] font-medium transition-colors',
                  sizePreset === size.id
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {size.name}
                <span className="block text-[9px] text-muted-foreground/70">
                  {size.code}px
                </span>
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground/70">
            界面 {fontSizes.find((s) => s.id === sizePreset)?.ui}px / 代码 {fontSizes.find((s) => s.id === sizePreset)?.code}px
          </p>
        </div>

        {/* 预览 */}
        <div className="rounded-md border border-border/50 bg-secondary/20 p-2.5">
          <div className="mb-1 text-[9px] uppercase text-muted-foreground/70">预览</div>
          <p className="text-xs" style={{ fontFamily: 'var(--app-font-family-ui)' }}>
            SoC Verify — 界面字体预览 The quick brown fox
          </p>
          <pre
            className="mt-1.5 text-[11px] leading-[1.35]"
            style={{
              fontFamily: 'var(--app-font-family-code)',
              fontSize: 'var(--app-font-size-code)',
            }}
          >
{`module alu_add (
  input  [31:0] a, b,
  output [31:0] sum
);
  assign sum = a + b;
endmodule`}
          </pre>
        </div>
      </div>

      {/* Vim 模式 */}
      <div className="space-y-3 border-t border-border/50 pt-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
          <Keyboard className="h-3 w-3" />
          编辑器
        </div>
        <div className="flex items-center justify-between rounded-md border border-border/50 bg-secondary/20 px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">Vim 模式</div>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                启用后编辑器使用 Vim 键位（Normal/Insert/Visual/Command），:w 保存文件
              </p>
            </div>
          </div>
          <button
            onClick={() => setVimEnabled(!vimEnabled)}
            className={cn(
              'relative h-5 w-9 shrink-0 rounded-full transition-colors',
              vimEnabled ? 'bg-primary' : 'bg-muted',
            )}
            role="switch"
            aria-checked={vimEnabled}
            aria-label="Vim 模式开关"
            title={vimEnabled ? '关闭 Vim 模式' : '启用 Vim 模式'}
          >
            <span
              className={cn(
                'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-background transition-transform',
                vimEnabled ? 'translate-x-4' : 'translate-x-0',
              )}
            />
          </button>
        </div>
        {/* Minimap 开关 */}
        <div className="flex items-center justify-between rounded-md border border-border/50 bg-secondary/20 px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">Minimap 缩略图</div>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                在编辑器右侧显示代码缩略图，点击或拖拽快速跳转
              </p>
            </div>
          </div>
          <button
            onClick={() => setMinimapEnabled(!minimapEnabled)}
            className={cn(
              'relative h-5 w-9 shrink-0 rounded-full transition-colors',
              minimapEnabled ? 'bg-primary' : 'bg-muted',
            )}
            role="switch"
            aria-checked={minimapEnabled}
            aria-label="Minimap 缩略图开关"
            title={minimapEnabled ? '关闭 Minimap' : '启用 Minimap'}
          >
            <span
              className={cn(
                'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-background transition-transform',
                minimapEnabled ? 'translate-x-4' : 'translate-x-0',
              )}
            />
          </button>
        </div>
      </div>

      {/* AI 面板布局 */}
      <div className="space-y-3 border-t border-border/50 pt-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
          <Zap className="h-3 w-3" />
          AI 面板
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setAiPanelMode('drawer')}
            className={cn(
              'rounded-md border p-2.5 text-left transition-colors',
              aiPanelMode === 'drawer'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-accent',
            )}
          >
            <div className="text-xs font-medium text-foreground">抽屉模式</div>
            <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
              点击导航栏 AI 按钮临时展开，不占用主视图空间
            </p>
          </button>
          <button
            onClick={() => setAiPanelMode('docked')}
            className={cn(
              'rounded-md border p-2.5 text-left transition-colors',
              aiPanelMode === 'docked'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-accent',
            )}
          >
            <div className="text-xs font-medium text-foreground">固定侧栏模式</div>
            <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
              AI 会话面板常驻右侧，与主视图并排显示
            </p>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 终端主题卡片（色板预览 + 名称 + 描述）─────────────────────

type TerminalThemeCardProps = {
  theme: BuiltinTerminalTheme;
  selected: boolean;
  onSelect: () => void;
};

function TerminalThemeCard({ theme, selected, onSelect }: TerminalThemeCardProps) {
  // 色板预览：背景 + 4 个代表色条
  const previewColors = [
    theme.theme.background,
    theme.theme.red,
    theme.theme.green,
    theme.theme.blue,
    theme.theme.brightWhite,
  ];
  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex items-center gap-3 rounded-md border p-2.5 text-left transition-colors',
        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent',
      )}
    >
      {/* 色板预览 */}
      <span className="flex h-8 w-12 shrink-0 overflow-hidden rounded-md border border-border">
        {previewColors.map((color, i) => (
          <span key={i} className="h-full flex-1" style={{ backgroundColor: color }} />
        ))}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground">{theme.name}</div>
        <div className="truncate text-[10px] text-muted-foreground">{theme.description}</div>
      </div>
      {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
    </button>
  );
}

// ── 主题分组（浅色 / 深色）─────────────────────────────────────

type ThemeGroupProps = {
  /** 组标签（浅色 / 深色） */
  label: string;
  /** 该组主题列表 */
  themes: ThemeDefinition[];
  /** 当前生效主题 id */
  currentTheme: string;
  /** 选中回调 */
  onSelect: (id: string) => void;
};

function ThemeGroup({ label, themes, currentTheme, onSelect }: ThemeGroupProps) {
  if (themes.length === 0) return null;
  return (
    <div className="mt-2 first:mt-0">
      <div className="mb-1 text-[10px] text-muted-foreground/70">{label}</div>
      <div className="grid grid-cols-2 gap-2">
        {themes.map((theme) => (
          <button
            key={theme.id}
            onClick={() => onSelect(theme.id)}
            className={cn(
              'flex items-center gap-3 rounded-md border p-2.5 text-left transition-colors',
              currentTheme === theme.id
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-accent',
            )}
          >
            {/* 色板预览 */}
            <span
              className="h-8 w-8 shrink-0 rounded-md border border-border"
              style={{ backgroundColor: theme.swatch }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground">{theme.name}</div>
              <div className="truncate text-[10px] text-muted-foreground">
                {theme.description}
              </div>
            </div>
            {currentTheme === theme.id && (
              <Check className="h-4 w-4 shrink-0 text-primary" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
