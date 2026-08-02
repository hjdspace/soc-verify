/**
 * ErrorAnalysisSessionFactory — 创建错误分析 AI Agent 会话的工厂。
 *
 * 从 ErrorAnalysisCoordinator 中提取，封装会话创建 + 工具注册 + prompt 发送的完整流程。
 * Coordinator 只负责事件监听和重试追踪，会话创建委托给此工厂。
 */

import type { sessionManager } from '../agent/session-manager';
import { loadSessions } from '../agent/session-persistence';
import type { pluginLoader } from '../plugins/loader';
import type { credentialManager } from '../credentials/credential-manager';
import type { ErrorType } from '@shared/types';
import { PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage } from '../plugin-adapters';
import { getSystemPrompt, buildPromptMessage } from './error-analysis-prompts';
import { runsimRetryToolDefinition, executeRunsimRetry } from './runsim-retry-tool';

export type SessionFactoryDeps = {
  sessionManager: typeof sessionManager;
  pluginLoader: typeof pluginLoader;
  credentialManager: typeof credentialManager;
};

export type CreateSessionParams = {
  projectId: string;
  caseName: string;
  errorType: ErrorType;
  cwd: string;
  errorContext: string;
  command?: string;
  maxRetries: number;
  /** Called when AI invokes runsim_retry — used by coordinator to track retries. */
  onRetry?: (caseName: string, sessionId: string) => void;
  /** Model ID to use for the session. When provided, the session manager
   *  skips fetching the model list from the API, avoiding network errors
   *  when the endpoint is temporarily unreachable. */
  model?: string;
};

export class ErrorAnalysisSessionFactory {
  private readonly deps: SessionFactoryDeps;

  constructor(deps: SessionFactoryDeps) {
    this.deps = deps;
  }

  /**
   * Create an AI Agent session for error analysis.
   * Returns the sessionId of the newly created session.
   */
  async createSession(params: CreateSessionParams): Promise<string> {
    const { projectId, caseName, errorType, cwd, errorContext, command, maxRetries, model } = params;

    const systemPrompt = getSystemPrompt(errorType);

    // Create adapters from plugin registry
    const registry = this.deps.pluginLoader.getRegistry(cwd);
    const discovery = new PluginBackedDiscovery(cwd, registry);
    const simulation = new PluginBackedSimulation(registry);
    const coverage = new PluginBackedCoverage(cwd, registry);

    // Reuse the model selected in the AI page. The renderer persists that
    // selection alongside the session, so error analysis must use the same
    // provider credential instead of always taking the first configured one.
    const persistedSessions = await loadSessions(cwd);
    const persistedModel = [...persistedSessions]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .find((session) => session.model?.id)?.model;

    // Load credentials
    const credEnv = await this.deps.credentialManager.buildEnvForAgent();
    const selectedCred = persistedModel?.providerId
      ? await this.deps.credentialManager.get(persistedModel.providerId)
      : await this.deps.credentialManager.getDefaultCredential();
    const provider = persistedModel?.provider
      ?? (selectedCred
        ? this.deps.credentialManager.mapProviderForAgent(selectedCred.providerId)
        : undefined);
    const apiKey = selectedCred?.apiKey;
    const baseUrl = selectedCred?.baseUrl;
    const selectedModel = model ?? persistedModel?.id;

    // Create the session — pass the model (if available from an existing
    // session) so that createSession does NOT need to fetch the model list
    // from the API. This avoids "fetch failed" errors when the endpoint is
    // temporarily unreachable, and ensures the AI analysis reuses the same
    // model the user has already configured.
    const sessionId = await this.deps.sessionManager.createSession({
      projectId,
      cwd,
      provider,
      model: selectedModel,
      apiKey,
      baseUrl,
      discovery,
      simulationAdapter: simulation,
      coverageAdapter: coverage,
      env: credEnv,
      systemPrompt,
    });

    // Register runsim_retry tool for compile error sessions
    if (errorType === 'compile_error') {
      const sessionEntry = this.deps.sessionManager.getSession(sessionId);
      if (sessionEntry) {
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
            params.onRetry?.(caseName, sessionId);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          },
        );
      }
    }

    // Send the initial prompt
    const promptMessage = buildPromptMessage({
      caseName,
      errorType,
      errorContext,
      command,
      maxRetries,
    });

    const client = this.deps.sessionManager.getClient(sessionId);
    if (client) {
      await client.prompt(promptMessage);
    }

    return sessionId;
  }
}
