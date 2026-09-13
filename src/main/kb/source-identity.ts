/**
 * KB Source Identity — 来源身份规则（spec §1 身份规则）。
 *
 * - sourcePath：相对 raw/sources/ 的规范路径，持久化统一 `/` 分隔、
 *   NFC 归一显示拼写；词法合法性由 path-guard 把关（绝对路径/穿越/
 *   盘符/UNC/ADS/保留名/尾点尾空格一律拒绝）。
 * - sourceId：规范化完整相对路径（含目录与扩展名）的 SHA256。
 *   `a/report.pdf`、`b/report.pdf`、`a/report.docx` 是三个来源；
 *   绝不再用不含扩展名的 docName。
 * - 碰撞检测：Windows 大小写等价 + NFC 归一后比较（sourceCollisionKey），
 *   保留显示拼写；大小写不同但等价的两个导入是碰撞，不是两个来源。
 * - 直接 Markdown/text 导入：不调用 anydoc，按 UTF-8 文本保存机械全文，
 *   输出 `<sourcePath>.md`（如 `notes.md.md`），无隐式特例。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §1
 */

import { createHash } from 'node:crypto';
import { validateManagedRelPath } from './path-guard';

/** 直接文本导入的扩展名（小写含点）。这些来源不调用 anydoc。 */
export const TEXT_IMPORT_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.txt'];

export type NormalizeSourcePathResult =
  | { ok: true; /** NFC 归一、`/` 分隔的规范相对路径（显示拼写） */ normalized: string }
  | { ok: false; reason: string };

/**
 * 规范化来源相对路径：NFC 归一 → path-guard 词法校验 → 统一 `/`。
 */
export function normalizeSourcePath(raw: unknown): NormalizeSourcePathResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: '来源路径必须是字符串' };
  }
  const nfc = raw.normalize('NFC');
  const check = validateManagedRelPath(nfc);
  if (!check.ok) {
    return { ok: false, reason: check.reason };
  }
  return { ok: true, normalized: check.normalized };
}

/** sourceId：规范化完整相对路径（含目录与扩展名，内部强制 NFC）的 SHA256（hex）。 */
export function sourceIdFor(normalizedSourcePath: string): string {
  return createHash('sha256').update(normalizedSourcePath.normalize('NFC'), 'utf-8').digest('hex');
}

/**
 * 碰撞检测键：NFC 归一 + Windows 大小写折叠。
 * 两个导入该键相同但 sourceId 不同 → 大小写等价碰撞，拒绝并提示。
 */
export function sourceCollisionKey(normalizedSourcePath: string): string {
  return normalizedSourcePath.normalize('NFC').toLowerCase();
}

/** 是否直接文本导入（跳过 anydoc，按 UTF-8 保存机械全文）。 */
export function isTextImportExtension(ext: string): boolean {
  return TEXT_IMPORT_EXTENSIONS.includes(ext.toLowerCase());
}
