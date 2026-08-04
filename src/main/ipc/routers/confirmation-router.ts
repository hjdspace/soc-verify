/**
 * Confirmation Router — tRPC API
 *
 * 参考 docs/timing-violation-handoff.md §4.4
 *
 * Procedures:
 *   - autoConfirmByResetTime:    复位时间自动确认
 *   - autoConfirmByInterval:     复位时间+区间自动确认（OR 关系）
 *   - updateConfirmation:        手动确认单条
 *   - batchUpdateConfirmations:  批量确认
 *   - suggestConfirmation:       AI 辅助确认（预留接口）
 */

import { t, TRPCError } from '../router-context';
import { getTvDb } from '../../timing-violation/db/tv-db-cache';
import {
  autoConfirmByResetTime,
  autoConfirmByInterval,
  updateConfirmation,
  batchUpdateConfirmations,
  applyHistoricalConfirmations,
} from '../../timing-violation/confirm/confirmation-manager';
import type { ConfirmationStatus } from '../../timing-violation/types';

// ─── 状态白名单 ───────────────────────────────────────────────

const VALID_STATUSES: readonly ConfirmationStatus[] = ['pending', 'confirmed', 'ignored'] as const;
const VALID_RESULTS = ['pass', 'issue'] as const;

// ─── Router ───────────────────────────────────────────────────

export const confirmationRouter = t.router({
  /**
   * 复位时间自动确认。
   * 自动确认 time_fs <= resetTimeNs * 1000000 且 status='pending' 的违例。
   * caseName 为空时对所有用例进行确认（全局自动确认）。
   */
  autoConfirmByResetTime: t.procedure
    .input((raw): { projectId: string; caseName?: string; resetTimeNs: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.resetTimeNs !== 'number' || r.resetTimeNs < 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'resetTimeNs must be a non-negative number' });
      }
      return {
        projectId: r.projectId,
        caseName: typeof r.caseName === 'string' && r.caseName ? r.caseName : undefined,
        resetTimeNs: r.resetTimeNs,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return autoConfirmByResetTime(db, input.caseName, input.resetTimeNs);
    }),

  /**
   * 复位时间 + 复位区间自动确认（OR 关系）。
   * 支持同时使用复位时间和复位区间条件。
   * caseName 为空时对所有用例进行确认（全局自动确认）。
   */
  autoConfirmByInterval: t.procedure
    .input((raw): {
      projectId: string;
      caseName?: string;
      resetTimeNs?: number;
      intervalStartNs?: number;
      intervalEndNs?: number;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return {
        projectId: r.projectId,
        caseName: typeof r.caseName === 'string' && r.caseName ? r.caseName : undefined,
        resetTimeNs: typeof r.resetTimeNs === 'number' ? r.resetTimeNs : undefined,
        intervalStartNs: typeof r.intervalStartNs === 'number' ? r.intervalStartNs : undefined,
        intervalEndNs: typeof r.intervalEndNs === 'number' ? r.intervalEndNs : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return autoConfirmByInterval(
        db,
        input.caseName,
        input.resetTimeNs,
        input.intervalStartNs,
        input.intervalEndNs,
      );
    }),

  /**
   * 手动确认单条违例。
   * 确认后自动保存 Pattern 到 violation_patterns 表。
   */
  updateConfirmation: t.procedure
    .input((raw): {
      projectId: string;
      violationId: number;
      status: ConfirmationStatus;
      confirmer: string;
      result: string;
      reason: string;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.violationId !== 'number' || r.violationId <= 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'violationId must be a positive number' });
      }
      if (!VALID_STATUSES.includes(r.status as ConfirmationStatus)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      if (!VALID_RESULTS.includes(r.result as typeof VALID_RESULTS[number])) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `result must be one of: ${VALID_RESULTS.join(', ')}` });
      }
      return {
        projectId: r.projectId,
        violationId: r.violationId,
        status: r.status as ConfirmationStatus,
        confirmer: typeof r.confirmer === 'string' ? r.confirmer : '',
        result: r.result as string,
        reason: typeof r.reason === 'string' ? r.reason : '',
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return updateConfirmation(
        db,
        input.violationId,
        input.status,
        input.confirmer,
        input.result,
        input.reason,
      );
    }),

  /**
   * 批量确认多条违例。
   * 每条违例都会自动保存 Pattern。
   */
  batchUpdateConfirmations: t.procedure
    .input((raw): {
      projectId: string;
      violationIds: number[];
      status: ConfirmationStatus;
      confirmer: string;
      result: string;
      reason: string;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (!Array.isArray(r.violationIds) || r.violationIds.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'violationIds must be a non-empty array' });
      }
      if (!VALID_STATUSES.includes(r.status as ConfirmationStatus)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      if (!VALID_RESULTS.includes(r.result as typeof VALID_RESULTS[number])) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `result must be one of: ${VALID_RESULTS.join(', ')}` });
      }
      return {
        projectId: r.projectId,
        violationIds: r.violationIds as number[],
        status: r.status as ConfirmationStatus,
        confirmer: typeof r.confirmer === 'string' ? r.confirmer : '',
        result: r.result as string,
        reason: typeof r.reason === 'string' ? r.reason : '',
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return batchUpdateConfirmations(
        db,
        input.violationIds,
        input.status,
        input.confirmer,
        input.result,
        input.reason,
      );
    }),

  /**
   * 一键应用历史确认模式。
   * 对指定用例的待确认违例，自动匹配 Pattern 并应用确认结论。
   * Pattern 匹配不依赖 corner（corner 无关），但可以可选传入 corner 过滤。
   */
  applyHistoricalConfirmations: t.procedure
    .input((raw): { projectId: string; caseName: string; corner?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.caseName !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'caseName is required' });
      }
      return {
        projectId: r.projectId,
        caseName: r.caseName,
        corner: typeof r.corner === 'string' ? r.corner : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return applyHistoricalConfirmations(db, input.caseName, input.corner);
    }),

  /**
   * AI 辅助确认（预留接口）。
   * 当前返回空结果骨架，后续可接入 omp AI Agent。
   */
  suggestConfirmation: t.procedure
    .input((raw): { projectId: string; violationId: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.violationId !== 'number' || r.violationId <= 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'violationId must be a positive number' });
      }
      return { projectId: r.projectId, violationId: r.violationId };
    })
    .query(async () => {
      // AI 预留接口 — 当前返回空结果骨架
      return {
        confirmer: undefined as string | undefined,
        result: undefined as string | undefined,
        reason: undefined as string | undefined,
        confidence: 0,
      };
    }),
});
