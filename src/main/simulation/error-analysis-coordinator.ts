/**
 * ErrorAnalysisCoordinator — 仿真失败自动 AI 分析协调器
 *
 * 监听 simulationRegistry 和 simTerminalLinker 的 run:completed 事件，
 * 检测 FAIL 状态后委托 ErrorAnalysisSessionFactory 创建分析会话。
 *
 * 职责：
 * 1. 事件监听（background + terminal 双通道）
 * 2. 错误类型判定（委托 logAnalyzer）
 * 3. 重试次数追踪（最大 3 次）
 * 4. 会话生命周期管理（创建/状态更新/移除）
 *
 * 会话创建 + 工具注册 + prompt 发送 → ErrorAnalysisSessionFactory
 * Prompt 模板 → error-analysis-prompts.ts
 */

import { EventEmitter } from 'node:events';
import { logAnalyzer } from './log-analyzer';
import { simulationRegistry } from './simulation-registry';
import { simTerminalLinker } from './sim-terminal-linker';
import { sessionManager } from '../agent/session-manager';
import { pluginLoader } from '../plugins/loader';
import { credentialManager } from '../credentials/credential-manager';
import { ErrorAnalysisSessionFactory } from './error-analysis-session-factory';
import { projectManager } from '../project/project-manager';

/**
 * Dependencies required by the coordinator.
 *
 * All six are module-level singletons in production, but accepting them as
 * constructor parameters makes the coordinator unit-testable without spinning
 * up the entire application.
 */
type CoordinatorDeps = {
  logAnalyzer: typeof logAnalyzer;
  simulationRegistry: typeof simulationRegistry;
  simTerminalLinker: typeof simTerminalLinker;
  sessionManager: typeof sessionManager;
  pluginLoader: typeof pluginLoader;
  credentialManager: typeof credentialManager;
};
import type {
  ErrorType,
  ErrorAnalysisSession,
  ErrorAnalysisStatus,
} from '@shared/types';
import type { SimulationRunRecord } from './simulation-manager';
import type { TerminalSimRun } from './sim-terminal-linker';

const MAX_RETRIES = 3;

// ─── Coordinator ─────────────────────────────────────────────

interface CoordinatorSessionEntry {
  sessionId: string;
  projectId: string;
  caseName: string;
  errorType: ErrorType;
  status: ErrorAnalysisStatus;
  retryCount: number;
  createdAt: number;
  sourceRunId?: string;
  cwd?: string;
  command?: string;
}

class ErrorAnalysisCoordinatorImpl extends EventEmitter {
  private sessions = new Map<string, CoordinatorSessionEntry>();
  /** caseName → retryCount, tracks retry attempts per case */
  private retryTracker = new Map<string, number>();
  private listenersRegistered = false;
  private readonly deps: CoordinatorDeps;
  private readonly sessionFactory: ErrorAnalysisSessionFactory;

  constructor(deps?: Partial<CoordinatorDeps>) {
    super();
    this.deps = {
      logAnalyzer: deps?.logAnalyzer ?? logAnalyzer,
      simulationRegistry: deps?.simulationRegistry ?? simulationRegistry,
      simTerminalLinker: deps?.simTerminalLinker ?? simTerminalLinker,
      sessionManager: deps?.sessionManager ?? sessionManager,
      pluginLoader: deps?.pluginLoader ?? pluginLoader,
      credentialManager: deps?.credentialManager ?? credentialManager,
    };
    this.sessionFactory = new ErrorAnalysisSessionFactory({
      sessionManager: this.deps.sessionManager,
      pluginLoader: this.deps.pluginLoader,
      credentialManager: this.deps.credentialManager,
    });
  }

  /**
   * Register event listeners for both simulation execution paths.
   * Called once during application startup.
   */
  registerListeners(): void {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;

    // Listen to background simulation completions
    this.deps.simulationRegistry.on('run:completed', (record: SimulationRunRecord) => {
      void this.handleRunCompletion({
        runId: record.runId,
        projectId: record.projectId,
        caseName: record.options.caseName ?? record.options.caseId,
        caseId: record.options.caseId,
        subsys: record.options.subsys,
        status: record.status.status,
        cwd: record.options.projectRoot,
        command: undefined, // background runs don't have terminal commands
        source: 'background',
      });
    });

    // Listen to terminal simulation completions
    this.deps.simTerminalLinker.on('run:completed', (run: TerminalSimRun) => {
      void this.handleRunCompletion({
        runId: run.runId,
        projectId: run.projectId,
        caseName: run.caseName ?? run.caseId,
        caseId: run.caseId,
        subsys: run.subsys,
        status: run.status,
        cwd: run.cwd,
        command: run.command,
        source: 'terminal',
      });
    });
  }

