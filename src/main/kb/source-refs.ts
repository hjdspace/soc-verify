/**
 * KB Source Refs — 修订引用根扫描（spec §1「保存仍被引用的旧修订」）。
 *
 * 引用根（谁还在引用某个 (sourceId, sourceRevision)）：
 *   1. 已发布知识页：wiki/ 下全部 Markdown 页的 frontmatter `sources:` 列表
 *      （SourceRef 最小契约：sourceId + sourceRevision + parsedHash，spec §2）。
 *   2. 页面历史：.kb/page-history/ 下的 JSON —— issue 06 定义完整格式，
 *      本模块按「JSON 内任何同时携带 sourceId 与 sourceRevision 的对象」
 *      结构化提取（所有入口携带 sourceId/revision，假阳性安全）。
 *   3. staging 提案：.kb/staging/ 下的 JSON —— 同上（issue 05 定义完整格式）。
 *
 * 方向安全性：本扫描允许假阳性（多保留一份证据，无害），绝不允许假阴性
 * （把仍被引用的证据当垃圾）。frontmatter 解析只做有界配对提取，不模拟
 * 完整 YAML；无法解析的页面视为无引用（正式 YAML 校验由编译/发布票拥有）。
 * 已知残余风险：YAML 多行值（块标量/多行字符串）中若出现行首 `---`，会被
 * 误判为 frontmatter 结束导致其后 sources 漏扫（假阴性）；发布侧应避免在
 * 多行值中输出行首 `---`，完整 YAML 解析归编译/发布票。
 *
 * 纯扫描：不写入、不移动任何库内文件。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §1、§2
 */

import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

export type SourceRevisionRef = { sourceId: string; sourceRevision: string };

/** sourceId → 引用它的 sourceRevision 集合 */
export type SourceRefIndex = Map<string, Set<string>>;

// ── 已发布页 frontmatter 提取 ───────────────────────────────────

const FRONTMATTER_SOURCES_ID = /^\s*-\s*sourceId\s*:\s*"?([^"\s]+)"?\s*$/;
const FRONTMATTER_SOURCES_REVISION = /^\s*sourceRevision\s*:\s*"?([^"\s]+)"?\s*$/;

/**
 * 从页面 Markdown 提取 frontmatter sources 引用。
 *
 * 有界提取：只认文件开头 `---` 围起的 frontmatter 块中 `sources:` 列表项，
 * 项内 `- sourceId:` 后跟 `sourceRevision:` 成对收集；围栏代码块中的伪
 * frontmatter 不会出现在文件开头围栏内（首个 `---` 之前无内容），天然忽略。
 */
export function extractSourceRefsFromMarkdown(markdown: string): SourceRevisionRef[] {
  if (!markdown.startsWith('---')) return [];
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return [];
  const frontmatter = markdown.slice(0, end);

  const refs: SourceRevisionRef[] = [];
  let inSources = false;
  let pendingId: string | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    if (/^sources\s*:/.test(line)) {
      inSources = true;
      pendingId = null;
      continue;
    }
    if (!inSources) continue;
    // 新的顶层键（非缩进）→ sources 列表结束
    if (/^[A-Za-z_][\w-]*\s*:/.test(line)) {
      inSources = false;
      pendingId = null;
      continue;
    }
    const idMatch = FRONTMATTER_SOURCES_ID.exec(line);
    if (idMatch) {
      pendingId = idMatch[1];
      continue;
    }
    const revMatch = FRONTMATTER_SOURCES_REVISION.exec(line);
    if (revMatch && pendingId !== null) {
      refs.push({ sourceId: pendingId, sourceRevision: revMatch[1] });
      pendingId = null;
    }
  }
  return refs;
}

// ── .kb/ JSON 提取 ──────────────────────────────────────────────

const MAX_JSON_WALK_DEPTH = 12;

/**
 * 递归收集 JSON 值中同时携带字符串 sourceId 与 sourceRevision 的对象。
 * 有界：深度超限即剪枝；循环引用靠深度上限安全终止。
 */
export function extractSourceRefsFromJsonValue(value: unknown, depth = 0): SourceRevisionRef[] {
  const refs: SourceRevisionRef[] = [];
  if (depth > MAX_JSON_WALK_DEPTH) return refs;
  if (Array.isArray(value)) {
    for (const item of value) {
      refs.push(...extractSourceRefsFromJsonValue(item, depth + 1));
    }
    return refs;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const { sourceId, sourceRevision } = obj;
    if (typeof sourceId === 'string' && sourceId.length > 0 && typeof sourceRevision === 'string' && sourceRevision.length > 0) {
      refs.push({ sourceId, sourceRevision });
    }
    for (const v of Object.values(obj)) {
      if (v !== null && typeof v === 'object') {
        refs.push(...extractSourceRefsFromJsonValue(v, depth + 1));
      }
    }
  }
  return refs;
}

// ── 库内汇总 ────────────────────────────────────────────────────

async function listFilesRecursive(dir: string, exts: ['.md'] | ['.json']): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full, exts)));
    } else if (exts.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function addRef(index: SourceRefIndex, ref: SourceRevisionRef): void {
  let set = index.get(ref.sourceId);
  if (!set) {
    set = new Set();
    index.set(ref.sourceId, set);
  }
  set.add(ref.sourceRevision);
}

/**
 * 汇总库内全部引用根：已发布页 frontmatter + page-history + staging。
 * 库目录不存在或任一引用根缺失时按空处理；单个损坏文件不阻断整体。
 */
export async function collectReferencedRevisions(kbPath: string): Promise<SourceRefIndex> {
  const index: SourceRefIndex = new Map();

  // 1. 已发布知识页 frontmatter
  const pages = await listFilesRecursive(join(kbPath, 'wiki'), ['.md']);
  for (const page of pages) {
    try {
      const content = await readFile(page, 'utf-8');
      for (const ref of extractSourceRefsFromMarkdown(content)) {
        addRef(index, ref);
      }
    } catch {
      // 单页不可读不阻断扫描
    }
  }

  // 2. page-history 与 staging 的 JSON fixture（完整格式由 issue 05/06 定义）
  for (const relDir of [join('.kb', 'page-history'), join('.kb', 'staging')]) {
    const files = await listFilesRecursive(join(kbPath, relDir), ['.json']);
    for (const file of files) {
      try {
        const parsed: unknown = JSON.parse(await readFile(file, 'utf-8'));
        for (const ref of extractSourceRefsFromJsonValue(parsed)) {
          addRef(index, ref);
        }
      } catch {
        // 损坏 JSON 保留现场、不阻断（与 manifest 恢复语义一致）
      }
    }
  }

  return index;
}
