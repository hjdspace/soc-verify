/**
 * TV AI Advisor — 时序违例 AI 建议协调器
 *
 * 参考 ErrorAnalysisCoordinator + ErrorAnalysisSessionFactory 的设计模式。
 *
 * 职责：
 * 1. 管理项目级持久化 AI Agent 会话（Map<projectId, sessionId>）
 * 2. 注册 TV 专用 Host Tools（查询违例数据、Pattern、统计）
 * 3. 构建违例上下文，发送 prompt，捕获 AI 响应
 * 4. 解析 AI 返回的 JSON 建议，返回结构化结果
 *
 * 会话生命周期：
 * - 首次调用 suggestConfirmation 时创建会话
 * - 后续调用复用同一会话（共享上下文）
 * - 会话由 sessionManager 的 idle timeout 自动清理
 */

import type Database from 'better-sqlite3';
import { sessionManager } from '../../agent/session-manager';
import { pluginLoader } from '../../plugins/loader';
import { credentialManager } from '../../credentials/credential-manager';
import { projectManager } from '../../project/project-manager';
import { loadSessions } from '../../agent/session-persistence';
import { PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage } from '../../plugin-adapters';
import { getTvDb } from '../db/tv-db-cache';
import { loadTvConfig } from '../tv-config';
import { getPatterns } from '../db/tv-repository';
import { createTVTools } from './tv-ai-tools';
import { TV_AI_SYSTEM_PROMPT, buildSuggestPrompt } from './tv-ai-prompts';

/** AI 建议返回类型 */
export type TVAISuggestion = {
  confirmer: string | undefined;
  result: string | undefined;
  reason: string | undefined;
  confidence: number;
  analysis?: string;
};

/** AI 建议请求参数 */
export type SuggestParams = {
  projectId: string;
  violationId: number;
};

/** startSuggestion 返回类型 */
export type StartSuggestionResult = {
  sessionId: string;
  promptMessage: string;
};

/** 默认 AI 响应超时（ms） */
const AI_RESPONSE_TIMEOUT_MS = 120_000;

class TVAIAdvisorImpl {
  /** 项目级持久化会话映射 */
  private sessionMap = new Map<string, string>();

  /**
   * 启动 AI 建议 — 创建/复用会话并发送 prompt，返回 sessionId 和 promptMessage。
   *
   * 与 suggest() 不同，此方法不等待 AI 响应，而是让响应通过 sessionEvent
   * 事件流式推送到前端右侧面板，用户可以实时看到 AI 的分析和回复过程。
   *
   * 返回 sessionId 供前端绑定 sessionEvent 事件流，promptMessage 供前端
   * 在右侧面板展示发送给 AI 的消息内容。
   */
  async startSuggestion(params: SuggestParams): Promise<StartSuggestionResult> {
    const { projectId, violationId } = params;

    // 获取项目信息
    const project = projectManager.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // 获取数据库实例
    const db = getTvDb(projectId);

    // 获取/创建 AI 会话
    const sessionId = await this.getOrCreateSession(projectId, project.rootPath);

    // 构建上下文
    const context = this.buildContext(db, violationId, project.rootPath);

    // 构建 prompt
    const promptMessage = buildSuggestPrompt(context);

    // 发送 prompt（fire-and-forget — 响应通过 sessionEvent 流式推送）
    const client = sessionManager.getClient(sessionId);
    if (!client) {
      throw new Error(`AI session client not found: ${sessionId}`);
    }
    await client.prompt(promptMessage);

    return { sessionId, promptMessage };
  }

  /**
   * 为指定违例获取 AI 确认建议（阻塞式，等待完整响应）。
   *
   * 此方法保留用于向后兼容。新代码应使用 startSuggestion + parseSuggestion。
   *
   * 流程：
   * 1. 获取/创建项目级 AI 会话
   * 2. 查询违例详情、历史 Pattern、统计信息
   * 3. 构建 prompt 并发送
   * 4. 等待 AI 响应（带超时）
   * 5. 解析 JSON 响应并返回
   */
  async suggest(params: SuggestParams): Promise<TVAISuggestion> {
    const { projectId, violationId } = params;

    // 获取项目信息
    const project = projectManager.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // 获取数据库实例
    const db = getTvDb(projectId);

    // 获取/创建 AI 会话
    const sessionId = await this.getOrCreateSession(projectId, project.rootPath);

    // 构建上下文（传入 projectRoot 用于加载配置）
    const context = this.buildContext(db, violationId, project.rootPath);

    // 构建 prompt
    const promptMessage = buildSuggestPrompt(context);

    // 发送 prompt 并等待响应
    const responseText = await this.sendPromptAndWait(sessionId, promptMessage);

    // 解析 AI 响应
    return this.parseSuggestion(responseText);
  }

