/**
 * Settings router — credential management, model fetching, skill/MCP config, system prompt.
 */

import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { t, TRPCError } from '../router-context';
import { requireProject } from '../../services/project-service';
import { credentialManager } from '../../credentials/credential-manager';
import {
  discoverAllSkills,
  createUserSkill,
  deleteUserSkill,
  getSkillInstallInfo,
  readSkillContent,
} from '../../agent/skill-discovery';
import { fetchOpenAICompatibleModels } from '../../agent/openai-compatible';
import { sessionManager } from '../../agent/session-manager';
import { listMcpServers, getMcpConfig, setMcpConfig } from '../../mcp/mcp-config';
import { probeAllServers, probeMcpServer, clearProbeCache } from '../../mcp/mcp-probe';
import { getCombinedDefaultSystemPrompt } from '../../agent/default-system-prompt';
import { loadTvConfig, saveTvConfig } from '../../timing-violation/tv-config';
import { evictTvDb } from '../../timing-violation/db/tv-db-cache';
import { contextSettings } from '../../agent/context-settings';
import { toolSettings } from '../../agent/tool-settings';
import { HOST_TOOL_NAMES, HOST_TOOL_GROUPS } from '../../host/tool-catalog';
import { BUILTIN_TOOL_CATALOG, getBuiltinLabel, getBuiltinDescription } from '../../host/builtin-tool-catalog';
import { themeSettings } from '../../agent/theme-settings';
import type { TvConfig } from '../../timing-violation/types';
import type { CredentialInput, CredentialUpdateInput, ConfiguredModel, CreateSkillInput, McpConfigFile, McpToolInfo } from '@shared/types';
import { MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW } from '@shared/context-management';

/** Type guard: validate a ConfiguredModel object from raw input. */
function isValidConfiguredModel(value: unknown): value is ConfiguredModel {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === 'string' && m.id.length > 0 &&
    typeof m.name === 'string' &&
    typeof m.contextWindow === 'number' && Number.isInteger(m.contextWindow) &&
    m.contextWindow >= MIN_CONTEXT_WINDOW && m.contextWindow <= MAX_CONTEXT_WINDOW
  );
}

