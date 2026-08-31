/**
 * Session router — AI agent session lifecycle, model switching, persistence, skills.
 */

import { join } from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { t, TRPCError } from '../router-context';
import { requireProject, ensurePluginsLoaded } from '../../services/project-service';
import {
  requireSession,
  storedMessagesPath,
  loadStoredMessages,
  filterEmptyPlaceholderSessions,
} from '../../services/session-service';
import { sessionManager, credentialSnapshot } from '../../agent/session-manager';
import { createSessionContext } from '../../agent/session-context-factory';
import { projectManager } from '../../project/project-manager';
import { pluginLoader } from '../../plugins/loader';
import { credentialManager } from '../../credentials/credential-manager';
import {
  addSession,
  removeSession,
  loadSessions,
  saveSessions,
  updateSessionModel,
  updateSessionActivity,
  updateSessionContextUsage,
  updateSessionOmpId,
  type PersistedSession,
} from '../../agent/session-persistence';
import { discoverSkills, readSkillContent, resolveSkillUriPath } from '../../agent/skill-discovery';
import { generateSessionTitle } from '../../agent/title-generator';
import { generateFollowUpSuggestions } from '../../agent/followup-generator';
import { errorAnalysisCoordinator } from '../../simulation/error-analysis-coordinator';
import type { ErrorType, ThinkingLevelSetting } from '@shared/types';
import { normalizeThinkingLevelSetting } from '@shared/types';
import type { ContextBreakdown, ContextUsage } from '@shared/context-management';
import type { AskAnswer } from '@shared/ask-types';

/**
 * In-flight holistic model swaps keyed by the ORIGINAL runtime session ID.
 *
 * setModel's holistic swap destroys the old omp process and recreates it —
 * a send() that lands in between would be delivered to the doomed process
 * and silently lost (symptom: "message sent, no LLM response ever arrives").
 * send() consults this map, waits for the swap to settle, and retargets the
 * prompt at the recreated session.
 */
type HolisticSwapResult = {
  ok: true;
  sessionId: string;
  swapped: boolean;
  model: { provider: string; id?: string; name?: string; providerId?: string };
};
const inFlightSwaps = new Map<string, Promise<HolisticSwapResult>>();

/**
 * Holistic config/model switch: destroy the runtime session and recreate it
 * with the target credential's config (the omp engine cannot update
 * apiKey/baseUrl on a live process). The conversation resumes via the omp
 * session ID so messages are preserved.
 */
async function performHolisticSwap(input: {
  sessionId: string;
  provider?: string;
  modelId?: string;
  modelName?: string;
  providerId: string;
}): Promise<HolisticSwapResult> {
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

  // No-op guard: if the runtime session was created with this exact
  // credential config AND already runs the requested model, destroying and
  // recreating would be pure waste — worse, it opens a window where a
  // concurrent send is delivered to the doomed process (message lost,
  // "no LLM response"). This happens routinely: picking a model in the
  // dropdown triggers ensureRuntimeSession (which creates the session with
  // that model) followed by setModel requesting the very same model.
  const currentModel = existing.model;
  if (
    existing.providerId === input.providerId &&
    existing.credentialSnapshot === credentialSnapshot(input.providerId, cred.apiKey, cred.baseUrl, cred.api) &&
    (!input.modelId || input.modelId === currentModel)
  ) {
    console.log(`[router:session.setModel] no-op: session ${input.sessionId} already runs ${input.providerId}/${currentModel ?? '(auto)'}`);
    return {
      ok: true,
      sessionId: input.sessionId,
      swapped: false,
      model: {
        provider: input.provider ?? '',
        id: currentModel ?? input.modelId ?? '',
        name: input.modelName ?? input.modelId ?? currentModel ?? '',
        providerId: input.providerId,
      },
    };
  }

  const project = projectManager.getProject(existing.projectId);
  if (!project) {
    console.error(`[router:session.setModel] project not found: ${existing.projectId}`);
    throw new TRPCError({ code: 'NOT_FOUND', message: `Project not found: ${existing.projectId}` });
  }

  // If the agent is currently processing (between agent_start and
  // agent_end), abort the current turn before destroying the session.
  // Without this, a prompt that was just sent will have its response
  // lost when the runner process is killed.
  // Re-fetch: the awaits above leave a window where activity may have started.
  const currentEntry = sessionManager.getSession(input.sessionId);
  if (currentEntry?.isActive) {
    console.log(`[router:session.setModel] session is active, aborting current turn before swap`);
    try {
      await sessionManager.abortSession(input.sessionId);
    } catch {
      // best-effort — proceed with destroy regardless
    }
  }

  // Capture the omp session ID for resume, then destroy the runtime session
  const ompSessionId = sessionManager.getOmpSessionId(input.sessionId);
  const persistedSessionId = existing.persistedSessionId ?? input.sessionId;

  console.log(`[router:session.setModel] destroying session ${input.sessionId} (ompSessionId=${ompSessionId ?? 'none'})`);
  await sessionManager.destroySession(input.sessionId);

  // Recreate with the new credential's config, resuming the conversation.
  // If modelId is not supplied, createSession will auto-fetch the
  // credential's model list and pick the first one.
  console.log(`[router:session.setModel] recreating session with providerId=${input.providerId}, model=${input.modelId ?? '(auto)'}`);
  const ctx = await createSessionContext({
    projectId: existing.projectId,
    cwd: project.rootPath,
    providerId: input.providerId,
    model: input.modelId,
    resumeSessionId: ompSessionId,
    persistedSessionId,
    includeCaseStats: true,
  });

  const { sessionId: newSessionId, provider, model: resolvedModel } = ctx;

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
        provider: provider ?? '',
        id: resolvedModel ?? input.modelId ?? '',
        name: input.modelName ?? input.modelId ?? resolvedModel ?? '',
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
      provider: provider ?? '',
      id: resolvedModel ?? input.modelId,
      name: input.modelName ?? input.modelId ?? resolvedModel,
      providerId: input.providerId,
    },
  };
}

