/**
 * Wiki Rules — 写作规则（schema.md / purpose.md）读取与保存。
 *
 * spec §2：
 *  - purpose 与写作正文可改；
 *  - schema 的 `## Page Types` 受约束表保存前必须通过完整校验
 *    （类型完整唯一、目录唯一、无保留聚合路径）；
 *  - 已有页面的类型路由重映射需要专门迁移——本期保存时**拒绝**
 *    这种变更并解释受影响页面；
 *  - 仅写作要求变更使编译缓存失效，不自动触发全库付费重编
 *    （缓存失效由后继编译票依据 schema hash 变化处理，本模块不触发）。
 *
 * 写入经 writeFileAtomic（复用 issue 01 原语）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §2
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { wikiLayout } from './wiki-layout';
import { writeFileAtomic } from './atomic-commit';
import { parseWikiSchema } from './wiki-schema';
import type {
  WikiPageType,
  WikiRulesSaveInput,
  WikiRulesSaveOutcome,
  WikiRulesView,
} from '@shared/kb-types';

// 历史命名对齐：模块内部沿用 SaveResult，即 shared 的 WikiRulesSaveOutcome
type WikiRulesSaveResult = WikiRulesSaveOutcome;
export type { WikiRulesSaveInput, WikiRulesSaveOutcome };

// ── 读取（类型定义见 @shared/kb-types）─────────────────────────

export async function readWikiRules(kbPath: string): Promise<WikiRulesView> {
  const layout = wikiLayout(kbPath);
  const [schemaRaw, purposeRaw] = await Promise.all([
    readFileOrNull(layout.schemaMdPath),
    readFileOrNull(layout.purposeMdPath),
  ]);
  const schemaParse = schemaRaw === null
    ? { ok: false as const, issues: [{ code: 'missingPageTypes' as const, message: 'schema.md 不存在' }] }
    : parseWikiSchema(schemaRaw);
  return { schemaRaw, purposeRaw, schemaParse };
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

// ── 保存（类型定义见 @shared/kb-types）─────────────────────────

/**
 * 保存写作规则。
 *
 * schema 流程：解析校验 → 与当前路由 diff，对每个类型目录变更检查
 * 旧目录/新目录下是否已有页面（存在 = 需要专门迁移的重映射，本期拒绝）
 * → 全部通过后原子写盘。purpose 原文任意写。
 */
export async function saveWikiRules(kbPath: string, input: WikiRulesSaveInput): Promise<WikiRulesSaveResult> {
  const layout = wikiLayout(kbPath);
  let savedSchema = false;
  let savedPurpose = false;

  if (input.schemaRaw !== undefined) {
    const parsed = parseWikiSchema(input.schemaRaw);
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          code: 'schemaInvalid',
          message: `schema.md 校验失败（${parsed.issues.length} 个问题），未保存`,
          issues: parsed.issues,
        },
      };
    }

    // 当前路由（schema 缺失/损坏 → 视为空映射，保存即修复，无重映射可言）
    const current = await readWikiRules(kbPath);
    const currentDirs: Partial<Record<WikiPageType, string>> =
      current.schemaParse.ok ? current.schemaParse.routing.typeDirs : {};

    const newDirs = parsed.routing.typeDirs;
    for (const type of Object.keys(newDirs) as WikiPageType[]) {
      const oldDir = currentDirs[type];
      const newDir = newDirs[type];
      if (oldDir === undefined || oldDir.toLowerCase() === newDir.toLowerCase()) continue;

      // 目录变更：旧目录或新目录下已有页面 → 需要专门迁移，本期拒绝
      const affected: string[] = [
        ...(await listPageIds(kbPath, oldDir)),
        ...(await listPageIds(kbPath, newDir)),
      ];
      if (affected.length > 0) {
        return {
          ok: false,
          error: {
            code: 'pageDirRemap',
            message: [
              `类型「${type}」的目录从「${oldDir}」改为「${newDir}」会影响已有页面，需要专门的迁移流程，本期不支持：`,
              `受影响页面（${affected.length} 个）：${affected.slice(0, 10).join('、')}${affected.length > 10 ? ' …' : ''}`,
              '如需变更目录，请先移出或清空相关目录下的页面。',
            ].join('\n'),
          },
        };
      }
    }

    await writeFileAtomic(layout.schemaMdPath, input.schemaRaw);
    savedSchema = true;
  }

  if (input.purposeRaw !== undefined) {
    await writeFileAtomic(layout.purposeMdPath, input.purposeRaw);
    savedPurpose = true;
  }

  return { ok: true, saved: { schema: savedSchema, purpose: savedPurpose } };
}

/** 列出某路由目录下的页面 pageId（`<dir>/<文件名去 .md>`，含子目录） */
async function listPageIds(kbPath: string, dir: string): Promise<string[]> {
  const layout = wikiLayout(kbPath);
  const out: string[] = [];
  await walk(join(layout.wikiDir, dir), dir);
  return out;

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return; // 目录不存在 = 无页面
    }
    for (const entry of entries) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(rel.slice(0, -3));
      } else if (entry.isDirectory()) {
        await walk(join(absDir, entry.name), rel);
      }
    }
  }
}
