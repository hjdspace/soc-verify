/**
 * Wiki Catalog — wiki/ 页面目录扫描（只读浏览的数据源）。
 *
 * spec §2：页面目录按 pageId（类型路径 + 文件名，如
 * `concepts/axi-outstanding`）标识；标题与 basename 不作为唯一主键。
 * 依赖 schema.md 的 Page Types 路由（wiki-schema）；schema 无法解析
 * 时整体拒绝，不回退到无约束。坏 YAML / 未知或缺失类型按页报 issue，
 * 不让单页问题阻塞整库阅读。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §2
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import {
  parseWikiSchema,
  RESERVED_AGGREGATE_NAMES,
} from './wiki-schema';
import { parseWikiPage } from './wiki-page';
import { extractWikiLinks, resolveWikiTarget } from './wikilink';
import type { WikiCatalogLookup, WikiResolvedLink } from './wikilink';
import { ensureRealPathWithinRoot } from './path-guard';
import { wikiLayout } from './wiki-layout';
import type {
  WikiCatalog,
  WikiCatalogAggregate,
  WikiCatalogOrphan,
  WikiCatalogPage,
  WikiCatalogResult,
  WikiPageParseResult,
  WikiPageType,
  WikiPageView,
} from '@shared/kb-types';

// 类型契约单一源在 @shared/kb-types；此处 re-export 供既有引用方使用
export type {
  WikiCatalog,
  WikiCatalogAggregate,
  WikiCatalogOrphan,
  WikiCatalogPage,
  WikiCatalogResult,
};

/**
 * 扫描挂载库 wiki/ 目录，产出页面目录。
 * 单页读取/解析失败记录在 entry.parse，不中断扫描。
 */
