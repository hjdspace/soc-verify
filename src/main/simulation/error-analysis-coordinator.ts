/**
 * ErrorAnalysisCoordinator — 仿真失败自动 AI 分析协调器
 *
 * 监听 simulationRegistry 和 simTerminalLinker 的 run:completed 事件，
 * 检测 FAIL 状态后自动触发错误分析流程：
 *
 * 1. 判定错误类型（编译错误 / 仿真错误）
 * 2. 提取错误上下文
 * 3. 创建独立的 AI Agent 会话
 * 4. 发送错误上下文作为首条消息
 * 5. 跟踪重试次数（最大 3 次）
 *
 * 编译错误 → AI 自动修复代码 + 调用 runsim_retry 重新仿真
 * 仿真错误 → AI 给出修复建议（不修改文件）
 *
 * 每个失败的 case 拥有独立的 AI Agent 会话，支持并行处理。
 */

import { EventEmitter } from 'node:events';
import { logAnalyzer } from './log-analyzer';
import { simulationRegistry } from './simulation-registry';
import { simTerminalLinker } from './sim-terminal-linker';
import { sessionManager } from '../agent/session-manager';
import { pluginLoader } from '../plugins/loader';
import { credentialManager } from '../credentials/credential-manager';
import { PluginBackedDiscovery } from '../host/plugin-discovery';
import { PluginBackedSimulation } from '../host/plugin-discovery';
import { PluginBackedCoverage } from '../host/plugin-discovery';
import { HostToolsRegistry } from '../host/host-tools';
import { runsimRetryToolDefinition, executeRunsimRetry } from './runsim-retry-tool';
import type {
  ErrorType,
  ErrorAnalysisSession,
  ErrorAnalysisStatus,
} from '@shared/types';
import type { SimulationRunRecord } from './simulation-manager';
import type { TerminalSimRun } from './sim-terminal-linker';

const MAX_RETRIES = 3;

// ─── System Prompt 模板 ───────────────────────────────────────

const COMPILE_ERROR_SYSTEM_PROMPT = `You are an EDA verification expert specializing in SystemVerilog and hardware verification.

Your task:
1. Analyze the compilation errors provided in the context
2. Identify the root cause of each error
3. Fix the source code files by editing them directly
4. After fixing, call the runsim_retry tool to re-run the simulation and verify the fix

Important guidelines:
- Focus on fixing the actual compilation errors, not style issues
- Preserve the original intent of the code
- If multiple files need fixing, fix them all before re-running
- Use the runsim_retry tool with the case name and working directory provided`;

