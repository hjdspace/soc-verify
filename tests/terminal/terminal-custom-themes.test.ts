/**
 * 自定义终端主题存储（Issue #4）——terminal-custom-themes 单元测试。
 *
 * 覆盖验收点：
 * 1. importCustomTheme：校验 JSON 格式、写入 <dir>/<id>.json、返回 CustomTerminalTheme
 * 2. listCustomThemes：读取目录、跳过损坏文件、按名称排序
 * 3. deleteCustomTheme：删除文件、非法 ID 拒绝、文件不存在返回 false
 * 4. slugifyThemeName：名称 → 文件安全 slug
 * 5. 同名主题重复导入 = 覆盖更新
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  importCustomTheme,
  listCustomThemes,
  deleteCustomTheme,
  TerminalThemeImportError,
} from '../../src/main/terminal/terminal-custom-themes';
import type { CustomTerminalTheme } from '../../src/shared/terminal-theme-types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'terminal-themes-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── importCustomTheme ──────────────────────────────────────────

describe('importCustomTheme', () => {
  it('校验通过并写入 <dir>/<id>.json', async () => {
    const doc = await importCustomTheme(
      { background: '#1a1b26', foreground: '#c0caf5', red: '#f7768e' },
      'My Theme',
      tmpDir,
    );
    expect(doc.id).toBe('my-theme');
    expect(doc.name).toBe('My Theme');
    expect(doc.theme.background).toBe('#1a1b26');
    expect(doc.theme.red).toBe('#f7768e');

    const file = join(tmpDir, 'my-theme.json');
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, 'utf-8')) as CustomTerminalTheme;
    expect(written.id).toBe('my-theme');
    expect(written.name).toBe('My Theme');
    expect(written.theme.background).toBe('#1a1b26');
  });

  it('JSON 内 name 字段优先于 nameHint', async () => {
    const doc = await importCustomTheme(
      { name: 'Dracula Custom', background: '#282a36' },
      'Hint Name',
      tmpDir,
    );
    expect(doc.name).toBe('Dracula Custom');
    expect(doc.id).toBe('dracula-custom');
  });

  it('无 name 字段时用 nameHint（如导入文件名）', async () => {
    // AppearanceTab 在调用前已 strip .json 后缀，此处模拟剥离后的 nameHint
    const doc = await importCustomTheme(
      { background: '#282a36' },
      'my-cool-theme',
      tmpDir,
    );
    expect(doc.name).toBe('my-cool-theme');
    expect(doc.id).toBe('my-cool-theme');
  });

  it('无 name 也无 nameHint 时回退为「自定义主题」', async () => {
    const doc = await importCustomTheme({ background: '#282a36' }, undefined, tmpDir);
    expect(doc.name).toBe('自定义主题');
    expect(doc.id).toBe('custom-theme');
  });

  it('名称含特殊字符时 slug 化（小写 + 连字符）', async () => {
    const doc = await importCustomTheme(
      { background: '#282a36' },
      'My Cool Theme! @#$',
      tmpDir,
    );
    expect(doc.id).toBe('my-cool-theme');
  });

  it('名称全特殊字符时回退为 custom-theme slug', async () => {
    const doc = await importCustomTheme(
      { background: '#282a36' },
      '!!!@##$$',
      tmpDir,
    );
    expect(doc.id).toBe('custom-theme');
  });

  it('重复导入同 ID 主题时覆盖旧内容', async () => {
    await importCustomTheme(
      { background: '#282a36', red: '#ff5555' },
      'My Theme',
      tmpDir,
    );
    const doc2 = await importCustomTheme(
      { background: '#1a1b26', red: '#f7768e' },
      'My Theme',
      tmpDir,
    );
    expect(doc2.theme.background).toBe('#1a1b26');
    expect(doc2.theme.red).toBe('#f7768e');

    const files = listCustomThemes(tmpDir);
    const themes = await files;
    expect(themes).toHaveLength(1);
    expect(themes[0].theme.background).toBe('#1a1b26');
  });

  it('接受 8 位 hex（#RRGGBBAA）颜色值', async () => {
    const doc = await importCustomTheme(
      { background: '#282a3680', selectionBackground: '#ff000022' },
      'Alpha Theme',
      tmpDir,
    );
    expect(doc.theme.background).toBe('#282a3680');
    expect(doc.theme.selectionBackground).toBe('#ff000022');
  });

  it('颜色值统一转小写', async () => {
    const doc = await importCustomTheme(
      { background: '#282A36', Red: '#FF5555' },
      'Upper Theme',
      tmpDir,
    );
    expect(doc.theme.background).toBe('#282a36');
  });

  it('忽略 ITheme 键以外的未知键', async () => {
    const doc = await importCustomTheme(
      { background: '#282a36', unknownKey: 'whatever', extra: 42 },
      'Unknown Keys',
      tmpDir,
    );
    expect(doc.theme.background).toBe('#282a36');
    expect(doc.theme).not.toHaveProperty('unknownKey');
    expect(doc.theme).not.toHaveProperty('extra');
  });

  it('格式不合法（非对象）时抛 TerminalThemeImportError', async () => {
    await expect(importCustomTheme('not an object', 'Bad', tmpDir)).rejects.toThrow(
      TerminalThemeImportError,
    );
    await expect(importCustomTheme(null, 'Bad', tmpDir)).rejects.toThrow(
      TerminalThemeImportError,
    );
    await expect(importCustomTheme([], 'Bad', tmpDir)).rejects.toThrow(
      TerminalThemeImportError,
    );
  });

  it('格式不合法（无合法颜色键）时抛 TerminalThemeImportError', async () => {
    await expect(
      importCustomTheme({ name: 'No Colors' }, 'No Colors', tmpDir),
    ).rejects.toThrow(TerminalThemeImportError);
  });

  it('颜色值非 hex 格式时抛 TerminalThemeImportError', async () => {
    await expect(
      importCustomTheme({ background: 'red' }, 'Bad Color', tmpDir),
    ).rejects.toThrow(TerminalThemeImportError);
    await expect(
      importCustomTheme({ red: '#gggggg' }, 'Bad Color', tmpDir),
    ).rejects.toThrow(TerminalThemeImportError);
  });

  it('已知颜色键但值非法（如数字）时抛 TerminalThemeImportError', async () => {
    await expect(
      importCustomTheme({ background: 123 }, 'Bad Type', tmpDir),
    ).rejects.toThrow(TerminalThemeImportError);
  });

  it('自动创建不存在的目录', async () => {
    const nestedDir = join(tmpDir, 'nested', 'themes');
    const doc = await importCustomTheme(
      { background: '#282a36' },
      'Nested Theme',
      nestedDir,
    );
    expect(doc.id).toBe('nested-theme');
    expect(existsSync(join(nestedDir, 'nested-theme.json'))).toBe(true);
  });

  it('name 超长时截断为 50 字符', async () => {
    const longName = 'A'.repeat(100);
    const doc = await importCustomTheme({ background: '#282a36' }, longName, tmpDir);
    expect(doc.name.length).toBe(50);
  });
});

// ── listCustomThemes ──────────────────────────────────────────

describe('listCustomThemes', () => {
  it('目录不存在时返回空数组', async () => {
    const themes = await listCustomThemes(join(tmpDir, 'no-such-dir'));
    expect(themes).toEqual([]);
  });

  it('读取目录下全部自定义主题', async () => {
    await importCustomTheme({ background: '#282a36' }, 'Dracula Clone', tmpDir);
    await importCustomTheme({ background: '#2e3440' }, 'Nord Clone', tmpDir);

    const themes = await listCustomThemes(tmpDir);
    expect(themes).toHaveLength(2);
    const ids = themes.map((t) => t.id);
    expect(ids).toContain('dracula-clone');
    expect(ids).toContain('nord-clone');
  });

  it('按 name 字母序排列', async () => {
    await importCustomTheme({ background: '#282a36' }, 'Zebra Theme', tmpDir);
    await importCustomTheme({ background: '#2e3440' }, 'Alpha Theme', tmpDir);
    await importCustomTheme({ background: '#1a1b26' }, 'Middle Theme', tmpDir);

    const themes = await listCustomThemes(tmpDir);
    expect(themes.map((t) => t.name)).toEqual([
      'Alpha Theme',
      'Middle Theme',
      'Zebra Theme',
    ]);
  });

  it('跳过非 JSON 文件', async () => {
    await importCustomTheme({ background: '#282a36' }, 'Valid Theme', tmpDir);
    writeFileSync(join(tmpDir, 'readme.txt'), 'not a theme');
    writeFileSync(join(tmpDir, 'config.yaml'), 'yaml: data');

    const themes = await listCustomThemes(tmpDir);
    expect(themes).toHaveLength(1);
    expect(themes[0].id).toBe('valid-theme');
  });

  it('跳过损坏的 JSON 文件（不影响其他主题）', async () => {
    await importCustomTheme({ background: '#282a36' }, 'Good Theme', tmpDir);
    writeFileSync(join(tmpDir, 'broken.json'), '{ invalid json }}}');

    const themes = await listCustomThemes(tmpDir);
    expect(themes).toHaveLength(1);
    expect(themes[0].id).toBe('good-theme');
  });

  it('跳过结构不合法的主题文件', async () => {
    await importCustomTheme({ background: '#282a36' }, 'Good Theme', tmpDir);

    // id 缺失
    writeFileSync(join(tmpDir, 'no-id.json'), JSON.stringify({ name: 'No ID', theme: { background: '#282a36' } }));
    // id 非法（含大写）
    writeFileSync(join(tmpDir, 'bad-id.json'), JSON.stringify({ id: 'BadID', name: 'Bad ID', theme: { background: '#282a36' } }));
    // name 缺失
    writeFileSync(join(tmpDir, 'no-name.json'), JSON.stringify({ id: 'no-name', theme: { background: '#282a36' } }));
    // theme 颜色非法
    writeFileSync(join(tmpDir, 'bad-color.json'), JSON.stringify({ id: 'bad-color', name: 'Bad Color', theme: { background: 'not-a-color' } }));

    const themes = await listCustomThemes(tmpDir);
    expect(themes).toHaveLength(1);
    expect(themes[0].id).toBe('good-theme');
  });

  it('读取的主题颜色经过 sanitize（统一小写）', async () => {
    await importCustomTheme({ background: '#282A36' }, 'Upper Hex', tmpDir);
    const themes = await listCustomThemes(tmpDir);
    expect(themes[0].theme.background).toBe('#282a36');
  });
});

// ── deleteCustomTheme ─────────────────────────────────────────

describe('deleteCustomTheme', () => {
  it('删除已存在的主题文件', async () => {
    await importCustomTheme({ background: '#282a36' }, 'Deletable', tmpDir);
    const file = join(tmpDir, 'deletable.json');
    expect(existsSync(file)).toBe(true);

    const deleted = await deleteCustomTheme('deletable', tmpDir);
    expect(deleted).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('文件不存在时返回 false', async () => {
    const deleted = await deleteCustomTheme('nonexistent', tmpDir);
    expect(deleted).toBe(false);
  });

  it('非法 ID（含路径穿越）返回 false', async () => {
    const deleted = await deleteCustomTheme('../../../etc/passwd', tmpDir);
    expect(deleted).toBe(false);
  });

  it('非法 ID（含大写字母）返回 false', async () => {
    const deleted = await deleteCustomTheme('BadID', tmpDir);
    expect(deleted).toBe(false);
  });

  it('非法 ID（含空格）返回 false', async () => {
    const deleted = await deleteCustomTheme('has space', tmpDir);
    expect(deleted).toBe(false);
  });

  it('删除一个主题不影响其他主题', async () => {
    await importCustomTheme({ background: '#282a36' }, 'Keep Me', tmpDir);
    await importCustomTheme({ background: '#1a1b26' }, 'Delete Me', tmpDir);

    await deleteCustomTheme('delete-me', tmpDir);
    const themes = await listCustomThemes(tmpDir);
    expect(themes).toHaveLength(1);
    expect(themes[0].id).toBe('keep-me');
  });
});

// ── 端到端：导入 → 列表 → 删除 ─────────────────────────────────

describe('端到端：导入 → 列表 → 删除', () => {
  it('完整流程', async () => {
    // 导入两个主题
    await importCustomTheme({ background: '#282a36', red: '#ff5555' }, 'Theme One', tmpDir);
    await importCustomTheme({ background: '#2e3440', red: '#bf616a' }, 'Theme Two', tmpDir);

    // 列表确认
    let themes = await listCustomThemes(tmpDir);
    expect(themes).toHaveLength(2);

    // 删除第一个
    await deleteCustomTheme('theme-one', tmpDir);
    themes = await listCustomThemes(tmpDir);
    expect(themes).toHaveLength(1);
    expect(themes[0].id).toBe('theme-two');

    // 删除第二个
    await deleteCustomTheme('theme-two', tmpDir);
    themes = await listCustomThemes(tmpDir);
    expect(themes).toHaveLength(0);
  });
});
