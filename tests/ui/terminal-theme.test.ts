// @vitest-environment jsdom
/**
 * Terminal 主题读取（Issue #2）——readTerminalThemeFromCss 单元测试。
 *
 * 覆盖两个验收点：
 * 1. 从 CSS 变量读取完整 20 个变量（16 ANSI 色 + 4 语义色）构建 xterm.js ITheme
 * 2. globals.css 中 6 个 UI 主题各有齐备的 20 个 --term-* 变量（静态校验）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  readTerminalThemeFromCss,
  TERMINAL_CSS_VARS,
} from '@renderer/components/terminal/terminal-theme';

/** 20 个变量的 CSS 名清单（16 ANSI + 4 语义） */
const ALL_TERM_VARS = [
  '--term-black',
  '--term-red',
  '--term-green',
  '--term-yellow',
  '--term-blue',
  '--term-magenta',
  '--term-cyan',
  '--term-white',
  '--term-bright-black',
  '--term-bright-red',
  '--term-bright-green',
  '--term-bright-yellow',
  '--term-bright-blue',
  '--term-bright-magenta',
  '--term-bright-cyan',
  '--term-bright-white',
  '--term-background',
  '--term-foreground',
  '--term-cursor',
  '--term-selection',
] as const;

const UI_THEMES = ['drafting', 'bench', 'slate', 'daylight', 'apple-light', 'apple-dark'] as const;

describe('terminal-theme - readTerminalThemeFromCss', () => {
  beforeEach(() => {
    for (const name of ALL_TERM_VARS) {
      document.documentElement.style.removeProperty(name);
    }
  });

  it('ITheme 包含完整 20 个颜色键（16 ANSI + 4 语义色）', () => {
    const theme = readTerminalThemeFromCss();
    const keys = TERMINAL_CSS_VARS.map((spec) => spec.themeKey);
    expect(keys).toHaveLength(20);
    for (const key of keys) {
      expect(theme).toHaveProperty(key);
      expect(typeof theme[key]).toBe('string');
    }
  });

  it('CSS 变量名与 20 个 --term-* 命名一一对应', () => {
    expect([...TERMINAL_CSS_VARS.map((s) => s.cssVar)].sort()).toEqual([...ALL_TERM_VARS].sort());
  });

  it('从 CSS 变量读取颜色值到对应 ITheme 键', () => {
    document.documentElement.style.setProperty('--term-background', '#101010');
    document.documentElement.style.setProperty('--term-foreground', '#e0e0e0');
    document.documentElement.style.setProperty('--term-cursor', '#00ff00');
    document.documentElement.style.setProperty('--term-selection', '#00ff0022');
    document.documentElement.style.setProperty('--term-red', '#ff0000');
    document.documentElement.style.setProperty('--term-bright-white', '#ffffff');

    const theme = readTerminalThemeFromCss();
    expect(theme.background).toBe('#101010');
    expect(theme.foreground).toBe('#e0e0e0');
    expect(theme.cursor).toBe('#00ff00');
    expect(theme.selectionBackground).toBe('#00ff0022');
    expect(theme.red).toBe('#ff0000');
    expect(theme.brightWhite).toBe('#ffffff');
  });

  it('变量值两端的空白被 trim', () => {
    document.documentElement.style.setProperty('--term-green', '  #00aa00  ');
    expect(readTerminalThemeFromCss().green).toBe('#00aa00');
  });

  it('变量未定义或为空时回退到内置默认调色盘（非空 hex）', () => {
    const theme = readTerminalThemeFromCss();
    for (const spec of TERMINAL_CSS_VARS) {
      const value = theme[spec.themeKey] as string | undefined;
      expect(value, `${spec.cssVar} 回退值不应为空`).toBeTruthy();
      expect(value, `${spec.cssVar} 回退值应为 hex`).toMatch(/^#[0-9a-fA-F]+$/);
    }
  });

  it('空字符串变量回退到默认值', () => {
    document.documentElement.style.setProperty('--term-blue', '   ');
    const theme = readTerminalThemeFromCss();
    const fallback = TERMINAL_CSS_VARS.find((s) => s.themeKey === 'blue');
    expect(theme.blue).toBe(fallback?.fallback);
  });
});

describe('globals.css - 6 个 UI 主题的终端 16 色调色盘齐备性', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/styles/globals.css'),
    'utf8',
  );

  for (const themeId of UI_THEMES) {
    it(`[${themeId}] 主题块包含全部 20 个 --term-* 变量（hex 格式）`, () => {
      const blockMatch = css.match(new RegExp(`\\[data-theme="${themeId}"\\] \\{([\\s\\S]*?)\\n\\}`));
      expect(blockMatch, `globals.css 中应存在 [data-theme="${themeId}"] 主题块`).toBeTruthy();
      const block = blockMatch?.[1] ?? '';

      for (const name of ALL_TERM_VARS) {
        const varMatch = block.match(new RegExp(`${name}:\\s*([^;]+);`));
        expect(varMatch, `${themeId} 缺少 ${name}`).toBeTruthy();
        const value = varMatch?.[1]?.trim() ?? '';
        // xterm.js 的 css.toColor 只支持 hex/rgb/rgba——调色盘必须直接写 hex，
        // 不能用 oklch()（zrender/xterm 均无法解析，见 echarts-theme 的教训）
        expect(value, `${themeId} ${name} = ${value} 应为 hex 格式`).toMatch(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
      }
    });
  }
});
