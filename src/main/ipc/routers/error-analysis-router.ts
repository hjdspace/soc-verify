/**
 * Error analysis router — list active sessions, get status, analyze errors, get log paths.
 */

import { t, TRPCError } from '../router-context';
import { errorAnalysisCoordinator } from '../../simulation/error-analysis-coordinator';
import { logAnalyzer } from '../../simulation/log-analyzer';
import { projectManager } from '../../project/project-manager';
import type { ErrorAnalysisSession } from '@shared/types';

export const errorAnalysisRouter = t.router({
  /**
   * 获取所有活跃的错误分析会话
   */
  listActive: t.procedure
    .input((raw): { projectId?: string } => {
      const r = raw as Record<string, unknown>;
      return { projectId: typeof r.projectId === 'string' ? r.projectId : undefined };
    })
    .query(({ input }) => {
      const sessions = errorAnalysisCoordinator.getActiveSessions();
      return input.projectId
        ? sessions.filter((s: ErrorAnalysisSession) => s.projectId === input.projectId)
        : sessions;
    }),

  /**
   * 获取特定错误分析会话状态
   */
  getStatus: t.procedure
    .input((raw): { sessionId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
      }
      return { sessionId: r.sessionId };
    })
    .query(({ input }) => {
      const session = errorAnalysisCoordinator.getSession(input.sessionId);
      if (!session) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Error analysis session not found: ${input.sessionId}` });
      }
      return session;
    }),

  /**
   * 分析指定用例的错误类型和上下文（不创建 AI 会话）
   */
  analyzeErrors: t.procedure
    .input((raw): { caseName: string; cwd?: string; projectId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.caseName !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'caseName is required' });
      }
      return {
        caseName: r.caseName,
        cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
        projectId: typeof r.projectId === 'string' ? r.projectId : undefined,
      };
    })
    .query(({ input }) => {
      // Resolve cwd from projectId if not provided
      let cwd = input.cwd;
      if (!cwd && input.projectId) {
        const project = projectManager.getProject(input.projectId);
        cwd = project?.rootPath;
      }
      const result = logAnalyzer.analyzeErrors(input.caseName, cwd);
      return result;
    }),

  /**
   * 获取编译/仿真日志路径
   */
  getLogPaths: t.procedure
    .input((raw): { caseName: string; cwd?: string; projectId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.caseName !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'caseName is required' });
      }
      return {
        caseName: r.caseName,
        cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
        projectId: typeof r.projectId === 'string' ? r.projectId : undefined,
      };
    })
    .query(({ input }) => {
      let cwd = input.cwd;
      if (!cwd && input.projectId) {
        const project = projectManager.getProject(input.projectId);
        cwd = project?.rootPath;
      }
      return {
        compileLogPath: logAnalyzer.getCompileLogPath(input.caseName, cwd),
        simLogPath: logAnalyzer.getSimulationLogPath(input.caseName, cwd),
      };
    }),
});