export const sessionRouter = t.router({
  create: t.procedure
    .input((raw): { projectId: string; cwd: string; provider?: string; model?: string; providerId?: string; approvalMode?: 'always-ask' | 'write' | 'yolo'; thinkingLevel?: ThinkingLevelSetting } => {
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
        approvalMode: typeof r.approvalMode === 'string' ? (r.approvalMode as 'always-ask' | 'write' | 'yolo') : undefined,
        thinkingLevel: normalizeThinkingLevelSetting(r.thinkingLevel),
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      await ensurePluginsLoaded(project.rootPath);

      // Debug: log plugin discoverer count
      const registry = pluginLoader.getRegistry(project.rootPath);
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

      const ctx = await createSessionContext({
        projectId: input.projectId,
        cwd: input.cwd,
        providerId: input.providerId,
        provider: input.provider,
        model: input.model,
        includeCaseStats: true,
        ensurePlugins: false, // already loaded above
        approvalMode: input.approvalMode,
        thinkingLevel: input.thinkingLevel,
      });

      const { sessionId, provider, model: resolvedModel, providerId } = ctx;

      console.log(`[router:session.create] provider=${provider ?? '(default)'}, model=${input.model ?? '(default)'}, hasApiKey=${!!ctx.apiKey}, hasBaseUrl=${!!ctx.baseUrl}`);

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
          ? { provider, id: input.model, name: input.model, providerId }
          : undefined,
      };
      await addSession(project.rootPath, persisted);

      // Return the full model info so the frontend can store providerId on
      // the session — this is critical for runtime model switching: when
      // providerId is present, the backend can destroy+recreate the session
      // with the correct credential's config (apiKey/baseUrl).
      return {
        sessionId,
        name: persisted.name,
        model: provider && resolvedModel
          ? {
              provider,
              id: resolvedModel,
              name: input.model ?? resolvedModel,
              providerId,
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
      // A holistic setModel (destroy + recreate) may be in flight for this
      // session. Sending to the doomed old process would silently lose the
      // message — wait for the swap to settle and deliver the prompt to the
      // recreated session instead.
      let targetSessionId = input.sessionId;
      const swap = inFlightSwaps.get(input.sessionId);
      if (swap) {
        console.log(`[router:session.send] swap in flight for ${input.sessionId} — waiting and retargeting`);
        try {
          targetSessionId = (await swap).sessionId;
        } catch {
          // Swap failed — proceed with the original sessionId; the normal
          // NOT_FOUND recovery path in the renderer handles a dead session.
        }
      }

      // Validate session exists (throws NOT_FOUND if missing)
      const client = requireSession(targetSessionId);
      // If the agent process died (e.g. after abort() called stop()), the
      // session entry is stale — destroy it and throw NOT_FOUND so the
      // renderer can rebuild the session via ensureRuntimeSession.
      if (!client.isRunning()) {
        console.warn(`[router:session.send] agent process not running for ${targetSessionId} — destroying stale session`);
        await sessionManager.destroySession(targetSessionId);
        throw new TRPCError({ code: 'NOT_FOUND', message: `Session process not running: ${targetSessionId}` });
      }
      sessionManager.touchActivity(targetSessionId);
      console.log(`[router:session.send] sessionId=${targetSessionId}, message=${input.message.slice(0, 80)}${input.message.length > 80 ? '...' : ''}${input.images ? `, images=${input.images.length}` : ''}`);
      // Update persisted lastActivityAt
      const sendSessionEntry = sessionManager.getSession(targetSessionId);
      if (sendSessionEntry) {
        const sendProject = projectManager.getProject(sendSessionEntry.projectId);
        if (sendProject) {
          void updateSessionActivity(sendProject.rootPath, sendSessionEntry.persistedSessionId ?? targetSessionId);
        }
      }
      await sessionManager.promptFireAndForget(targetSessionId, input.message, input.images);
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
      const entry = sessionManager.getSession(input.sessionId);
      if (!entry) {
        // Session may have already been destroyed (e.g. idle timeout).
        // Treat as already aborted.
        return { ok: true };
      }
      // abort() sends a fire-and-forget abort command to the runner,
      // then hard-kills the entire process tree. The process is dead
      // by the time this returns — the frontend should reset the UI
      // state and clear any streaming messages.
      try {
        await sessionManager.abortSession(input.sessionId);
      } catch {
        // If abort throws (e.g. process already dead), force-stop as safety net.
        entry.client.stop();
      }
      return { ok: true };
    }),

  regenerate: t.procedure
    .input((raw): { sessionId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
      }
      return { sessionId: r.sessionId };
    })
    .mutation(async ({ input }) => {
      // Wait for an in-flight holistic swap, same rationale as send().
      let targetSessionId = input.sessionId;
      const swap = inFlightSwaps.get(input.sessionId);
      if (swap) {
        try {
          targetSessionId = (await swap).sessionId;
        } catch {
          // Swap failed — proceed with the original sessionId; the renderer
          // rolls back on failure.
        }
      }
      const client = requireSession(targetSessionId);
      if (!client.isRunning()) {
        console.warn(`[router:session.regenerate] agent process not running for ${targetSessionId} — destroying stale session`);
        await sessionManager.destroySession(targetSessionId);
        throw new TRPCError({ code: 'NOT_FOUND', message: `Session process not running: ${targetSessionId}` });
      }
      sessionManager.touchActivity(targetSessionId);

      // Branch the engine session back to the latest user message and
      // re-prompt. The branch forks the engine session file — persist the
      // post-branch ompSessionId so a restart resumes the new branch.
      const result = await sessionManager.regenerateSession(targetSessionId);
      const entry = sessionManager.getSession(targetSessionId);
      if (entry) {
        const project = projectManager.getProject(entry.projectId);
        if (project) {
          await updateSessionOmpId(
            project.rootPath,
            entry.persistedSessionId ?? targetSessionId,
            result.ompSessionId,
          );
        }
      }
      return { ok: true, ompSessionId: result.ompSessionId };
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

  compact: t.procedure
    .input((raw): { sessionId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
      }
      return { sessionId: r.sessionId };
    })
    .mutation(async ({ input }) => {
      const client = requireSession(input.sessionId);
      sessionManager.touchActivity(input.sessionId);
      return client.compact();
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

  updateContextUsage: t.procedure
    .input((raw): { projectId: string; sessionId: string; contextUsage: ContextUsage; contextBreakdown?: ContextBreakdown } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and sessionId are required' });
      }
      const cu = r.contextUsage as Record<string, unknown> | undefined;
      if (!cu || typeof cu.tokens !== 'number' || typeof cu.contextWindow !== 'number') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'contextUsage with tokens and contextWindow is required' });
      }
      const contextUsage: ContextUsage = {
        tokens: cu.tokens,
        contextWindow: cu.contextWindow,
        percent: typeof cu.percent === 'number' ? cu.percent : (cu.contextWindow > 0 ? (cu.tokens / cu.contextWindow) * 100 : 0),
      };
      let contextBreakdown: ContextBreakdown | undefined;
      const cb = r.contextBreakdown as Record<string, unknown> | undefined;
      if (cb && typeof cb.systemPromptTokens === 'number' && typeof cb.systemToolsTokens === 'number' && typeof cb.systemContextTokens === 'number' && typeof cb.skillsTokens === 'number' && typeof cb.messagesTokens === 'number') {
        contextBreakdown = {
          systemPromptTokens: cb.systemPromptTokens,
          systemToolsTokens: cb.systemToolsTokens,
          systemContextTokens: cb.systemContextTokens,
          skillsTokens: cb.skillsTokens,
          messagesTokens: cb.messagesTokens,
        };
      }
      return { projectId: r.projectId, sessionId: r.sessionId, contextUsage, contextBreakdown };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      await updateSessionContextUsage(
        project.rootPath,
        input.sessionId,
        input.contextUsage,
        input.contextBreakdown,
      );
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
        const existingSwap = inFlightSwaps.get(input.sessionId);
        if (existingSwap) {
          console.log(`[router:session.setModel] swap already in flight for ${input.sessionId} — joining in-flight swap`);
          return existingSwap;
        }
        const swap = performHolisticSwap({ ...input, providerId: input.providerId });
        inFlightSwaps.set(input.sessionId, swap);
        try {
          return await swap;
        } finally {
          inFlightSwaps.delete(input.sessionId);
        }
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
      // steer is a fire-and-forget command — the agent processes it mid-turn.
      // Use the session's client directly via requireSession for steer, as
      // promptFireAndForget sends a 'prompt' not a 'steer' command.
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
      const persisted = (await loadSessions(project.rootPath)).filter((s) => s.projectId === input.projectId);
      return filterEmptyPlaceholderSessions(project.rootPath, persisted);
    }),

  restore: t.procedure
    .input((raw): { projectId: string; cwd: string; sessionId: string; name?: string; providerId?: string; approvalMode?: 'always-ask' | 'write' | 'yolo'; thinkingLevel?: ThinkingLevelSetting } => {
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
        approvalMode: typeof r.approvalMode === 'string' ? (r.approvalMode as 'always-ask' | 'write' | 'yolo') : undefined,
        thinkingLevel: normalizeThinkingLevelSetting(r.thinkingLevel),
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);

      // Load persisted session to restore model info and omp sessionId
      const persistedSessions = await loadSessions(project.rootPath);
      const persisted = persistedSessions.find(
        (s) => s.sessionId === input.sessionId && s.projectId === input.projectId,
      );
      if (!persisted) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Session not found in project: ${input.sessionId}` });
      }

      // Build a seed transcript from the stored UI messages. The runner uses
      // it to rebuild engine context when the omp JSONL is missing or only
      // covers a tail of the conversation (amnesia recovery).
      const storedMessages = await loadStoredMessages(project.rootPath, input.sessionId);
      const seedHistory = storedMessages
        .filter((m): m is { role: 'user' | 'assistant'; content: string; timestamp: number } => {
          const r = m as Record<string, unknown>;
          return (
            (r.role === 'user' || r.role === 'assistant') &&
            typeof r.content === 'string' &&
            r.content.trim().length > 0 &&
            typeof r.timestamp === 'number'
          );
        })
        .map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp }));

      const ctx = await createSessionContext({
        projectId: input.projectId,
        cwd: input.cwd,
        providerId: input.providerId,
        model: persisted?.model?.id,
        persistedModel: persisted?.model,
        // Use the omp sessionId for resume — this is what the runner matches against
        resumeSessionId: persisted.ompSessionId ?? input.sessionId,
        seedHistory,
        persistedSessionId: input.sessionId,
        includeCaseStats: true,
        approvalMode: input.approvalMode,
        thinkingLevel: input.thinkingLevel,
      });
      const { sessionId, provider, model: resolvedModelId, providerId } = ctx;

      // Persist the latest runtime resume handle and activity timestamp.
      const ompSessionId = sessionManager.getOmpSessionId(sessionId);
      const resolvedModel = provider && resolvedModelId
        ? {
            provider,
            id: resolvedModelId,
            name: persisted?.model?.name ?? resolvedModelId,
            providerId,
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
      const projectSessions = (await loadSessions(project.rootPath)).filter((s) => s.projectId === input.projectId);
      const persisted = await filterEmptyPlaceholderSessions(project.rootPath, projectSessions);
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

  // 将 omp 内部 URI（skill://<name>[/<rel>]）解析为磁盘上的真实文件路径。
  // 渲染层工具卡片点击技能路径时调用，避免把 URI 当文件路径打开报"文件不存在"。
  resolveSkillUri: t.procedure
    .input((raw): { projectId: string; uri: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.uri !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'uri is required' });
      }
      return { projectId: r.projectId, uri: r.uri };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      return resolveSkillUriPath(project.rootPath, input.uri);
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

  // ── 工具审批 ──────────────────────────────────────────

  resolveApproval: t.procedure
    .input((raw): { requestId: string; approved: boolean } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.requestId !== 'string' || typeof r.approved !== 'boolean') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'requestId (string) and approved (boolean) are required' });
      }
      return { requestId: r.requestId, approved: r.approved };
    })
    .mutation(async ({ input }) => {
      const resolved = sessionManager.resolveApproval(input.requestId, input.approved);
      if (!resolved) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Approval request not found or already resolved' });
      }
      return { ok: true };
    }),

  resolveAsk: t.procedure
    .input((raw): { requestId: string; answers: AskAnswer[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.requestId !== 'string' || !Array.isArray(r.answers)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'requestId (string) and answers (array) are required' });
      }
      return { requestId: r.requestId, answers: r.answers as AskAnswer[] };
    })
    .mutation(async ({ input }) => {
      const resolved = sessionManager.resolveAsk(input.requestId, input.answers);
      if (!resolved) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Ask request not found or already resolved' });
      }
      return { ok: true };
    }),

  setApprovalMode: t.procedure
    .input((raw): { sessionId: string; approvalMode: 'always-ask' | 'write' | 'yolo' } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string' || typeof r.approvalMode !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId and approvalMode are required' });
      }
      const validModes = ['always-ask', 'write', 'yolo'];
      if (!validModes.includes(r.approvalMode)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `approvalMode must be one of: ${validModes.join(', ')}` });
      }
      return { sessionId: r.sessionId, approvalMode: r.approvalMode as 'always-ask' | 'write' | 'yolo' };
    })
    .mutation(async ({ input }) => {
      // Dynamically update the approval mode on the running session.
      // The runner re-wraps the tools with the new approval mode.
      // If the session doesn't exist yet (lazy creation), the mode will be
      // applied when the session is created via ensureRuntimeSession.
      try {
        await sessionManager.setApprovalMode(input.sessionId, input.approvalMode);
      } catch {
        // Session not running — mode will be applied on next session create/restore.
      }
      return { ok: true };
    }),

  setThinkingLevel: t.procedure
    .input((raw): { sessionId: string; level: ThinkingLevelSetting } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
      }
      return { sessionId: r.sessionId, level: normalizeThinkingLevelSetting(r.level) };
    })
    .mutation(async ({ input }) => {
      // Dynamically update the thinking level on the running session (persisted
      // into the omp session file so omp-native resume keeps it). If the
      // session isn't running yet, the level stored in the renderer session
      // state is applied at create time via InitConfig.thinkingLevel.
      try {
        await sessionManager.setThinkingLevel(input.sessionId, input.level);
      } catch {
        // Session not running — applied on next create/restore instead.
      }
      return { ok: true };
    }),

  // ── AI 会话标题生成 ──────────────────────────────────
  /**
   * Generate a concise session title from the first user message.
   *
   * Only the user's first message is used — the assistant's response is NOT
   * needed.  Low-signal input (greetings, acknowledgements, etc.) is skipped.
   *
   * Resolves credentials via the KB LLM config chain (KB settings → credential
   * model → Agent session model → API-fetched → provider default), supporting
   * built-in providers (openai, anthropic, google) and custom OpenAI-compatible
   * gateways. Falls back gracefully — returns { title: null } when generation
   * fails.
   */
  generateTitle: t.procedure
    .input((raw): { userMessage: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.userMessage !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'userMessage is required' });
      }
      return {
        userMessage: r.userMessage,
      };
    })
    .mutation(async ({ input }) => {
      const title = await generateSessionTitle(input.userMessage);
      return { title };
    }),

  /**
   * Generate follow-up question suggestions for the last conversation turn.
   *
   * Fired fire-and-forget by the renderer when agent_end arrives. Resolves
   * credentials via the same KB LLM config chain as generateTitle; returns an
   * empty array on any failure (suggestions are a nice-to-have, never an
   * error surface).
   */
  generateFollowUps: t.procedure
    .input((raw): { userMessage: string; assistantMessage: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.userMessage !== 'string' || typeof r.assistantMessage !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'userMessage and assistantMessage are required' });
      }
      return { userMessage: r.userMessage, assistantMessage: r.assistantMessage };
    })
    .mutation(async ({ input }) => {
      const followUps = await generateFollowUpSuggestions(input.userMessage, input.assistantMessage);
      return { followUps };
    }),
});