export async function scanWikiCatalog(kbPath: string): Promise<WikiCatalogResult> {
  const layout = wikiLayout(kbPath);

  // schema 是路由唯一来源；读不到/解析失败整体拒绝
  let schemaRaw: string;
  try {
    schemaRaw = await readFile(layout.schemaMdPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      schemaIssues: [{
        code: 'missingPageTypes',
        message: code === 'ENOENT' ? 'schema.md 不存在' : `schema.md 读取失败 (${code ?? 'unknown'})`,
      }],
    };
  }
  const parsed = parseWikiSchema(schemaRaw);
  if (!parsed.ok) {
    return { ok: false, schemaIssues: parsed.issues };
  }
  const typeDirs = parsed.routing.typeDirs;
  // typeDirs 是 type → dir；这里需要 dir → type
  const dirToType = new Map(Object.entries(typeDirs).map(([type, dir]) => [dir.toLowerCase(), type as WikiPageType]));

  const pages: WikiCatalogPage[] = [];
  const aggregates: WikiCatalogAggregate[] = [];
  const orphans: WikiCatalogOrphan[] = [];
  const reserved = new Set<string>(RESERVED_AGGREGATE_NAMES);

  // wiki 根条目
  let rootEntries: Dirent[];
  try {
    rootEntries = await readdir(layout.wikiDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      schemaIssues: [{
        code: 'missingPageTypes',
        message: code === 'ENOENT' ? 'wiki/ 目录不存在' : `wiki/ 目录读取失败 (${code ?? 'unknown'})`,
      }],
    };
  }

  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const base = entry.name.slice(0, -3);
      if (reserved.has(base.toLowerCase())) {
        aggregates.push({
          pageId: base,
          relPath: `wiki/${entry.name}`,
          kind: 'aggregate',
        });
      } else {
        orphans.push({ relPath: `wiki/${entry.name}`, kind: 'orphan' });
      }
      continue;
    }
    if (!entry.isDirectory()) continue;

    const dirType = dirToType.get(entry.name.toLowerCase());
    if (dirType === undefined) {
      // 非路由目录：整个子树视为 orphan（后续票的建图/Lint 会复用）
      await collectFilesRecursively(join(layout.wikiDir, entry.name), entry.name, (relPath) => {
        orphans.push({ relPath: `wiki/${relPath}`, kind: 'orphan' });
      });
      continue;
    }

    // 路由目录：直接子文件按 pageId 编目（wiki/<dir>/<pageId>.md）
    const children = await readdir(join(layout.wikiDir, entry.name), { withFileTypes: true });
    for (const child of children) {
      if (!child.isFile() || !child.name.toLowerCase().endsWith('.md')) {
        // 路由目录下的子目录/非 md 文件同样视为 orphan（本票不分类）
        orphans.push({
          relPath: `wiki/${entry.name}/${child.name}`,
          kind: 'orphan',
        });
        continue;
      }
      const base = child.name.slice(0, -3);
      const pageId = `${entry.name}/${base}`;
      const relPath = `wiki/${pageId}.md`;
      const abs = join(layout.wikiDir, entry.name, child.name);
      let parse: WikiPageParseResult;
      try {
        const content = await readFile(abs, 'utf-8');
        parse = parseWikiPage(content);
      } catch (err) {
        parse = {
          ok: false,
          issues: [{
            code: 'badYaml',
            message: `页面文件读取失败: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
          }],
        };
      }
      const declaredType = parse.ok ? parse.frontmatter.type : undefined;
      pages.push({
        pageId,
        relPath,
        type: dirType,
        kind: 'page',
        parse,
        routeMismatch: declaredType !== undefined && declaredType !== dirType,
      });
    }
  }

  pages.sort((a, b) => a.pageId.localeCompare(b.pageId));
  aggregates.sort((a, b) => a.pageId.localeCompare(b.pageId));
  orphans.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return { ok: true, catalog: { typeDirs, pages, aggregates, orphans } };
}

/**
 * 从 catalog 构建链接解析查找索引（wikiCatalogLookup 契约）。
 * 只收解析成功的页面；坏页不参与链接解析。
 */
export function wikiCatalogLookup(catalog: WikiCatalog): WikiCatalogLookup {
  const byId = new Map<string, { pageId: string; title?: string }>();
  const byBasename = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();

  for (const page of catalog.pages) {
    if (!page.parse.ok) continue;
    const info = { pageId: page.pageId, title: page.parse.frontmatter.title };
    byId.set(page.pageId, info);

    const base = page.pageId.slice(page.pageId.lastIndexOf('/') + 1).toLowerCase();
    pushMulti(byBasename, base, page.pageId);
    pushMulti(byTitle, info.title, page.pageId);
  }
  return { byId, byBasename, byTitle };
}

function pushMulti(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * 按 pageId 读取单个页面（聚合页或编目页）。
 *
 * 读接口的注册库路径校验：
 *  1. pageId 必须在 catalog 中（聚合页 index/overview/log 或编目页），
 *     不存在的 pageId 直接拒绝——不做任意路径拼接；
 *  2. 读取前用 ensureRealPathWithinRoot 做 realpath 围栏，
 *     拒绝 junction/symlink 逃逸出库根（issue 01 原语复用）。
 *
 * 返回正文 + 统一解析的链接（含解析结论），供 UI 跟随规范链接。
 */
export async function readWikiPage(
  kbPath: string,
  pageId: string,
): Promise<{ ok: true; page: WikiPageView } | { ok: false; reason: 'catalogFailed' | 'unknownPage' | 'outsideRoot' | 'readFailed' }> {
  const scan = await scanWikiCatalog(kbPath);
  if (!scan.ok) return { ok: false, reason: 'catalogFailed' };

  const trimmed = pageId.trim();
  const aggregate = scan.catalog.aggregates.find((a) => a.pageId === trimmed);
  const entry = scan.catalog.pages.find((p) => p.pageId === trimmed);
  const relPath = aggregate?.relPath ?? entry?.relPath;
  if (relPath === undefined) {
    return { ok: false, reason: 'unknownPage' };
  }

  const layout = wikiLayout(kbPath);
  const absPath = join(layout.kbPath, relPath);
  const guard = await ensureRealPathWithinRoot(layout.kbPath, absPath);
  if (!guard.ok) {
    return { ok: false, reason: 'outsideRoot' };
  }

  let content: string;
  try {
    content = await readFile(absPath, 'utf-8');
  } catch {
    return { ok: false, reason: 'readFailed' };
  }

  const parse = parseWikiPage(content);
  const lookup = wikiCatalogLookup(scan.catalog);
  const links: WikiResolvedLink[] = extractWikiLinks(content).map((occ) => {
    // 纯本页 heading 链接（target 为空）不做跨页解析
    const resolution = occ.kind === 'link' && occ.target.length > 0
      ? resolveWikiTarget(occ.target, lookup)
      : ({ status: 'unresolved' } as const);
    return { ...occ, resolution };
  });

  return {
    ok: true,
    page: {
      pageId: trimmed,
      relPath,
      kind: aggregate ? 'aggregate' : 'page',
      content,
      parse,
      ...(entry?.routeMismatch ? { routeMismatch: true } : {}),
      links,
    },
  };
}

async function collectFilesRecursively(
  dir: string,
  relPrefix: string,
  fn: (relPath: string) => void,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 不可读的 orphan 子树静默跳过——目录状态由健康检查另行报告
  }
  for (const entry of entries) {
    const rel = `${relPrefix}/${entry.name}`;
    const abs = join(dir, entry.name);
    try {
      const s = await stat(abs);
      if (s.isDirectory()) {
        await collectFilesRecursively(abs, rel, fn);
      } else if (s.isFile()) {
        fn(rel);
      }
    } catch {
      // stat 失败的条目跳过
    }
  }
}