  /**
   * Handle a simulation run completion.
   * Only triggers analysis for FAIL/ERROR status.
   */
  private async handleRunCompletion(params: {
    runId: string;
    projectId: string;
    caseName: string;
    caseId: string;
    subsys: string;
    status: string;
    cwd?: string;
    command?: string;
    source: 'background' | 'terminal';
  }): Promise<void> {
    const { runId, projectId, caseName, status, cwd, command } = params;

    // Only trigger on FAIL or ERROR
    if (status !== 'fail' && status !== 'error') return;

    console.log(`[error-analysis] FAIL detected: case=${caseName}, runId=${runId}, source=${params.source}`);

    // Check retry count
    const currentRetries = this.retryTracker.get(caseName) ?? 0;
    if (currentRetries >= MAX_RETRIES) {
      console.log(`[error-analysis] Max retries (${MAX_RETRIES}) reached for case=${caseName}, stopping`);
      this.emit('errorAnalysis:stopped', {
        caseName,
        reason: 'max_retries_reached',
        retryCount: currentRetries,
      });
      return;
    }

    // Resolve project root for cwd
    const projectRoot = cwd ?? this.resolveProjectRoot(projectId);
    if (!projectRoot) {
      console.error(`[error-analysis] Cannot resolve project root for projectId=${projectId}`);
      return;
    }

    // Ensure plugins are loaded
    const loadResults = this.deps.pluginLoader.getLoadResults(projectRoot);
    if (loadResults.length === 0) {
      await this.deps.pluginLoader.loadPlugins(projectRoot);
    }

    // Step 1: Determine error type
    const { errorType, errorContext, compileLogPath, simLogPath } =
      this.deps.logAnalyzer.analyzeErrors(caseName, projectRoot);

    console.log(`[error-analysis] errorType=${errorType}, compileLog=${compileLogPath}, simLog=${simLogPath}`);

    // Step 2: Create AI Agent session via factory
    try {
      const sessionId = await this.sessionFactory.createSession({
        projectId,
        caseName,
        errorType,
        cwd: projectRoot,
        errorContext,
        command,
        maxRetries: MAX_RETRIES,
        onRetry: (name, sid) => {
          const count = this.retryTracker.get(name) ?? 0;
          this.retryTracker.set(name, count + 1);
          this.emit('errorAnalysis:retrying', {
            sessionId: sid,
            caseName: name,
            retryCount: count + 1,
            maxRetries: MAX_RETRIES,
          });
        },
      });

      // Track the session
      const entry: CoordinatorSessionEntry = {
        sessionId,
        projectId,
        caseName,
        errorType,
        status: 'analyzing',
        retryCount: currentRetries,
        createdAt: Date.now(),
        sourceRunId: runId,
        cwd: projectRoot,
        command,
      };
      this.sessions.set(sessionId, entry);

      // Emit event for renderer
      this.emit('errorAnalysis:started', {
        sessionId,
        projectId,
        caseName,
        errorType,
        retryCount: currentRetries,
        maxRetries: MAX_RETRIES,
        sourceRunId: runId,
      });

      console.log(`[error-analysis] session created: sessionId=${sessionId}, case=${caseName}`);
    } catch (err) {
      console.error(`[error-analysis] Failed to create session: ${err instanceof Error ? err.message : String(err)}`);
      this.emit('errorAnalysis:failed', {
        caseName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Resolve project root from projectId.
   */
  private resolveProjectRoot(projectId: string): string | undefined {
    const project = projectManager.getProject(projectId);
    return project?.rootPath;
  }

  /**
   * Get all active error analysis sessions.
   */
  getActiveSessions(): ErrorAnalysisSession[] {
    return Array.from(this.sessions.values()).map((e) => ({
      sessionId: e.sessionId,
      projectId: e.projectId,
      caseName: e.caseName,
      errorType: e.errorType,
      status: e.status,
      retryCount: e.retryCount,
      maxRetries: MAX_RETRIES,
      createdAt: e.createdAt,
      sourceRunId: e.sourceRunId,
    }));
  }

  /**
   * Get a specific error analysis session.
   */
  getSession(sessionId: string): ErrorAnalysisSession | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    return {
      sessionId: entry.sessionId,
      projectId: entry.projectId,
      caseName: entry.caseName,
      errorType: entry.errorType,
      status: entry.status,
      retryCount: entry.retryCount,
      maxRetries: MAX_RETRIES,
      createdAt: entry.createdAt,
      sourceRunId: entry.sourceRunId,
    };
  }

  /**
   * Update session status (called when AI completes or retries).
   */
  updateSessionStatus(sessionId: string, status: ErrorAnalysisStatus): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.status = status;
      this.emit('errorAnalysis:statusChanged', {
        sessionId,
        caseName: entry.caseName,
        status,
      });
    }
  }

  /**
   * Remove a completed/failed session from tracking.
   */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Manually trigger error analysis for a specific case.
   * Useful for retry or manual invocation.
   */
  async triggerAnalysis(params: {
    projectId: string;
    caseName: string;
    cwd?: string;
    command?: string;
    sourceRunId?: string;
  }): Promise<string | null> {
    const projectRoot = params.cwd ?? this.resolveProjectRoot(params.projectId);
    if (!projectRoot) return null;

    const { errorType, errorContext } = this.deps.logAnalyzer.analyzeErrors(
      params.caseName,
      projectRoot,
    );

    const sessionId = await this.sessionFactory.createSession({
      projectId: params.projectId,
      caseName: params.caseName,
      errorType,
      cwd: projectRoot,
      errorContext,
      command: params.command,
      maxRetries: MAX_RETRIES,
      onRetry: (name, sid) => {
        const count = this.retryTracker.get(name) ?? 0;
        this.retryTracker.set(name, count + 1);
        this.emit('errorAnalysis:retrying', {
          sessionId: sid,
          caseName: name,
          retryCount: count + 1,
          maxRetries: MAX_RETRIES,
        });
      },
    });

    const entry: CoordinatorSessionEntry = {
      sessionId,
      projectId: params.projectId,
      caseName: params.caseName,
      errorType,
      status: 'analyzing',
      retryCount: this.retryTracker.get(params.caseName) ?? 0,
      createdAt: Date.now(),
      sourceRunId: params.sourceRunId,
      cwd: projectRoot,
      command: params.command,
    };
    this.sessions.set(sessionId, entry);

    this.emit('errorAnalysis:started', {
      sessionId,
      projectId: params.projectId,
      caseName: params.caseName,
      errorType,
      retryCount: entry.retryCount,
      maxRetries: MAX_RETRIES,
      sourceRunId: params.sourceRunId,
    });

    return sessionId;
  }
}

export const errorAnalysisCoordinator = new ErrorAnalysisCoordinatorImpl();
