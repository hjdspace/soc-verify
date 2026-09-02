import { app } from 'electron';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseTerminalThemeJson,
  sanitizeTerminalThemeColors,
  type CustomTerminalTheme,
} from '@shared/terminal-theme-types';

/**
 * 自定义终端主题存储（Issue #4，ADR-0030）——appData 下目录级存储。
 *
 * 每个自定义主题一个 JSON 文件 `<userData>/terminal-themes/<id>.json`，
 * 文档结构 `{ id, name, theme }`。与 terminal-theme-settings.ts（模式/选中 ID
 * 的单文件持久化）互补。CSP 合规：前端不接触文件路径，只接收数据对象。
 */

const THEMES_DIR_NAME = 'terminal-themes';

/** 导入 JSON 格式不合法时抛出（router 转 BAD_REQUEST，前端 toast 展示 message） */
export class TerminalThemeImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalThemeImportError';
  }
}

function getCustomThemesDir(): string {
  return join(app.getPath('userData'), THEMES_DIR_NAME);
}

/** 主题名称 → 文件安全 slug（小写字母/数字/连字符），空结果回退 custom-theme */
function slugifyThemeName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'custom-theme';
}

/** 自定义主题 ID 集合约束（同时防路径穿越） */
function isValidCustomThemeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

/**
 * 校验并导入一个自定义主题 JSON，持久化到 `<dir>/<slug>.json`。
 * 同名主题（同 ID）重复导入时覆盖旧内容（更新调色盘）。
 * 名称优先级：JSON 内 `name` 字段 → nameHint（如导入文件名）→ 「自定义主题」。
 */
export async function importCustomTheme(
  json: unknown,
  nameHint?: string,
  dir: string = getCustomThemesDir(),
): Promise<CustomTerminalTheme> {
  const parsed = parseTerminalThemeJson(json);
  if (!parsed) {
    throw new TerminalThemeImportError(
      '主题 JSON 格式不合法：需为 xterm.js ITheme 兼容对象，包含至少一个颜色键（如 background/red/…），且值为 hex 格式（#RRGGBB）',
    );
  }
  const name =
    parsed.name ??
    (nameHint !== undefined && nameHint.trim().length > 0
      ? nameHint.trim().slice(0, 50)
      : '自定义主题');
  const id = slugifyThemeName(name);
  const doc: CustomTerminalTheme = { id, name, theme: parsed.colors };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify(doc, null, 2), 'utf-8');
  return doc;
}

/** 读取目录下全部自定义主题，跳过缺失/损坏的文件（目录不存在返回 []） */
export async function listCustomThemes(dir: string = getCustomThemesDir()): Promise<CustomTerminalTheme[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const themes = await Promise.all(
    entries
      .filter((f) => f.endsWith('.json'))
      .map(async (f): Promise<CustomTerminalTheme | null> => {
        try {
          const doc = JSON.parse(await readFile(join(dir, f), 'utf-8')) as Record<string, unknown>;
          if (typeof doc.id !== 'string' || !isValidCustomThemeId(doc.id)) return null;
          if (typeof doc.name !== 'string' || doc.name.trim().length === 0) return null;
          const theme = sanitizeTerminalThemeColors(doc.theme);
          if (!theme) return null;
          return { id: doc.id, name: doc.name, theme };
        } catch {
          // 单个文件损坏不影响其余主题
          return null;
        }
      }),
  );
  return themes
    .filter((t): t is CustomTerminalTheme => t !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 删除自定义主题文件；ID 非法或文件不存在返回 false */
export async function deleteCustomTheme(themeId: string, dir: string = getCustomThemesDir()): Promise<boolean> {
  if (!isValidCustomThemeId(themeId)) return false;
  try {
    await unlink(join(dir, `${themeId}.json`));
    return true;
  } catch {
    return false;
  }
}
