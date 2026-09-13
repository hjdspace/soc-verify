/**
 * KB Proposal Blocks — FILE 提案块的有限状态解析与路径沙箱（issue 05）。
 *
 * spec §4：
 *  - FILE 协议允许多个 `---FILE: wiki/<path>.md--- ... ---END FILE---`；
 *  - 有限状态解析必须覆盖 CRLF、标记大小写、空路径、围栏内伪标记、
 *    重复路径、嵌套 opener 和流截断；跨 token 分片不影响结果；
 *  - 重复目标块报错，不使用最后一个静默覆盖；未闭合块不得作为完成文件。
 *
 * spec §4 路径校验：只接受 schema 路由内 Markdown；schema/purpose、
 * 聚合页、原件与 `.kb/` 不是 FILE 可写目标。词法校验（path-guard）
 * 之外必须做真实父目录 realpath 围栏，防 junction/symlink 逃逸。
 *
 * 「源摘要是数据而非指令」：路径沙箱只限制落盘范围，不证明生成知识可信。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §4
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateManagedRelPath, ensureRealPathWithinRoot } from './path-guard';
import { wikiLayout } from './wiki-layout';
import { RESERVED_AGGREGATE_NAMES } from './wiki-schema';
import { parseWikiSchema } from './wiki-schema';
import type { WikiPageType } from '@shared/kb-types';

// ── 类型 ────────────────────────────────────────────────────────

export type ParsedProposalFile = { path: string; content: string };

export type ParseFileProposalResult =
  | {
      ok: true;
      files: ParsedProposalFile[];
      /** 被拒绝/无法闭合的块说明（可见，不静默丢弃） */
      warnings: string[];
      /** 因截断而未闭合的路径（有界修复调用只用这些目标） */
      truncated: string[];
    }
  | { ok: false; error: { code: 'duplicateTarget'; path: string; message: string } };

// ── 有限状态解析 ────────────────────────────────────────────────

/** opener：整行 `---FILE: <path>---`（大小写不敏感，容许内部空白） */
const OPENER_LINE = /^---\s*FILE:\s*(.*?)\s*---\s*$/i;
/** closer：整行 `---END FILE---`（大小写不敏感，容许内部空白） */
const CLOSER_LINE = /^---\s*END\s+FILE\s*---\s*$/i;
/** CommonMark 围栏（≤3 空格缩进的 ``` / ~~~） */
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/;

/**
 * 解析 FILE 提案文本。
 *
 * 逐行状态机（非正则全局匹配）：先归一 CRLF；遇 opener 进入块内，
 * 块内跟踪围栏状态（围栏内的 closer 文本视为正文，不截断外层块）；
 * 遇 closer 结算块。重复路径立即报错 —— 由调用方决定整批作废，
 * 绝不用最后一个静默覆盖。
 */
export function parseFileProposal(text: string): ParseFileProposalResult {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  const files: ParsedProposalFile[] = [];
  const warnings: string[] = [];
  const truncated: string[] = [];
  const seen = new Set<string>();

  let i = 0;
  while (i < lines.length) {
    const opener = OPENER_LINE.exec(lines[i]);
    if (!opener) {
      i++;
      continue;
    }
    const path = opener[1].trim();
    i++; // 消费 opener

    const contentLines: string[] = [];
    let fenceMarker: string | null = null;
    let fenceLen = 0;
    let closed = false;

    while (i < lines.length) {
      const line = lines[i];

      const fenceMatch = FENCE_LINE.exec(line);
      if (fenceMatch) {
        const run = fenceMatch[1];
        const char = run[0];
        const len = run.length;
        if (fenceMarker === null) {
          fenceMarker = char;
          fenceLen = len;
        } else if (char === fenceMarker && len >= fenceLen) {
          fenceMarker = null;
          fenceLen = 0;
        }
        contentLines.push(line);
        i++;
        continue;
      }

      if (fenceMarker === null && CLOSER_LINE.test(line)) {
        closed = true;
        i++;
        break;
      }

      // 未闭合块内出现新的 opener：记录可见警告（嵌套 opener 不得产出
      // 半成品；新 opener 作为正文被吞掉，避免把它误当第二个文件起始）。
      if (fenceMarker === null && OPENER_LINE.test(line)) {
        warnings.push(
          `FILE 块「${path || '(匿名)'}」内出现嵌套 opener（前块未闭合），该 opener 作为正文处理。`,
        );
      }

      contentLines.push(line);
      i++;
    }

    if (!closed) {
      const label = path || '(匿名)';
      warnings.push(`FILE 块「${label}」在流结束前未闭合（可能截断），已作废，不产出文件。`);
      if (path.length > 0) truncated.push(path);
      continue;
    }

    if (path.length === 0) {
      warnings.push('FILE 块空路径已跳过（模型未在 `---FILE:` 后给出路径）。');
      continue;
    }

    if (seen.has(path)) {
      return {
        ok: false,
        error: {
          code: 'duplicateTarget',
          path,
          message: `提案中重复出现目标路径「${path}」，拒绝使用最后一个静默覆盖。`,
        },
      };
    }
    seen.add(path);
    files.push({ path, content: contentLines.join('\n') });
  }

  return { ok: true, files, warnings, truncated };
}

// ── 路径沙箱 ────────────────────────────────────────────────────

/** 聚合页与库根元数据（模型不可写目标） */
const RESERVED_PAGE_IDS = new Set<string>(RESERVED_AGGREGATE_NAMES);