  /**
   * 获取或创建项目级 AI 会话。
   */
  private async getOrCreateSession(projectId: string, projectRoot: string): Promise<string> {
    // 检查是否已有持久化会话
    const existingSessionId = this.sessionMap.get(projectId);
    if (existingSessionId) {
      // 验证会话是否仍然活跃
      const session = sessionManager.getSession(existingSessionId);
      if (session) {
        return existingSessionId;
      }
      // 会话已失效，清理
      this.sessionMap.delete(projectId);
    }

    // 创建新会话
    const sessionId = await this.createSession(projectId, projectRoot);
    this.sessionMap.set(projectId, sessionId);
    return sessionId;
  }

  /**
   * 创建 AI Agent 会话（注册 TV 专用工具）。
   *
   * 参考 ErrorAnalysisSessionFactory.createSession() 的凭证加载和会话创建逻辑。
   */
  private async createSession(projectId: string, cwd: string): Promise<string> {
    // 从已持久化的会话中复用模型配置
    const persistedSessions = await loadSessions(cwd);
    const persistedModel = [...persistedSessions]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .find((session) => session.model?.id)?.model;

    // 加载凭证
    const credEnv = await credentialManager.buildEnvForAgent();
    const selectedCred = persistedModel?.providerId
      ? await credentialManager.get(persistedModel.providerId)
      : await credentialManager.getDefaultCredential();
    const provider = persistedModel?.provider
      ?? (selectedCred
        ? credentialManager.mapProviderForAgent(selectedCred.providerId)
        : undefined);
    const apiKey = selectedCred?.apiKey;
    const baseUrl = selectedCred?.baseUrl;
    const model = persistedModel?.id;

    // 创建 plugin adapters
    const registry = pluginLoader.getRegistry(cwd);
    const discovery = new PluginBackedDiscovery(cwd, registry);
    const simulation = new PluginBackedSimulation(registry);
    const coverage = new PluginBackedCoverage(cwd, registry);

    // 创建会话
    const sessionId = await sessionManager.createSession({
      projectId,
      cwd,
      provider,
      model,
      apiKey,
      baseUrl,
      discovery,
      simulationAdapter: simulation,
      coverageAdapter: coverage,
      env: credEnv,
      systemPrompt: TV_AI_SYSTEM_PROMPT,
    });

    // 注册 TV 专用工具（在 hostTools 上注册，AI 可通过 tool_call 调用）
    // 参考 ErrorAnalysisSessionFactory 中注册 runsim_retry 的模式
    const db = getTvDb(projectId);
    const tvTools = createTVTools(db);
    const sessionEntry = sessionManager.getSession(sessionId);
    if (sessionEntry) {
      for (const tool of tvTools) {
        sessionEntry.hostTools.registerCustom(
          tool.definition.name,
          tool.definition.description,
          tool.definition.parameters,
          tool.handler,
        );
      }
    }

    return sessionId;
  }