const SIM_ERROR_SYSTEM_PROMPT = `You are an EDA verification expert specializing in SystemVerilog and UVM methodology.

Your task:
1. Analyze the simulation errors provided in the context
2. Identify the root cause of each error (UVM_ERROR, UVM_FATAL, assertion failures, etc.)
3. Provide specific fix recommendations with code snippets

Important guidelines:
- Do NOT modify any files in this session — only provide analysis and recommendations
- Explain WHY the error occurs, not just WHAT to change
- Provide code snippets showing the recommended fix
- If the error is a testbench issue, suggest specific changes
- If the error is a DUT issue, describe what might be wrong in the design`;

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

  constructor() {
    super();
  }

  /**
   * Register event listeners for both simulation execution paths.
   * Called once during application startup.
   */
  registerListeners(): void {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;

    // Listen to background simulation completions
    simulationRegistry.on('run:completed', (record: SimulationRunRecord) => {
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
    simTerminalLinker.on('run:completed', (run: TerminalSimRun) => {
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
    const loadResults = pluginLoader.getLoadResults(projectRoot);
    if (loadResults.length === 0) {
      await pluginLoader.loadPlugins(projectRoot);
    }

    // Step 1: Determine error type
    const { errorType, errorContext, compileLogPath, simLogPath } =
      logAnalyzer.analyzeErrors(caseName, projectRoot);

    console.log(`[error-analysis] errorType=${errorType}, compileLog=${compileLogPath}, simLog=${simLogPath}`);

    // Step 2: Create AI Agent session
    try {
      const sessionId = await this.createErrorAnalysisSession({
        projectId,
        caseName,
        errorType,
        cwd: projectRoot,
        errorContext,
        command,
        sourceRunId: runId,
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
   * Create an AI Agent session for error analysis.
   * Reuses sessionManager.createSession() with error-type-specific system prompt.
   */
  private async createErrorAnalysisSession(params: {
    projectId: string;
    caseName: string;
    errorType: ErrorType;
    cwd: string;
    errorContext: string;
    command?: string;
    sourceRunId?: string;
  }): Promise<string> {
    const { projectId, caseName, errorType, cwd, errorContext, command } = params;

    // Build system prompt based on error type
    const systemPrompt =
      errorType === 'compile_error'
        ? COMPILE_ERROR_SYSTEM_PROMPT
        : SIM_ERROR_SYSTEM_PROMPT;

    // Set up discovery and simulation adapters
    const registry = pluginLoader.getRegistry(cwd);
    const discovery = new PluginBackedDiscovery(cwd, registry);
    const simulation = new PluginBackedSimulation(registry);
    const coverage = new PluginBackedCoverage(cwd, registry);

    // Load credentials
    const credEnv = await credentialManager.buildEnvForAgent();
    const defaultCred = await credentialManager.getDefaultCredential();
    const provider = defaultCred
      ? credentialManager.mapProviderForAgent(defaultCred.providerId)
      : undefined;
    const apiKey = defaultCred?.apiKey;
    const baseUrl = defaultCred?.baseUrl;

    // Create the session
    const sessionId = await sessionManager.createSession({
      projectId,
      cwd,
      provider,
      model: undefined,
      apiKey,
      baseUrl,
      discovery,
      simulationAdapter: simulation,
      coverageAdapter: coverage,
      env: credEnv,
      systemPrompt,
    });

    // Register runsim_retry tool for compile error sessions
    const sessionEntry = sessionManager.getSession(sessionId);
    if (sessionEntry && errorType === 'compile_error') {
      sessionEntry.hostTools.registerCustom(
        runsimRetryToolDefinition.name,
        runsimRetryToolDefinition.description,
        runsimRetryToolDefinition.parameters,
        async (args: Record<string, unknown>) => {
          const result = await executeRunsimRetry({
            case: typeof args.case === 'string' ? args.case : caseName,
            command: typeof args.command === 'string' ? args.command : command,
            cwd: typeof args.cwd === 'string' ? args.cwd : cwd,
            projectId,
            mode: typeof args.mode === 'string' ? (args.mode as 'terminal' | 'background') : 'terminal',
          });
          // Track the retry
          const currentCount = this.retryTracker.get(caseName) ?? 0;
          this.retryTracker.set(caseName, currentCount + 1);
          this.emit('errorAnalysis:retrying', {
            sessionId,
            caseName,
            retryCount: currentCount + 1,
            maxRetries: MAX_RETRIES,
          });
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        },
      );
    }

    // Build the error analysis prompt message
    const promptMessage = this.buildPromptMessage({
      caseName,
      errorType,
      errorContext,
      command,
    });

    // Send the error context as the first message
    const client = sessionManager.getClient(sessionId);
    if (client) {
      await client.prompt(promptMessage);
    }

    return sessionId;
  }

  /**
   * Build the prompt message to send to the AI Agent.
   */
  private buildPromptMessage(params: {
    caseName: string;
    errorType: ErrorType;
    errorContext: string;
    command?: string;
  }): string {
    const { caseName, errorType, errorContext, command } = params;

    const parts: string[] = [
      `## 仿真失败错误分析请求`,
      ``,
      `**用例名称**: ${caseName}`,
    ];

    if (command) {
      parts.push(`**执行命令**: \`${command}\``);
    }

    parts.push(
      `**错误类型**: ${errorType === 'compile_error' ? '编译错误' : '仿真错误'}`,
      ``,
      `### 错误上下文`,
      ``,
      '```',
      errorContext,
      '```',
      ``,
    );

    if (errorType === 'compile_error') {
      parts.push(
        `请分析上述编译错误，修复源代码文件，然后调用 runsim_retry 工具重新运行仿真验证修复效果。`,
        `如果修复后仍有编译错误，继续修复直到编译通过。`,
        `最多重试 ${MAX_RETRIES} 次。`,
      );
    } else {
      parts.push(
        `请分析上述仿真错误，给出详细的修复建议。`,
        `包括：错误原因分析、推荐修复方案、相关代码片段。`,
        `注意：本会话仅提供分析建议，不需要修改文件。`,
      );
    }

    return parts.join('\n');
  }

  /**
   * Resolve project root from projectId.
   */
  private resolveProjectRoot(projectId: string): string | undefined {
    // Lazy import to avoid circular dependency
    const { projectManager } = require('../project/project-manager');
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

    const { errorType, errorContext } = logAnalyzer.analyzeErrors(
      params.caseName,
      projectRoot,
    );

    const sessionId = await this.createErrorAnalysisSession({
      projectId: params.projectId,
      caseName: params.caseName,
      errorType,
      cwd: projectRoot,
      errorContext,
      command: params.command,
      sourceRunId: params.sourceRunId,
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
