/**
 * Pattern Matcher — 精确匹配 + 模糊匹配
 *
 * 参考 Python models.py 中 `_find_matching_pattern` / `get_pattern_suggestions` 的逻辑。
 *
 * 匹配策略（优先级从高到低）：
 * 1. 精确匹配：hier + check_info 完全相同
 * 2. 模糊匹配：标准化 check_info 后比较（normalizeCheckInfo）
 *
 * Pattern 匹配不依赖 corner（corner 无关）。
 */

import type Database from 'better-sqlite3';
import { normalizeCheckInfo } from './pattern-normalizer';
import type { ViolationPattern } from '../types';

/** Pattern 匹配结果 */
export type PatternMatchResult = {
  pattern: ViolationPattern;
  matched: 'exact' | 'fuzzy';
};

/**
 * 对给定的 hier + check_info，在 Pattern 表中查找匹配。
 *
 * 先尝试精确匹配，未命中再尝试模糊匹配。
 * Pattern 匹配不依赖 corner（corner 无关）。
 *
 * @returns 匹配结果，未找到返回 null
 */
export function findMatchingPattern(
  db: Database.Database,
  hier: string,
  checkInfo: string,
): PatternMatchResult | null {
  // 1. 精确匹配：hier + check_info 完全相同
  const exactRow = db.prepare(`
    SELECT id, hier_pattern, check_pattern,
           default_confirmer, default_result, default_reason,
           match_count, last_used
    FROM violation_patterns
    WHERE hier_pattern = ? AND check_pattern = ?
    ORDER BY last_used DESC
    LIMIT 1
  `).get(hier, checkInfo) as Record<string, unknown> | undefined;

  if (exactRow) {
    return {
      pattern: rowToPattern(exactRow),
      matched: 'exact',
    };
  }

  // 2. 模糊匹配：标准化 check_info 后比较
  const normalizedCheck = normalizeCheckInfo(checkInfo);

  // 获取所有相同 hier 的 Pattern
  const fuzzyRows = db.prepare(`
    SELECT id, hier_pattern, check_pattern,
           default_confirmer, default_result, default_reason,
           match_count, last_used
    FROM violation_patterns
    WHERE hier_pattern = ?
    ORDER BY last_used DESC
  `).all(hier) as Record<string, unknown>[];

  for (const row of fuzzyRows) {
    const patternCheck = row['check_pattern'] as string;
    const normalizedPattern = normalizeCheckInfo(patternCheck);

    if (normalizedPattern === normalizedCheck) {
      return {
        pattern: rowToPattern(row),
        matched: 'fuzzy',
      };
    }
  }

  return null;
}

/**
 * 获取 Pattern 建议（对外暴露的 API，供 tRPC pattern.getPatternSuggestion 调用）。
 */
export function getPatternSuggestion(
  db: Database.Database,
  hier: string,
  check: string,
): { pattern: ViolationPattern; matchType: 'exact' | 'fuzzy' } | null {
  const result = findMatchingPattern(db, hier, check);
  if (!result) return null;
  return { pattern: result.pattern, matchType: result.matched };
}

// ─── 内部辅助 ─────────────────────────────────────────────────

function rowToPattern(row: Record<string, unknown>): ViolationPattern {
  return {
    id: row['id'] as number,
    hierPattern: row['hier_pattern'] as string,
    checkPattern: row['check_pattern'] as string,
    defaultConfirmer: (row['default_confirmer'] as string | null) ?? null,
    defaultResult: (row['default_result'] as string | null) ?? null,
    defaultReason: (row['default_reason'] as string | null) ?? null,
    matchCount: row['match_count'] as number,
    lastUsed: row['last_used'] as string,
  };
}
