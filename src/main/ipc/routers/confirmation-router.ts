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
 *   - suggestConfirmation:       AI 辅助确认（阻塞式，等待完整响应）
 *   - startAISuggestion:         启动 AI 建议（流式模式，响应推送到右侧面板）
 *   - parseAISuggestion:         解析 AI 响应文本为结构化建议
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
import { tvAIAdvisor } from '../../timing-violation/ai/tv-ai-advisor';
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
   * 对待确认违例自动匹配 Pattern 并应用确认结论。
   * caseName 为空时对所有用例的待确认违例进行应用（全局应用）。
   * Pattern 匹配不依赖 corner（corner 无关），但可以可选传入 corner 过滤。
   */
  applyHistoricalConfirmations: t.procedure
    .input((raw): { projectId: string; caseName?: string; corner?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return {
        projectId: r.projectId,
        caseName: typeof r.caseName === 'string' && r.caseName ? r.caseName : undefined,
        corner: typeof r.corner === 'string' ? r.corner : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return applyHistoricalConfirmations(db, input.caseName, input.corner);
    }),

  /**
   * AI 辅助确认 — 接入 omp AI Agent 提供智能建议。
   *
   * 创建/复用项目级持久化 AI 会话，构建违例上下文（违例详情 + 历史 Pattern + 统计），
   * 发送给 AI Agent 并等待结构化 JSON 建议。
   *
   * 返回建议（confirmer/result/reason/confidence），用户确认后手动应用。
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
    .query(async ({ input }) => {
      try {
        const suggestion = await tvAIAdvisor.suggest({
          projectId: input.projectId,
          violationId: input.violationId,
        });
        return suggestion;
      } catch (err) {
        // AI 建议失败时返回空结果，不阻断用户操作
        const message = err instanceof Error ? err.message : String(err);
        console.error('[confirmation:suggestConfirmation] AI suggestion failed:', message);
        return {
          confirmer: undefined as string | undefined,
          result: undefined as string | undefined,
          reason: `AI 建议获取失败: ${message}`,
          confidence: 0,
        };
      }
    }),

  /**
   * 启动 AI 建议（流式模式）— 创建 AI Agent 会话并发送 prompt。
   *
   * 与 suggestConfirmation 不同，此 mutation 不等待 AI 响应，
   * 而是让响应通过 sessionEvent 事件流式推送到前端右侧 AI 面板。
   *
   * 返回 sessionId（供前端绑定 sessionEvent）和 promptMessage（供前端展示用户消息）。
   */
  startAISuggestion: t.procedure
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
    .mutation(async ({ input }) => {
      try {
        const result = await tvAIAdvisor.startSuggestion({
          projectId: input.projectId,
          violationId: input.violationId,
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[confirmation:startAISuggestion] AI start suggestion failed:', message);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `AI 会话创建失败: ${message}` });
      }
    }),

  /**
   * 解析 AI 响应文本为结构化建议。
   *
   * 在 AI 响应完成（agent_end 事件）后，前端将完整的 AI 响应文本发送到此
   * query，解析为 JSON 建议对象（confirmer/result/reason/confidence/analysis）。
   */
  parseAISuggestion: t.procedure
    .input((raw): { responseText: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.responseText !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'responseText is required' });
      }
      return { responseText: r.responseText };
    })
    .query(async ({ input }) => {
      return tvAIAdvisor.parseSuggestion(input.responseText);
    }),
});
