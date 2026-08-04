/**
 * Pattern Router — tRPC API
 *
 * 参考 docs/timing-violation-handoff.md §4.4
 *
 * Procedures:
 *   - getPatterns:        获取所有 Pattern 列表
 *   - getPatternSuggestion: 获取 Pattern 建议（精确/模糊匹配）
 *   - savePattern:        手动保存 Pattern
 *   - clearAllPatterns:   清除所有 Pattern
 */

import { t, TRPCError } from '../router-context';
import { getTvDb } from '../../timing-violation/db/tv-db-cache';
import { getPatterns, clearAllPatterns } from '../../timing-violation/db/tv-repository';
import { savePattern } from '../../timing-violation/confirm/confirmation-manager';
import { getPatternSuggestion } from '../../timing-violation/confirm/pattern-matcher';

// ─── Router ───────────────────────────────────────────────────

export const patternRouter = t.router({
  /**
   * 获取所有 Pattern 列表。
   */
  getPatterns: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return getPatterns(db);
    }),

  /**
   * 获取 Pattern 建议（精确/模糊匹配）。
   */
  getPatternSuggestion: t.procedure
    .input((raw): { projectId: string; hier: string; check: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.hier !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'hier is required' });
      }
      if (typeof r.check !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'check is required' });
      }
      return { projectId: r.projectId, hier: r.hier, check: r.check };
    })
    .query(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return getPatternSuggestion(db, input.hier, input.check);
    }),

  /**
   * 手动保存 Pattern。
   */
  savePattern: t.procedure
    .input((raw): {
      projectId: string;
      hier: string;
      check: string;
      confirmer: string;
      result: string;
      reason: string;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.hier !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'hier is required' });
      }
      if (typeof r.check !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'check is required' });
      }
      return {
        projectId: r.projectId,
        hier: r.hier,
        check: r.check,
        confirmer: typeof r.confirmer === 'string' ? r.confirmer : '',
        result: typeof r.result === 'string' ? r.result : 'pass',
        reason: typeof r.reason === 'string' ? r.reason : '',
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      savePattern(db, input.hier, input.check, input.confirmer, input.result, input.reason);
      return { success: true };
    }),

  /**
   * 清除所有 Pattern。
   */
  clearAllPatterns: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return clearAllPatterns(db);
    }),
});
