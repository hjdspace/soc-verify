/**
 * Wiki Link — `[[target|alias]]` wikilink 的统一抽取与解析。
 *
 * spec §2：主进程提供一个解析实现供图谱、Lint、检索与 UI 消费：
 *  - 忽略围栏代码块、行内代码、转义（`\[\[`）；
 *  - 图片 embed（`![[...]]`）单独标记，不混入页面引用边
 *    （frontmatter 的来源引用是证据边，图扩展只消费已解析的页面引用边）；
 *  - 裸名（无 `/` 的 target）仅在唯一命中（basename 或标题）时解析，
 *    歧义显式报告全部候选，禁止取第一个（spec 对参考 R11 的修正点）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §2
 */

import type {
  WikiCatalogEntryInfo,
  WikiCatalogLookup,
  WikiLinkKind,
  WikiLinkOccurrence,
  WikiLinkResolution,
  WikiResolvedLink,
} from '@shared/kb-types';

// 类型契约单一源在 @shared/kb-types；此处 re-export 供既有引用方使用
export type {
  WikiCatalogEntryInfo,
  WikiCatalogLookup,
  WikiLinkKind,
  WikiLinkOccurrence,
  WikiLinkResolution,
  WikiResolvedLink,
};

// ── 抽取 ────────────────────────────────────────────────────────

// `![[target|alias]]` 图片/文件 embed 与 `[[target#heading|alias]]` 页面引用
// 合并为一个正则：单趟扫描，天然保持出现顺序；embed 分支由 `!` 前缀区分
const WIKI_MARKUP_RE = /(!?)\[\[([^\]|\n]*)(?:\|([^\]\n]*))?\]\]/g;

/**
 * 从 markdown 正文抽取全部 wikilink / embed 出现位置（按出现顺序）。
 * 围栏代码块（``` 或 ~~~）、行内代码（`…`）与转义 `\[\[` 内的出现一律忽略。
 */
export function extractWikiLinks(content: string): WikiLinkOccurrence[] {
  const out: WikiLinkOccurrence[] = [];
  forOutsideCode(content, (text) => {
    WIKI_MARKUP_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_MARKUP_RE.exec(text)) !== null) {
      const kind: WikiLinkKind = m[1] === '!' ? 'embed' : 'link';
      const rawTarget = (m[2] ?? '').trim();
      const aliasRaw = m[3];
      const hash = rawTarget.indexOf('#');
      let target: string;
      let heading: string | undefined;
      if (hash >= 0) {
        target = rawTarget.slice(0, hash);
        heading = rawTarget.slice(hash + 1);
      } else {
        target = rawTarget;
      }
      out.push({
        kind,
        target,
        ...(heading !== undefined ? { heading } : {}),
        ...(aliasRaw !== undefined && aliasRaw.trim().length > 0 ? { alias: aliasRaw.trim() } : {}),
      });
    }
  });
  return out;
}

/**
 * 在围栏代码块与行内代码之外执行回调。
 * 嵌套围栏用「同级围栏配对」简化（与参考 R11 一致：``` 与 ~~~ 各自配对）。
 */
function forOutsideCode(content: string, fn: (text: string) => void): void {
  // 1) 围栏代码块：奇数段是围栏内容，跳过
  const fenceParts = content.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  for (let i = 0; i < fenceParts.length; i += 2) {
    // 2) 行内代码：奇数段是行内代码，跳过
    const inlineParts = fenceParts[i].split(/(`[^`\n]*`)/g);
    for (let j = 0; j < inlineParts.length; j += 2) {
      // 3) 转义 \[\[ / \]\]：用占位符替换，避免被匹配
      const text = inlineParts[j]
        .replace(/\\\[\\\[/g, '\u0001ESC-LBRACKET\u0001')
        .replace(/\\\]\\\]/g, '\u0001ESC-RBRACKET\u0001');
      fn(text);
    }
  }
}

// ── 解析（类型定义见 @shared/kb-types）─────────────────────────

/**
 * 解析单个链接 target。
 *
 * 顺序：完整 pageId 精确命中 → 裸名 basename 唯一命中 → 标题唯一命中。
 * 多命中 = ambiguous（全部候选返回，绝不取第一个）。
 */
export function resolveWikiTarget(target: string, lookup: WikiCatalogLookup): WikiLinkResolution {
  let name = target.trim();
  if (name.length === 0) return { status: 'unresolved' };

  // `[[page.md]]` 形式剥掉 .md 后缀
  if (name.toLowerCase().endsWith('.md')) {
    name = name.slice(0, -3);
  }
  if (name.length === 0) return { status: 'unresolved' };

  // 1) 完整 pageId
  if (lookup.byId.has(name)) {
    return { status: 'resolved', pageId: name };
  }

  // 含 `/` 的 target 只按 pageId 解析——路径错就是 unresolved，不做 basename 兜底
  if (name.includes('/')) {
    return { status: 'unresolved' };
  }

  // 2) 裸名 basename（大小写不敏感；Windows 文件名语义）
  const byBase = lookup.byBasename.get(name.toLowerCase());
  if (byBase && byBase.length === 1) {
    return { status: 'resolved', pageId: byBase[0] };
  }
  if (byBase && byBase.length > 1) {
    return { status: 'ambiguous', candidates: [...byBase] };
  }

  // 3) 标题（精确）
  const byTitle = lookup.byTitle.get(name);
  if (byTitle && byTitle.length === 1) {
    return { status: 'resolved', pageId: byTitle[0] };
  }
  if (byTitle && byTitle.length > 1) {
    return { status: 'ambiguous', candidates: [...byTitle] };
  }

  return { status: 'unresolved' };
}
