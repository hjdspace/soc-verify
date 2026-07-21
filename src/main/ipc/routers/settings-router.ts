/**
 * Settings router — credential management, model fetching, skill/MCP config, system prompt.
 */

import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { t, TRPCError, requireProject } from '../router-context';
import { credentialManager } from '../../credentials/credential-manager';
import {
  discoverAllSkills,
  createUserSkill,
  deleteUserSkill,
  getSkillInstallInfo,
} from '../../agent/skill-discovery';
import { fetchOpenAICompatibleModels } from '../../agent/openai-compatible';
import type { CredentialInput, CreateSkillInput } from '@shared/types';

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

  listMcpServers: t.procedure.query(() => {
    return [];
  }),

  setMcpConfig: t.procedure
    .input((raw): { projectId: string; config: unknown } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, config: r.config };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const configPath = join(project.rootPath, '.socverify', 'mcp-config.json');
      await mkdir(join(project.rootPath, '.socverify'), { recursive: true });
      await writeFile(configPath, JSON.stringify(input.config, null, 2), 'utf-8');
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
});