export const settingsRouter = t.router({
  getContextWindow: t.procedure.query(() => contextSettings.getContextWindow()),

  setContextWindow: t.procedure
    .input((raw): { contextWindow: number } => {
      const r = raw as Record<string, unknown>;
      if (!Number.isInteger(r.contextWindow) ||
          (r.contextWindow as number) < MIN_CONTEXT_WINDOW ||
          (r.contextWindow as number) > MAX_CONTEXT_WINDOW) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `contextWindow must be an integer between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW}`,
        });
      }
      return { contextWindow: r.contextWindow as number };
    })
    .mutation(async ({ input }) => {
      await contextSettings.setContextWindow(input.contextWindow);
      return { contextWindow: input.contextWindow };
    }),

  // ── 主题持久化（文件级，确保重启后恢复） ───────────────────
  getTheme: t.procedure.query(() => themeSettings.getTheme()),

  setTheme: t.procedure
    .input((raw): { theme: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.theme !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'theme is required' });
      }
      return { theme: r.theme };
    })
    .mutation(async ({ input }) => {
      await themeSettings.setTheme(input.theme);
      return { ok: true };
    }),

  // ── Agent 工具开关（每个工具是否暴露给 LLM）───────────────
  getAgentToolSettings: t.procedure.query(async () => {
    const disabledTools = await toolSettings.getDisabledTools();

    // 有活跃会话时从 runner 枚举当前工具集（含被禁用的），
    // 过滤掉 host 自定义工具和 ask 后即 omp 内置工具，并缓存供无会话时展示。
    let builtinTools = await toolSettings.getBuiltinCatalog();
    for (const { id } of sessionManager.listSessions()) {
      const tools = await sessionManager.listAgentTools(id);
      if (tools && tools.length > 0) {
        const hostNames = new Set(HOST_TOOL_NAMES);
        builtinTools = tools
          .filter((t) => !hostNames.has(t.name) && t.name !== 'ask')
          .map((t) => ({
            name: t.name,
            label: getBuiltinLabel(t.name),
            description: t.description || getBuiltinDescription(t.name),
          }));
        await toolSettings.saveBuiltinCatalog(builtinTools);
        break;
      }
    }

    // 无活跃会话或枚举失败时，使用静态内置工具目录作为默认展示
    if (builtinTools.length === 0) {
      builtinTools = BUILTIN_TOOL_CATALOG.map((t) => ({
        name: t.name,
        label: t.label,
        description: t.description,
      }));
    }

    return { disabledTools, hostGroups: HOST_TOOL_GROUPS, builtinTools };
  }),

  setAgentToolSettings: t.procedure
    .input((raw): { disabledTools: string[] } => {
      const r = raw as Record<string, unknown>;
      if (!Array.isArray(r.disabledTools) || !r.disabledTools.every((n) => typeof n === 'string')) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'disabledTools must be a string array' });
      }
      return { disabledTools: r.disabledTools as string[] };
    })
    .mutation(async ({ input }) => {
      // `ask` 是交互问答通道，不允许禁用
      const disabledTools = input.disabledTools.filter((n) => n !== 'ask');
      await toolSettings.setDisabledTools(disabledTools);
      await sessionManager.applyToolFilterToActiveSessions(disabledTools);
      return { ok: true, disabledTools };
    }),

  getCredentials: t.procedure.query(() => {
    return credentialManager.listMasked();
  }),

  setCredential: t.procedure
    .input((raw): { input: CredentialInput } => {
      const r = raw as Record<string, unknown>;
      const inp = r.input as Partial<CredentialInput>;
      if (!inp || typeof inp.providerId !== 'string' || typeof inp.apiKey !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid credential input' });
      }
      const result: CredentialInput = {
        providerId: inp.providerId,
        label: typeof inp.label === 'string' ? inp.label : '',
        apiKey: inp.apiKey,
        baseUrl: typeof inp.baseUrl === 'string' ? inp.baseUrl : undefined,
        models: Array.isArray(inp.models) ? inp.models.filter(isValidConfiguredModel) : undefined,
      };
      return { input: result };
    })
    .mutation(async ({ input }) => {
      return credentialManager.save(input.input);
    }),

  updateCredential: t.procedure
    .input((raw): { input: CredentialUpdateInput } => {
      const r = raw as Record<string, unknown>;
      const inp = r.input as Partial<CredentialUpdateInput>;
      if (!inp || typeof inp.providerId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'providerId is required' });
      }
      const result: CredentialUpdateInput = {
        providerId: inp.providerId,
        label: typeof inp.label === 'string' ? inp.label : undefined,
        apiKey: typeof inp.apiKey === 'string' && inp.apiKey !== '' ? inp.apiKey : undefined,
        baseUrl: typeof inp.baseUrl === 'string' ? inp.baseUrl : undefined,
        models: Array.isArray(inp.models) ? inp.models.filter(isValidConfiguredModel) : undefined,
      };
      return { input: result };
    })
    .mutation(async ({ input }) => {
      try {
        return await credentialManager.update(input.input);
      } catch (err) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  deleteCredential: t.procedure
    .input((raw): { providerId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.providerId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'providerId is required' });
      }
      return { providerId: r.providerId };
    })
    .mutation(async ({ input }) => {
      await credentialManager.delete(input.providerId);
      return { ok: true };
    }),

  fetchModels: t.procedure
    .input((raw): { providerId?: string; apiKey?: string; baseUrl?: string } => {
      const r = raw as Record<string, unknown>;
      return {
        providerId: typeof r.providerId === 'string' ? r.providerId : undefined,
        apiKey: typeof r.apiKey === 'string' ? r.apiKey : undefined,
        baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : undefined,
      };
    })
    .query(async ({ input }) => {
      // Determine which credentials to use: explicit input or stored
      let apiKey: string | undefined = input.apiKey;
      let baseUrl: string | undefined = input.baseUrl;

      if ((!apiKey || !baseUrl) && input.providerId) {
        const stored = await credentialManager.get(input.providerId);
        if (stored) {
          if (!apiKey) apiKey = stored.apiKey;
          if (!baseUrl) baseUrl = stored.baseUrl;
        }
      }

      // If still no explicit providerId, try the first stored credential
      if (!apiKey) {
        const all = await credentialManager.listRaw();
        if (all.length > 0) {
          apiKey = all[0].apiKey;
          baseUrl = baseUrl ?? all[0].baseUrl;
        }
      }

      if (!apiKey) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No API key configured. Please set credentials in Settings.' });
      }

      try {
        // Reuse the same fetch logic as session creation to ensure consistent
        // behavior (URL normalization, header format, error handling).
        // Previously this procedure had its own inline implementation that added
        // a `Content-Type: application/json` header to the GET request — some
        // custom API gateways (e.g. one-api / new-api) reject that on GET
        // requests, returning 401 "无效的令牌" even when the API key is valid.
        const models = await fetchOpenAICompatibleModels({
          baseUrl: baseUrl ?? 'https://api.openai.com',
          apiKey,
        });

        return models.map((m) => ({
          id: m.id,
          name: m.name,
          provider: input.providerId ?? 'openai',
          description: undefined,
        }));
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: 'BAD_REQUEST', message: `API error: ${msg}` });
      }
    }),

  listSkills: t.procedure.query(async () => {
    return discoverAllSkills();
  }),

  readSkill: t.procedure
    .input((raw): { filePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      return { filePath: r.filePath };
    })
    .query(async ({ input }) => {
      try {
        return await readSkillContent(input.filePath);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  getSkillInstallInfo: t.procedure.query(async () => {
    return getSkillInstallInfo();
  }),

  createSkill: t.procedure
    .input((raw): { input: CreateSkillInput } => {
      const r = raw as Record<string, unknown>;
      const inp = r.input as Partial<CreateSkillInput>;
      if (!inp || typeof inp.name !== 'string' || typeof inp.description !== 'string' || typeof inp.body !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'name, description, and body are required' });
      }
      return { input: inp as CreateSkillInput };
    })
    .mutation(async ({ input }) => {
      try {
        return await createUserSkill(input.input);
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  installSkill: t.procedure
    .input((raw): { input: CreateSkillInput } => {
      const r = raw as Record<string, unknown>;
      const inp = r.input as Partial<CreateSkillInput>;
      if (!inp || typeof inp.name !== 'string' || typeof inp.description !== 'string' || typeof inp.body !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'name, description, and body are required' });
      }
      return { input: inp as CreateSkillInput };
    })
    .mutation(async ({ input }) => {
      try {
        return await createUserSkill(input.input);
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  uninstallSkill: t.procedure
    .input((raw): { name: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.name !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'name is required' });
      }
      return { name: r.name };
    })
    .mutation(async ({ input }) => {
      try {
        await deleteUserSkill(input.name);
        return { ok: true };
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  listMcpServers: t.procedure
    .input((raw): { projectId: string; scope?: 'user' | 'project' } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      const scope = r.scope === 'project' ? 'project' : r.scope === 'user' ? 'user' : undefined;
      return { projectId: r.projectId, scope };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);

      // Probe all configured MCP servers directly via the MCP protocol,
      // independent of any AI agent session. This returns real connection
      // status and tool counts by actually connecting to each server.
      const config = await getMcpConfig(project.rootPath, input.scope ?? 'user');
      const servers = config.mcpServers ?? {};
      const probeResults = await probeAllServers(servers, { timeoutMs: 15_000 });

      // Build status map from probe results (includes error info)
      const statusMap: Record<string, { status: string; toolCount: number; error?: string }> = {};
      for (const [name, result] of Object.entries(probeResults)) {
        statusMap[name] = {
          status: result.status,
          toolCount: result.toolCount,
          error: result.error,
        };
      }

      return listMcpServers(project.rootPath, statusMap, input.scope);
    }),

  getMcpServerTools: t.procedure
    .input((raw): { projectId: string; serverName: string; scope?: 'user' | 'project' } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.serverName !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'serverName is required' });
      }
      const scope = r.scope === 'project' ? 'project' : 'user';
      return { projectId: r.projectId, serverName: r.serverName, scope };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);

      // Probe the specific server to get its tool list. The probe cache
      // (30s TTL) avoids re-connecting on every expand toggle.
      const config = await getMcpConfig(project.rootPath, input.scope);
      const serverConfig = config.mcpServers?.[input.serverName];
      if (!serverConfig) {
        return [] as McpToolInfo[];
      }

      const result = await probeMcpServer(input.serverName, serverConfig, {
        timeoutMs: 15_000,
      });
      return result.tools;
    }),

  reloadMcp: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .mutation(async ({ input }) => {
      requireProject(input.projectId);

      // Clear the probe cache so the next list query re-probes all servers
      // with the latest config.
      clearProbeCache();

      // Also reload MCP in running AI sessions (best-effort) so the LLM
      // picks up new tools without restarting the session.
      const sessionIds = sessionManager.listSessionsByProject(input.projectId);
      for (const sid of sessionIds) {
        try {
          await sessionManager.reloadMcp(sid);
        } catch {
          // Session may have been retired; skip
        }
      }

      return { ok: true };
    }),

  getMcpConfig: t.procedure
    .input((raw): { projectId: string; scope?: 'user' | 'project' } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      const scope = r.scope === 'project' ? 'project' : 'user';
      return { projectId: r.projectId, scope };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      return getMcpConfig(project.rootPath, input.scope);
    }),

  setMcpConfig: t.procedure
    .input((raw): { projectId: string; config: McpConfigFile; scope?: 'user' | 'project' } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      const scope = r.scope === 'project' ? 'project' : 'user';
      return { projectId: r.projectId, config: r.config as McpConfigFile, scope };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      await setMcpConfig(project.rootPath, input.config, input.scope);
      // Clear probe cache so the new config is re-probed on next list query
      clearProbeCache();
      return { ok: true };
    }),

  getSystemPrompt: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const promptPath = join(project.rootPath, '.socverify', 'system-prompt.md');
      try {
        return await readFile(promptPath, 'utf-8');
      } catch {
        return '';
      }
    }),

  setSystemPrompt: t.procedure
    .input((raw): { projectId: string; prompt: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.prompt !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and prompt are required' });
      }
      return { projectId: r.projectId, prompt: r.prompt };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const promptPath = join(project.rootPath, '.socverify', 'system-prompt.md');
      await mkdir(join(project.rootPath, '.socverify'), { recursive: true });
      await writeFile(promptPath, input.prompt, 'utf-8');
      return { ok: true };
    }),

  /**
   * 返回 AI Agent 的默认系统提示词模板内容（只读参考）。
   *
   * 模板内容在构建时通过 Vite `?raw` import 嵌入到代码中，
   * 因此在开发模式和打包二进制模式下都可访问。
   *
   * 包含：
   *   - system-prompt.md：主指令（角色、工程原则、工具策略、执行工作流、交付契约）
   *   - personalities/default.md：默认个性（简洁、证据优先）
   */
  getDefaultSystemPrompt: t.procedure.query(() => {
    return getCombinedDefaultSystemPrompt();
  }),

  /**
   * 获取时序违例配置（Corner 列表、子系统识别规则、DB 路径、默认复位时间、自动备份开关）。
   * 配置文件路径：<projectRoot>/.socverify/timing-violation/config.json
   */
  getTvConfig: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      return loadTvConfig(project.rootPath);
    }),

  /**
   * 更新时序违例配置，持久化到 config.json。
   * 如果 dataDir 变更，清除缓存的 DB 连接以便下次使用新路径。
   */
  updateTvConfig: t.procedure
    .input((raw): { projectId: string; config: TvConfig } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      const cfg = r.config as Partial<TvConfig>;
      if (!cfg || typeof cfg !== 'object') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'config is required' });
      }
      if (typeof cfg.dataDir !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'config.dataDir is required' });
      }
      if (!Array.isArray(cfg.corners)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'config.corners must be an array' });
      }
      if (!Array.isArray(cfg.subsysPatterns)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'config.subsysPatterns must be an array' });
      }
      if (typeof cfg.defaultResetTimeNs !== 'number') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'config.defaultResetTimeNs must be a number' });
      }
      // resetIntervalStartNs/EndNs 可为 null 或 number
      if (cfg.resetIntervalStartNs !== null && typeof cfg.resetIntervalStartNs !== 'number') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'config.resetIntervalStartNs must be a number or null' });
      }
      if (cfg.resetIntervalEndNs !== null && typeof cfg.resetIntervalEndNs !== 'number') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'config.resetIntervalEndNs must be a number or null' });
      }
      if (typeof cfg.autoBackup !== 'boolean') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'config.autoBackup must be a boolean' });
      }
      if (typeof cfg.backupInterval !== 'number') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'config.backupInterval must be a number' });
      }
      return { projectId: r.projectId, config: cfg as TvConfig };
    })
    .mutation(({ input }) => {
      const project = requireProject(input.projectId);
      // 读取旧配置以检测 dataDir 变更
      const oldConfig = loadTvConfig(project.rootPath);
      saveTvConfig(project.rootPath, input.config);
      // 如果 dataDir 变更，清除缓存的 DB 连接
      if (oldConfig.dataDir !== input.config.dataDir) {
        evictTvDb(input.projectId);
      }
      return { success: true as const };
    }),
});
