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
import type { CredentialInput, CredentialUpdateInput, CreateSkillInput, McpConfigFile, McpToolInfo } from '@shared/types';

export const settingsRouter = t.router({
  getCredentials: t.procedure.query(() => {
    return credentialManager.listMasked();
  }),

  setCredential: t.procedure
    .input((raw): { input: CredentialInput } => {
      const r = raw as Record<string, unknown>;
      const inp = r.input as CredentialInput;
      if (!inp || typeof inp.providerId !== 'string' || typeof inp.apiKey !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid credential input' });
      }
      return { input: inp };
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
});