  /**
   * 构建违例上下文（违例详情 + Pattern + 统计）。
   */
  private buildContext(
    db: Database.Database,
    violationId: number,
    projectRoot: string,
  ): {
    violation: {
      id: number;
      caseName: string;
      corner: string | null;
      seed: string | null;
      subsys: string | null;
      num: number;
      hier: string;
      timeFs: number;
      timeDisplay: string;
      checkInfo: string;
      filePath: string;
    };
    patterns: Array<{
      hierPattern: string;
      checkPattern: string;
      defaultConfirmer: string | null;
      defaultResult: string | null;
      defaultReason: string | null;
      matchCount: number;
    }>;
    stats: {
      totalByHier: number;
      confirmedByHier: number;
      passCount: number;
      issueCount: number;
    };
    config: {
      defaultResetTimeNs: number;
    };
  } {
    // 查询违例详情
    const violationRow = db.prepare(`
      SELECT v.id, v.case_name, v.corner, v.seed, v.subsys, v.num,
             v.hier, v.time_fs, v.time_display, v.check_info, v.file_path
      FROM timing_violations v
      WHERE v.id = ?
    `).get(violationId) as Record<string, unknown> | undefined;

    if (!violationRow) {
      throw new Error(`Violation not found: ${violationId}`);
    }

    const violation = {
      id: violationRow['id'] as number,
      caseName: violationRow['case_name'] as string,
      corner: (violationRow['corner'] as string | null) ?? null,
      seed: (violationRow['seed'] as string | null) ?? null,
      subsys: (violationRow['subsys'] as string | null) ?? null,
      num: violationRow['num'] as number,
      hier: violationRow['hier'] as string,
      timeFs: violationRow['time_fs'] as number,
      timeDisplay: violationRow['time_display'] as string,
      checkInfo: violationRow['check_info'] as string,
      filePath: violationRow['file_path'] as string,
    };

    // 查询同 hier 的历史 Pattern
    const allPatterns = getPatterns(db);
    const patterns = allPatterns
      .filter((p) => p.hierPattern === violation.hier)
      .map((p) => ({
        hierPattern: p.hierPattern,
        checkPattern: p.checkPattern,
        defaultConfirmer: p.defaultConfirmer,
        defaultResult: p.defaultResult,
        defaultReason: p.defaultReason,
        matchCount: p.matchCount,
      }));

    // 查询同 hier 的统计信息
    const statsRow = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN COALESCE(c.status, 'pending') = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
             SUM(CASE WHEN c.result = 'pass' THEN 1 ELSE 0 END) as pass_count,
             SUM(CASE WHEN c.result = 'issue' THEN 1 ELSE 0 END) as issue_count
      FROM timing_violations v
      LEFT JOIN confirmation_records c ON v.id = c.violation_id
      WHERE v.hier = ?
    `).get(violation.hier) as Record<string, number>;

    // 加载配置
    const config = loadTvConfig(projectRoot);

    return {
      violation,
      patterns,
      stats: {
        totalByHier: statsRow['total'] ?? 0,
        confirmedByHier: statsRow['confirmed'] ?? 0,
        passCount: statsRow['pass_count'] ?? 0,
        issueCount: statsRow['issue_count'] ?? 0,
      },
      config: {
        defaultResetTimeNs: config.defaultResetTimeNs,
      },
    };
  }

  /**
   * 发送 prompt 并等待 AI 响应。
   *
   * 由于 client.prompt() 是 fire-and-forget，需要通过 sessionEvent 事件捕获响应。
   */
  private async sendPromptAndWait(sessionId: string, message: string): Promise<string> {
    const client = sessionManager.getClient(sessionId);
    if (!client) {
      throw new Error(`AI session client not found: ${sessionId}`);
    }

    // 设置事件监听器，等待 assistant 的 message_end 事件
    const responsePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sessionManager.removeListener('sessionEvent', handler);
        reject(new Error('AI 响应超时'));
      }, AI_RESPONSE_TIMEOUT_MS);

      const handler = (data: { sessionId: string; event: unknown }) => {
        if (data.sessionId !== sessionId) return;

        const evt = data.event as Record<string, unknown>;
        if (evt.type !== 'message_end') return;

        const msg = evt.message as Record<string, unknown> | undefined;
        if (!msg || msg.role !== 'assistant') return;

        // 提取文本内容
        let text = '';
        const content = msg.content;
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'object' && block !== null) {
              const b = block as Record<string, unknown>;
              if (b.type === 'text' && typeof b.text === 'string') {
                text += b.text;
              }
            }
          }
        }

        // 检查错误
        const errMsg = typeof msg.errorMessage === 'string' ? msg.errorMessage : '';
        if (errMsg) {
          clearTimeout(timeout);
          sessionManager.removeListener('sessionEvent', handler);
          reject(new Error(`AI 响应错误: ${errMsg}`));
          return;
        }

        if (text) {
          clearTimeout(timeout);
          sessionManager.removeListener('sessionEvent', handler);
          resolve(text);
        }
      };

      sessionManager.on('sessionEvent', handler);
    });

    // 发送 prompt（fire-and-forget）
    await client.prompt(message);

    // 等待响应
    return responsePromise;
  }

  /**
   * 解析 AI 返回的建议 JSON（公开方法，供前端在收到完整响应后调用）。
   *
   * AI 的响应可能包含 markdown 代码块包裹的 JSON，需要提取并解析。
   */
  parseSuggestion(responseText: string): TVAISuggestion {
    // 1. 尝试直接解析
    try {
      const parsed = JSON.parse(responseText);
      return this.validateSuggestion(parsed);
    } catch {
      // 不是纯 JSON，继续尝试
    }

    // 2. 尝试从 markdown 代码块中提取
    const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1].trim());
        return this.validateSuggestion(parsed);
      } catch {
        // 解析失败，继续
      }
    }

    // 3. 尝试从文本中提取第一个 { ... } 块
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return this.validateSuggestion(parsed);
      } catch {
        // 解析失败
      }
    }

    // 无法解析，返回低置信度结果
    console.warn('[tv-ai-advisor] Failed to parse AI response as JSON:', responseText.slice(0, 200));
    return {
      confirmer: undefined,
      result: undefined,
      reason: responseText.slice(0, 500) || 'AI 响应无法解析',
      confidence: 0,
    };
  }

  /**
   * 验证并规范化建议对象。
   */
  private validateSuggestion(parsed: unknown): TVAISuggestion {
    if (typeof parsed !== 'object' || parsed === null) {
      return { confirmer: undefined, result: undefined, reason: undefined, confidence: 0 };
    }

    const obj = parsed as Record<string, unknown>;

    return {
      confirmer: typeof obj.confirmer === 'string' ? obj.confirmer : undefined,
      result: typeof obj.result === 'string' ? obj.result : undefined,
      reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0,
      analysis: typeof obj.analysis === 'string' ? obj.analysis : undefined,
    };
  }

  /**
   * 清理指定项目的 AI 会话（项目关闭时调用）。
   */
  clearSession(projectId: string): void {
    this.sessionMap.delete(projectId);
  }
}

/** TV AI Advisor 单例 */
export const tvAIAdvisor = new TVAIAdvisorImpl();
