/**
 * KB Path Guard — 受管相对路径的词法校验与真实路径围栏。
 *
 * 知识库内所有受管路径（来源 sourcePath、知识页 pageId、事务目标等）
 * 都是相对库根的路径，由应用推导落盘位置。本模块是唯一入口：
 *
 * 1. 词法校验（validateManagedRelPath）——在触碰磁盘前拒绝：
 *    绝对路径、盘符相对（`C:foo`）、UNC/device（`\\.`、`\\?`）、
 *    ADS 冒号（`page.md:stream`）、`..` 穿越、NUL/控制字符、
 *    Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名形式）、
 *    尾点/尾空格、空段（`a//b`）。
 * 2. 真实路径围栏（ensureRealPathWithinRoot）——对已存在路径解析
 *    realpath，确认仍位于库根内，防 junction/symlink 逃逸。
 *
 * 词法校验只限制落盘范围，不能证明内容可信；提交前（rename 前）
 * 必须再做一次真实路径检查（见 atomic-commit）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §4（路径校验）
 */

import { isAbsolute, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

// ── Windows 保留名 ──────────────────────────────────────────────

/**
 * Windows 保留设备名（不区分大小写；后面紧跟扩展名同样保留）。
 * COM0/LPT0 与上标数字变体（COM¹ 等）未纳入本清单，见 issue 01 spike 待验证项。
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// ── 词法校验 ────────────────────────────────────────────────────

export type PathCheckResult =
  | { ok: true; /** 规范化后的相对路径（统一 `/` 分隔） */ normalized: string }
  | { ok: false; reason: string };

/**
 * 校验受管相对路径。
 *
 * 接受 `wiki/concepts/axi-outstanding.md`、`raw/sources/a/spec.pdf` 这类
 * 相对路径（允许 Unicode 与空格的非首尾位置）；拒绝任何形式的
 * 绝对化、穿越与 Windows 非法文件名。
 */
export function validateManagedRelPath(relPath: string): PathCheckResult {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    return { ok: false, reason: '路径为空' };
  }

  // NUL 与控制字符（0x00–0x1F）在任何位置都非法
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(relPath)) {
    return { ok: false, reason: `路径包含控制字符: ${JSON.stringify(relPath)}` };
  }

  // 绝对路径：POSIX 根、盘符根、UNC/device（`\\`、`//` 开头）
  // 盘符相对（`C:foo`）与 ADS（任意位置冒号）一并由冒号规则拒绝
  if (isAbsolute(relPath) || relPath.includes(':')) {
    return { ok: false, reason: `路径不是库内相对路径（绝对路径/盘符/UNC/ADS）: ${relPath}` };
  }

  // 统一分隔符后分段校验
  const segments = relPath.replace(/\\/g, '/').split('/');
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0) {
      return { ok: false, reason: `路径包含空段（连续分隔符或首尾分隔符）: ${relPath}` };
    }
    if (segment === '.' || segment === '..') {
      return { ok: false, reason: `路径包含穿越段「${segment}」: ${relPath}` };
    }
    // 尾点/尾空格：Windows 会静默剥离，造成路径歧义
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return { ok: false, reason: `路径段以点或空格结尾: ${relPath}` };
    }
    // 保留名：取第一个扩展名之前的 stem，不区分大小写
    const stem = (segment.split('.', 1)[0] ?? segment).toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      return { ok: false, reason: `路径段使用 Windows 保留名「${stem}」: ${relPath}` };
    }
    normalized.push(segment);
  }

  return { ok: true, normalized: normalized.join('/') };
}

// ── 真实路径围栏 ────────────────────────────────────────────────

export type RealPathCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * 确认已存在的 absPath（目录或文件）解析 realpath 后仍位于 rootDir 内。
 *
 * 用于防 junction/symlink 逃逸：词法上合法的 `link/x.md` 若 `link`
 * 是指向库外的 junction，会被此处拒绝。调用方需保证 absPath 已存在
 * （新建目标先创建父目录再校验父目录）。
 */
export async function ensureRealPathWithinRoot(
  rootDir: string,
  absPath: string,
): Promise<RealPathCheckResult> {
  let realRoot: string;
  let realPath: string;
  try {
    [realRoot, realPath] = await Promise.all([realpath(rootDir), realpath(absPath)]);
  } catch (err) {
    return { ok: false, reason: `realpath 解析失败: ${absPath} (${String(err)})` };
  }
  return isInsideRoot(realRoot, realPath);
}

function isInsideRoot(realRoot: string, realPath: string): RealPathCheckResult {
  // Windows 大小写不敏感；realpath 返回盘上真实大小写，仍做不敏感比较兜底
  const norm = process.platform === 'win32'
    ? (p: string) => p.toLowerCase()
    : (p: string) => p;
  const root = norm(realRoot);
  const child = norm(realPath);
  if (child === root) return { ok: true };
  if (child.startsWith(root + sep) || child.startsWith(root + '/')) {
    return { ok: true };
  }
  return { ok: false, reason: `路径逃逸出受管根: ${realPath} 不位于 ${realRoot} 内` };
}