/** 非 wiki/ 的受管子树（模型不可写） */
const FORBIDDEN_PREFIXES = ['raw/', '.kb/'];

export type ProposalTargetCheck = { ok: true; relPath: string } | { ok: false; reason: string };

/**
 * 校验单个 FILE 目标是否落在可写沙箱内。
 *
 * 规则（spec §4）：
 *  1. 词法：path-guard 拒绝绝对/穿越/ADS/保留名；
 *  2. 必须是 `wiki/<路由目录>/...md`，且目录属于当前 schema 路由；
 *  3. schema.md / purpose.md / 聚合页 / raw/ / .kb/ 一律拒绝；
 *  4. 真实父目录 realpath 围栏，防 junction/symlink 逃逸。
 */
export async function validateProposalTarget(
  kbPath: string,
  relPath: string,
  typeDirs: Record<WikiPageType, string>,
): Promise<ProposalTargetCheck> {
  const lexical = validateManagedRelPath(relPath);
  if (!lexical.ok) return { ok: false, reason: lexical.reason };
  const normalized = lexical.normalized;

  // 库根元数据文件：模型不可写
  if (normalized === 'schema.md' || normalized === 'purpose.md') {
    return { ok: false, reason: `schema/purpose 不是 FILE 可写目标: ${normalized}` };
  }

  // raw/ 与 .kb/ 子树：模型不可写
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return { ok: false, reason: `受管保护路径不是 FILE 可写目标: ${normalized}` };
    }
  }

  // 必须位于 wiki/
  if (!normalized.startsWith('wiki/')) {
    return { ok: false, reason: `FILE 目标必须位于 wiki/ 下: ${normalized}` };
  }

  // 只接受 Markdown
  if (!normalized.toLowerCase().endsWith('.md')) {
    return { ok: false, reason: `FILE 目标必须是 Markdown 页: ${normalized}` };
  }

  // 聚合页（wiki/index.md 等）不可写
  const pageId = normalized.slice('wiki/'.length, -3);
  const base = pageId.includes('/') ? pageId.slice(pageId.lastIndexOf('/') + 1) : pageId;
  if (!pageId.includes('/') && RESERVED_PAGE_IDS.has(base.toLowerCase())) {
    return { ok: false, reason: `聚合页不是 FILE 可写目标: ${normalized}` };
  }

  // 目录必须落在 schema 路由内。
  // 逐段比较而非截断首段：schema 路由可以写成子目录（如 `foo/bar`），
  // 若只比 `d.split('/')[0]`，`wiki/foo/x.md` 会被误判为合法路由。
  const dir = pageId.includes('/') ? pageId.slice(0, pageId.lastIndexOf('/')) : '';
  const allowed = Object.values(typeDirs).some(
    (d) => normalizeRoute(d) === dir.toLowerCase(),
  );
  if (!allowed) {
    return { ok: false, reason: `FILE 目标目录不在 schema 路由内: ${normalized}` };
  }

  // 真实父目录围栏。
  //
  // 顺序很重要：先对**已存在的最深祖先**做 realpath 校验，再创建中间目录。
  // 若先 mkdir 后校验，`wiki/<dir>` 已是库外 junction 时 mkdir 会穿透它建目录，
  // 随后 realpath 比较的是同一个已逃逸的父目录 —— 围栏恒真、形同虚设。
  const kbRoot = wikiLayout(kbPath).kbPath;
  const absPath = join(kbRoot, normalized);
  const parentAbs = dirname(absPath);

  const ancestor = await deepestExistingAncestor(parentAbs);
  if (ancestor !== null) {
    const fence = await ensureRealPathWithinRoot(kbRoot, ancestor);
    if (!fence.ok) {
      return { ok: false, reason: `目标父目录逃逸出库根: ${normalized} (${fence.reason})` };
    }
  }

  const { mkdir } = await import('node:fs/promises');
  try {
    await mkdir(parentAbs, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `创建目标父目录失败: ${normalized} (${String(err)})` };
  }

  // 创建后再复核一次：确认新建路径没有落进（或穿过）库外链接。
  const afterFence = await ensureRealPathWithinRoot(kbRoot, parentAbs);
  if (!afterFence.ok) {
    return { ok: false, reason: `目标父目录逃逸出库根: ${normalized} (${afterFence.reason})` };
  }

  return { ok: true, relPath: normalized };
}

/** schema 路由归一：分隔符统一 + 去首尾斜杠 + 小写（Windows 不敏感文件系统） */
function normalizeRoute(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

/** 从 candidate 向上找到第一个真实存在的祖先目录；全不存在时返回 null */
async function deepestExistingAncestor(candidate: string): Promise<string | null> {
  const { stat } = await import('node:fs/promises');
  let current = candidate;
  // 上限防御：异常输入不应造成无限循环
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      await stat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

/**
 * 读取库当前 schema 路由（供沙箱校验）。schema 无法解析时返回 null ——
 * 调用方必须拒绝整批提案，不能回退到无约束。
 */
export async function readTypeDirs(
  kbPath: string,
): Promise<Record<WikiPageType, string> | null> {
  const layout = wikiLayout(kbPath);
  let raw: string;
  try {
    raw = await readFile(layout.schemaMdPath, 'utf-8');
  } catch {
    return null;
  }
  const parsed = parseWikiSchema(raw);
  return parsed.ok ? parsed.routing.typeDirs : null;
}
