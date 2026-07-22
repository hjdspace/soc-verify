/**
 * Session router — AI agent session lifecycle, model switching, persistence, skills.
 */

import { join } from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import {
  t,
  TRPCError,
  requireProject,
  requireSession,
  ensurePluginsLoaded,
  storedMessagesPath,
  loadStoredMessages,
  filterEmptyPlaceholderSessions,
} from '../router-context';
import { sessionManager } from '../../agent/session-manager';
import { projectManager } from '../../project/project-manager';
import { pluginLoader } from '../../plugins/loader';
import { PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage } from '../../host/plugin-discovery';
import { CoverageManager } from '../../coverage/coverage-manager';
import { CoverageReportGenerator } from '../../coverage/coverage-report-generator';
import { credentialManager } from '../../credentials/credential-manager';
import {
  addSession,
  removeSession,
  loadSessions,
  saveSessions,
  updateSessionModel,
  updateSessionActivity,
  type PersistedSession,
} from '../../agent/session-persistence';
import { discoverSkills, readSkillContent } from '../../agent/skill-discovery';
import { errorAnalysisCoordinator } from '../../simulation/error-analysis-coordinator';
import type { ErrorType } from '@shared/types';

export const sessionRouter = t.router({
  create: t.procedure
    .input((raw): { projectId: string; cwd: string; provider?: string; model?: string; providerId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.cwd !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and cwd are required' });
      }
      return {
        projectId: r.projectId,
        cwd: r.cwd,
        provider: typeof r.provider === 'string' ? r.provider : undefined,
        model: typeof r.model === 'string' ? r.model : undefined,
        providerId: typeof r.providerId === 'string' ? r.providerId : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      await ensurePluginsLoaded(project.rootPath);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const discovery = new PluginBackedDiscovery(project.rootPath, registry);
      const subsysCount = registry.subsysDiscoverers.length;
      console.log(`[router:session.create] project=${input.projectId}, subsysDiscoverers=${subsysCount}`);
      if (subsysCount === 0) {
        const loadResults = pluginLoader.getLoadResults(project.rootPath);
        if (loadResults.length > 0) {
          console.log(`[router:session.create] plugin load results:`, loadResults.map(r => ({ id: r.manifest.id, kind: r.manifest.kind, error: r.error })));
        } else {
          console.log(`[router:session.create] no plugins loaded for project`);
        }
      }
      const simulation = new PluginBackedSimulation(registry);
      const coverage = new PluginBackedCoverage(project.rootPath, registry);
      // 构建 CoverageManager 供 Host Tools / Host URIs 使用（ADR 0009 摘要优先策略）
      const coverageManager = new CoverageManager({
        projectRoot: project.rootPath,
        coverageAdapter: coverage,
        reportGenerator: new CoverageReportGenerator({ projectRoot: project.rootPath }),
      });

      // Load stored credentials and build env vars for agent process
      const credEnv = await credentialManager.buildEnvForAgent();
      // Use the credential specified by providerId if provided, else fall back to default
      const cred = input.providerId
        ? await credentialManager.get(input.providerId)
        : await credentialManager.getDefaultCredential();

      // Determine provider, apiKey, and baseUrl to pass to the agent SDK:
      // 1. Use input.provider/model if explicitly provided (from UI)
      // 2. Fall back to stored credentials' provider
      // This ensures the agent starts with the correct provider matching the API key.
      const provider = input.provider ?? (cred ? credentialManager.mapProviderForAgent(cred.providerId) : undefined);
      const apiKey = cred?.apiKey;
      const baseUrl = cred?.baseUrl;

      console.log(`[router:session.create] provider=${provider ?? '(default)'}, model=${input.model ?? '(default)'}, hasApiKey=${!!apiKey}, hasBaseUrl=${!!baseUrl}`);

      const sessionId = await sessionManager.createSession({
        projectId: input.projectId,
        cwd: input.cwd,
        provider,
        model: input.model,
        apiKey,
        baseUrl,
        discovery,
        simulationAdapter: simulation,
        coverageAdapter: coverage,
        coverageManager,
        env: credEnv,
      });

      // Persist session metadata
      const ompSessionId = sessionManager.getOmpSessionId(sessionId);
      const persisted: PersistedSession = {
        sessionId,
        ompSessionId,
        name: '新会话',
        projectId: input.projectId,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        model: provider && input.model
          ? { provider, id: input.model, name: input.model, providerId: cred?.providerId }
          : undefined,
      };
      await addSession(project.rootPath, persisted);

      // Return the full model info so the frontend can store providerId on
      // the session — this is critical for runtime model switching: when
      // providerId is present, the backend can destroy+recreate the session
      // with the correct credential's config (apiKey/baseUrl).
      const resolvedModelId = sessionManager.getModel(sessionId) ?? input.model;
      return {
        sessionId,
        name: persisted.name,
        model: provider && resolvedModelId
          ? {
              provider,
              id: resolvedModelId,
              name: input.model ?? resolvedModelId,
              providerId: cred?.providerId,
            }
          : undefined,
      };
    }),

  send: t.procedure
    .input((raw): { sessionId: string; message: string; images?: string[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string' || typeof r.message !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId and message are required' });
      }
      return {
        sessionId: r.sessionId,
        message: r.message,
        images: Array.isArray(r.images) ? r.images as string[] : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const client = requireSession(input.sessionId);
      sessionManager.touchActivity(input.sessionId);
      console.log(`[router:session.send] sessionId=${input.sessionId}, message=${input.message.slice(0, 80)}${input.message.length > 80 ? '...' : ''}${input.images ? `, images=${input.images.length}` : ''}`);
      // Update persisted lastActivityAt
      const sendSessionEntry = sessionManager.getSession(input.sessionId);
      if (sendSessionEntry) {
        const sendProject = projectManager.getProject(sendSessionEntry.projectId);
        if (sendProject) {
          void updateSessionActivity(sendProject.rootPath, sendSessionEntry.persistedSessionId ?? input.sessionId);
        }
      }
      await client.prompt(input.message, input.images);
      console.log(`[router:session.send] prompt acknowledged by agent`);
      return { ok: true };
    }),

  abort: t.procedure
    .input((raw): { sessionId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
      }
      return { sessionId: r.sessionId };
    })
    .mutation(async ({ input }) => {
      const client = requireSession(input.sessionId);
      await client.abort();
      return { ok: true };
    }),

  destroy: t.procedure
    .input((raw): { sessionId: string; projectId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
      }
      return { sessionId: r.sessionId, projectId: typeof r.projectId === 'string' ? r.projectId : undefined };
    })
    .mutation(async ({ input }) => {
      const entry = sessionManager.getSession(input.sessionId);
      await sessionManager.destroySession(input.sessionId);
      // Remove from persisted sessions if projectId is provided
      if (input.projectId) {
        const project = projectManager.getProject(input.projectId);
        if (project) {
          const persistedSessionId = entry?.persistedSessionId ?? input.sessionId;
          await removeSession(project.rootPath, persistedSessionId);
          await rm(storedMessagesPath(project.rootPath, persistedSessionId), { force: true });
        }
      }
      return { ok: true };
    }),

  list: t.procedure.query(() => {
    return sessionManager.listSessions();
  }),

  getState: t.procedure
    .input((raw): { sessionId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
      }
      return { sessionId: r.sessionId };
    })
    .query(async ({ input }) => {
      const client = requireSession(input.sessionId);
      return client.getState();
    }),

  getMessages: t.procedure
    .input((raw): { sessionId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
      }
      return { sessionId: r.sessionId };
    })
    .query(async ({ input }) => {
      const client = requireSession(input.sessionId);
      return client.getMessages();
    }),

  getStoredMessages: t.procedure
    .input((raw): { projectId: string; sessionId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and sessionId are required' });
      }
      return { projectId: r.projectId, sessionId: r.sessionId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      return loadStoredMessages(project.rootPath, input.sessionId);
    }),

  saveStoredMessages: t.procedure
    .input((raw): { projectId: string; sessionId: string; messages: unknown[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionId !== 'string' || !Array.isArray(r.messages)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, sessionId and messages are required' });
      }
      return { projectId: r.projectId, sessionId: r.sessionId, messages: r.messages };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const dir = join(project.rootPath, '.socverify', 'chat-messages');
      await mkdir(dir, { recursive: true });
      await writeFile(storedMessagesPath(project.rootPath, input.sessionId), JSON.stringify(input.messages, null, 2), 'utf-8');
      return { ok: true };
    }),

  setModel: t.procedure
    .input((raw): { sessionId: string; provider?: string; modelId?: string; modelName?: string; providerId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
      }
      const providerId = typeof r.providerId === 'string' ? r.providerId : undefined;
      // When switching by providerId (holistic config switch), modelId is
      // optional — the backend will auto-pick the first model from the
      // credential's API. When providerId is absent (legacy same-provider
      // model swap via omp RPC), provider + modelId are required.
      if (!providerId) {
        if (typeof r.provider !== 'string' || typeof r.modelId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'provider and modelId are required when providerId is not supplied' });
        }
      }
      return {
        sessionId: r.sessionId,
        provider: typeof r.provider === 'string' ? r.provider : undefined,
        modelId: typeof r.modelId === 'string' && r.modelId ? r.modelId : undefined,
        modelName: typeof r.modelName === 'string' ? r.modelName : undefined,
        providerId,
      };
    })
    .mutation(async ({ input }) => {
      // If providerId is supplied, the user wants a holistic config switch:
      // the entire model config (provider + apiKey + baseUrl + model) must change.
      // Since the omp engine's set_model RPC only switches the model ID (it
      // cannot update apiKey/baseUrl at runtime), we destroy the current runtime
      // session and recreate it with the new credential's config, resuming the
      // conversation via the omp session ID so messages are preserved.
      if (input.providerId) {
        console.log(`[router:session.setModel] holistic swap: sessionId=${input.sessionId}, providerId=${input.providerId}, modelId=${input.modelId ?? '(auto)'}`);
        const cred = await credentialManager.get(input.providerId);
        if (!cred) {
          console.error(`[router:session.setModel] credential not found: ${input.providerId}`);
          throw new TRPCError({ code: 'NOT_FOUND', message: `Credential not found: ${input.providerId}` });
        }

        const existing = sessionManager.getSession(input.sessionId);
        if (!existing) {
          // The frontend always calls ensureRuntimeSession before setModel,
          // so the runtime session should exist. If it doesn't (e.g. idle
          // timeout), the model choice is already persisted in the frontend
          // state and will be applied when the session is next restored.
          console.error(`[router:session.setModel] runtime session not found: ${input.sessionId}`);
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Runtime session not found: ${input.sessionId}. The session may have been retired — please send a message first to restart it.`,
          });
        }

        const project = projectManager.getProject(existing.projectId);
        if (!project) {
          console.error(`[router:session.setModel] project not found: ${existing.projectId}`);
          throw new TRPCError({ code: 'NOT_FOUND', message: `Project not found: ${existing.projectId}` });
        }

        await ensurePluginsLoaded(project.rootPath);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const discovery = new PluginBackedDiscovery(project.rootPath, registry);
        const simulation = new PluginBackedSimulation(registry);
        const coverage = new PluginBackedCoverage(project.rootPath, registry);
        const coverageManager = new CoverageManager({
          projectRoot: project.rootPath,
          coverageAdapter: coverage,
          reportGenerator: new CoverageReportGenerator({ projectRoot: project.rootPath }),
        });

        // Capture the omp session ID for resume, then destroy the runtime session
        const ompSessionId = sessionManager.getOmpSessionId(input.sessionId);
        const persistedSessionId = existing.persistedSessionId ?? input.sessionId;

        console.log(`[router:session.setModel] destroying session ${input.sessionId} (ompSessionId=${ompSessionId ?? 'none'})`);
        await sessionManager.destroySession(input.sessionId);

        // Recreate with the new credential's config, resuming the conversation.
        // If modelId is not supplied, createSession will auto-fetch the
        // credential's model list and pick the first one.
        const credEnv = await credentialManager.buildEnvForAgent();
        const newProvider = credentialManager.mapProviderForAgent(cred.providerId);

        console.log(`[router:session.setModel] recreating session with provider=${newProvider}, model=${input.modelId ?? '(auto)'}, baseUrl=${cred.baseUrl ?? 'none'}`);
        const newSessionId = await sessionManager.createSession({
          projectId: existing.projectId,
          cwd: project.rootPath,
          provider: newProvider,
          model: input.modelId,
          apiKey: cred.apiKey,
          baseUrl: cred.baseUrl,
          discovery,
          simulationAdapter: simulation,
          coverageAdapter: coverage,
          coverageManager,
          resumeSessionId: ompSessionId,
          persistedSessionId,
          env: credEnv,
        });

        // Read back the actual model that createSession resolved to (it may
        // have auto-fetched the first model when input.modelId was empty).
        const resolvedModelId = sessionManager.getModel(newSessionId) ?? input.modelId;

        // Persist model info (with providerId) + updated ompSessionId
        const newOmpSessionId = sessionManager.getOmpSessionId(newSessionId);
        const sessions = await loadSessions(project.rootPath);
        const idx = sessions.findIndex((s) => s.sessionId === persistedSessionId);
        if (idx >= 0) {
          sessions[idx] = {
            ...sessions[idx],
            ompSessionId: newOmpSessionId,
            lastActivityAt: Date.now(),
            model: {
              provider: newProvider,
              id: resolvedModelId ?? input.modelId ?? '',
              name: input.modelName ?? input.modelId ?? resolvedModelId ?? '',
              providerId: input.providerId,
            },
          };
          await saveSessions(project.rootPath, sessions);
        }

        return {
          ok: true,
          sessionId: newSessionId,
          swapped: true,
          model: {
            provider: newProvider,
            id: resolvedModelId ?? input.modelId,
            name: input.modelName ?? input.modelId ?? resolvedModelId,
            providerId: input.providerId,
          },
        };
      }

      // No providerId — legacy path: just switch the model ID via the engine RPC.
      // This only works for built-in providers whose models are in the engine's catalog.
      if (!input.provider || !input.modelId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'provider and modelId are required when providerId is not supplied' });
      }
      await sessionManager.setModel(input.sessionId, input.provider, input.modelId);
      const sessionEntry = sessionManager.getSession(input.sessionId);
      if (sessionEntry) {
        const project = projectManager.getProject(sessionEntry.projectId);
        if (project) {
          await updateSessionModel(project.rootPath, sessionEntry.persistedSessionId ?? input.sessionId, {
            provider: input.provider,
            id: input.modelId,
            name: input.modelName ?? input.modelId,
          });
        }
      }
      return {
        ok: true,
        sessionId: input.sessionId,
        swapped: false,
        model: {
          provider: input.provider,
          id: input.modelId,
          name: input.modelName ?? input.modelId,
          providerId: undefined as string | undefined,
        },
      };
    }),

  getAvailableModels: t.procedure
    .input((raw): { sessionId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
      }
      return { sessionId: r.sessionId };
    })
    .query(async ({ input }) => {
      return sessionManager.getAvailableModels(input.sessionId);
    }),

  steer: t.procedure
    .input((raw): { sessionId: string; message: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string' || typeof r.message !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId and message are required' });
      }
      return { sessionId: r.sessionId, message: r.message };
    })
    .mutation(async ({ input }) => {
      const client = requireSession(input.sessionId);
      sessionManager.touchActivity(input.sessionId);
      await client.steer(input.message);
      return { ok: true };
    }),

  onEvent: t.procedure
    .input((raw): { sessionId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
      }
      return { sessionId: r.sessionId };
    })
    .subscription(({ input }) => {
      // Use a simple event-based subscription
      // electron-trpc will handle the IPC forwarding
      return {
        async *[Symbol.asyncIterator]() {
          // This is a placeholder - actual event forwarding will be via IPC
          yield { sessionId: input.sessionId, event: { type: 'subscription_started' } };
        },
      };
    }),

  getPersistedSessions: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      return filterEmptyPlaceholderSessions(project.rootPath, await loadSessions(project.rootPath));
    }),

  restore: t.procedure
    .input((raw): { projectId: string; cwd: string; sessionId: string; name?: string; providerId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.cwd !== 'string' || typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, cwd and sessionId are required' });
      }
      return {
        projectId: r.projectId,
        cwd: r.cwd,
        sessionId: r.sessionId,
        name: typeof r.name === 'string' ? r.name : undefined,
        providerId: typeof r.providerId === 'string' ? r.providerId : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      await ensurePluginsLoaded(project.rootPath);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const discovery = new PluginBackedDiscovery(project.rootPath, registry);
      const simulation = new PluginBackedSimulation(registry);
      const coverage = new PluginBackedCoverage(project.rootPath, registry);
      const coverageManager = new CoverageManager({
        projectRoot: project.rootPath,
        coverageAdapter: coverage,
        reportGenerator: new CoverageReportGenerator({ projectRoot: project.rootPath }),
      });

      // Load persisted session to restore model info and omp sessionId
      const persistedSessions = await loadSessions(project.rootPath);
      const persisted = persistedSessions.find((s) => s.sessionId === input.sessionId);

      // Load stored credentials for env vars.
      // Prefer the credential specified by providerId, then the persisted session's
      // providerId, and finally fall back to the default credential.
      const credEnv = await credentialManager.buildEnvForAgent();
      const resolvedProviderId = input.providerId ?? persisted?.model?.providerId;
      const cred = resolvedProviderId
        ? await credentialManager.get(resolvedProviderId)
        : await credentialManager.getDefaultCredential();
      const provider = persisted?.model?.provider ?? (cred ? credentialManager.mapProviderForAgent(cred.providerId) : undefined);
      const apiKey = cred?.apiKey;
      const baseUrl = cred?.baseUrl;

      const sessionId = await sessionManager.createSession({
        projectId: input.projectId,
        cwd: input.cwd,
        provider,
        model: persisted?.model?.id,
        apiKey,
        baseUrl,
        discovery,
        simulationAdapter: simulation,
        coverageAdapter: coverage,
        coverageManager,
        // Use the omp sessionId for resume — this is what the runner matches against
        resumeSessionId: persisted?.ompSessionId ?? input.sessionId,
        persistedSessionId: input.sessionId,
        env: credEnv,
      });

      // Persist the latest runtime resume handle and activity timestamp.
      const ompSessionId = sessionManager.getOmpSessionId(sessionId);
      // Read back the actual model that createSession resolved to (it may
      // have auto-fetched the first model when persisted.model.id was empty).
      const resolvedModelId = sessionManager.getModel(sessionId) ?? persisted?.model?.id;
      const resolvedModel = provider && resolvedModelId
        ? {
            provider,
            id: resolvedModelId,
            name: persisted?.model?.name ?? resolvedModelId,
            providerId: resolvedProviderId,
          }
        : persisted?.model;
      const sessions = await loadSessions(project.rootPath);
      const idx = sessions.findIndex((s) => s.sessionId === input.sessionId);
      if (idx >= 0) {
        sessions[idx] = {
          ...sessions[idx],
          ompSessionId,
          lastActivityAt: Date.now(),
          model: resolvedModel,
        };
        await saveSessions(project.rootPath, sessions);
      } else {
        await updateSessionActivity(project.rootPath, input.sessionId);
      }

      return {
        sessionId,
        name: input.name ?? `Session ${input.sessionId.slice(-6)}`,
        model: resolvedModel,
      };
    }),

  rename: t.procedure
    .input((raw): { projectId: string; sessionId: string; name: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionId !== 'string' || typeof r.name !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, sessionId and name are required' });
      }
      return { projectId: r.projectId, sessionId: r.sessionId, name: r.name };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const sessions = await loadSessions(project.rootPath);
      const idx = sessions.findIndex((s) => s.sessionId === input.sessionId);
      if (idx >= 0) {
        sessions[idx] = { ...sessions[idx], name: input.name };
        await saveSessions(project.rootPath, sessions);
      }
      return { ok: true };
    }),

  listHistory: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const persisted = await filterEmptyPlaceholderSessions(project.rootPath, await loadSessions(project.rootPath));
      const activeSessionIds = new Set<string>();
      for (const session of sessionManager.listSessions()) {
        activeSessionIds.add(session.id);
        if (session.persistedSessionId) activeSessionIds.add(session.persistedSessionId);
      }
      // Sort by lastActivityAt descending (newest first)
      return persisted
        .map((s) => ({ ...s, isActive: activeSessionIds.has(s.sessionId) }))
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    }),

  deleteHistorySession: t.procedure
    .input((raw): { projectId: string; sessionId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and sessionId are required' });
      }
      return { projectId: r.projectId, sessionId: r.sessionId };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      // If the session is currently active, destroy it first
      const activeSessionIds = sessionManager
        .listSessions()
        .filter((s) => s.id === input.sessionId || s.persistedSessionId === input.sessionId)
        .map((s) => s.id);
      for (const activeSessionId of activeSessionIds) {
        await sessionManager.destroySession(activeSessionId);
      }
      await removeSession(project.rootPath, input.sessionId);
      await rm(storedMessagesPath(project.rootPath, input.sessionId), { force: true });
      return { ok: true };
    }),

  listSkills: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      return discoverSkills(project.rootPath);
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
      return readSkillContent(input.filePath);
    }),

  // ── 错误分析会话创建 ──────────────────────────────────

  /**
   * 为仿真失败用例创建独立的 AI Agent 会话。
   *
   * 内部流程：
   * 1. 复用 sessionManager.createSession() 创建 omp 进程
   * 2. 注入错误类型相关的 system prompt
   * 3. 自动发送错误上下文作为首条消息
   * 4. 持久化会话元数据
   */
  createForErrorAnalysis: t.procedure
    .input((raw): {
      projectId: string;
      caseName: string;
      errorType: ErrorType;
      errorContext: string;
      command?: string;
      cwd?: string;
      sourceRunId?: string;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.caseName !== 'string' || typeof r.errorType !== 'string' || typeof r.errorContext !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, caseName, errorType and errorContext are required' });
      }
      return {
        projectId: r.projectId,
        caseName: r.caseName,
        errorType: r.errorType as ErrorType,
        errorContext: r.errorContext,
        command: typeof r.command === 'string' ? r.command : undefined,
        cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
        sourceRunId: typeof r.sourceRunId === 'string' ? r.sourceRunId : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const sessionId = await errorAnalysisCoordinator.triggerAnalysis({
        projectId: input.projectId,
        caseName: input.caseName,
        cwd: input.cwd,
        command: input.command,
        sourceRunId: input.sourceRunId,
      });

      if (!sessionId) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create error analysis session' });
      }

      // Persist session metadata
      const project = requireProject(input.projectId);
      const ompSessionId = sessionManager.getOmpSessionId(sessionId);
      const sessionName = input.errorType === 'compile_error'
        ? `[编译修复] ${input.caseName}`
        : `[仿真分析] ${input.caseName}`;
      const persisted: PersistedSession = {
        sessionId,
        ompSessionId,
        name: sessionName,
        projectId: input.projectId,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      await addSession(project.rootPath, persisted);

      return { sessionId, name: sessionName };
    }),
});
