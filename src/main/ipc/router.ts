import { initTRPC, TRPCError } from '@trpc/server';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { sessionManager } from '../agent/session-manager';
import { resolveAgentRuntime, resolveBunPath, resolveRunnerPath } from '../agent/paths';
import { projectManager } from '../project/project-manager';
import { pluginLoader } from '../plugins/loader';
import { PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage } from '../host/plugin-discovery';
import type { CaseStatus } from '../host/discovery';
import { simulationRegistry } from '../simulation/simulation-registry';
import { detectEdaTools, loadEnvConfig, saveEnvConfig, getKnownEnvVarNames } from '../env/env-manager';
import { CoverageManager } from '../coverage/coverage-manager';
import { RegressionManager } from '../regression/regression-manager';
import { terminalManager } from '../terminal/terminal-manager';
import { credentialManager } from '../credentials/credential-manager';
import { addSession, removeSession, loadSessions, saveSessions, type PersistedSession } from '../agent/session-persistence';
import { dialog, ipcMain, BrowserWindow } from 'electron';
import type {
  ProjectInfo,
  ProjectState,
  FileTreeNode,
  PluginConfig,
  PluginConfigEntry,
  SimulationHistoryEntry,
  EnvConfig,
  EdaToolInfo,
  CoverageSummary,
  CoverageBySubsys,
  RegressionSuite,
  RegressionResult,
  TOChecklistItem,
  CredentialEntry,
  CredentialInput,
} from '@shared/types';
import type { PluginLoadResult, SimulationRunOptions } from '@shared/plugin-types';

const t = initTRPC.create();

function requireSession(sessionId: string) {
  const client = sessionManager.getClient(sessionId);
  if (!client) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Session not found: ${sessionId}` });
  }
  return client;
}

function requireProject(projectId: string): ProjectInfo {
  const project = projectManager.getProject(projectId);
  if (!project) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Project not found: ${projectId}` });
  }
  return project;
}

function getSimulationManager(projectId: string) {
  const project = requireProject(projectId);
  const registry = pluginLoader.getRegistry(project.rootPath);
  const adapter = new PluginBackedSimulation(registry);
  return simulationRegistry.getOrCreate(project.rootPath, projectId, adapter);
}

/**
 * Ensure plugins are loaded for a project root path.
 * When a project is restored from persisted state (not opened via project.open),
 * loadPlugins() may never have been called. This lazy-loads plugins on demand.
 */
async function ensurePluginsLoaded(rootPath: string): Promise<void> {
  const loadResults = pluginLoader.getLoadResults(rootPath);
  if (loadResults.length === 0) {
    console.log(`[router] lazy-loading plugins for ${rootPath}`);
    await pluginLoader.loadPlugins(rootPath);
  }
}

export const router = t.router({
  ping: t.procedure.query(() => 'pong' as const),

  version: t.procedure.query(() => ({
    app: 'soc-verify',
    version: '0.2.0',
    stage: 'M2' as const,
  })),

  // ─── 系统 ─────────────────────────────────────────────

  system: t.router({
    resolveAgent: t.procedure.query(() => {
      const runtime = resolveAgentRuntime();
      return {
        available: runtime !== null,
        bunPath: resolveBunPath(),
        runnerPath: resolveRunnerPath(),
        bunVersion: runtime?.bunVersion ?? null,
        bunVersionOk: runtime?.bunVersionOk ?? false,
      };
    }),
  }),

  // ─── 项目管理 ─────────────────────────────────────────

  project: t.router({
    open: t.procedure
      .input((raw): { rootPath: string; name?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.rootPath !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'rootPath is required' });
        }
        return {
          rootPath: r.rootPath,
          name: typeof r.name === 'string' ? r.name : undefined,
        };
      })
      .mutation(async ({ input }) => {
        const info = await projectManager.openProject(input.rootPath, input.name);

        // Load plugins for this project
        const loadResults = await pluginLoader.loadPlugins(info.rootPath);
        const registry = pluginLoader.getRegistry(info.rootPath);

        // Return plugin load info alongside project info
        const plugins = loadResults.map((r) => ({
          id: r.manifest.id,
          name: r.manifest.name,
          version: r.manifest.version,
          kind: r.manifest.kind,
          source: r.source,
          path: r.path,
          enabled: !r.error,
          error: r.error,
        }));

        return { project: info, plugins };
      }),

    openDialog: t.procedure
      .mutation(async () => {
        const result = await dialog.showOpenDialog({
          properties: ['openDirectory'],
          title: '选择 SoC 项目根目录',
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { canceled: true as const };
        }
        const rootPath = result.filePaths[0];
        const info = await projectManager.openProject(rootPath);

        // Load plugins
        const loadResults = await pluginLoader.loadPlugins(info.rootPath);
        const plugins = loadResults.map((r) => ({
          id: r.manifest.id,
          name: r.manifest.name,
          version: r.manifest.version,
          kind: r.manifest.kind,
          source: r.source,
          path: r.path,
          enabled: !r.error,
          error: r.error,
        }));

        return { canceled: false as const, project: info, plugins };
      }),

    close: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        await projectManager.closeProject(input.projectId);
        pluginLoader.clearProject(project.rootPath);
        return { ok: true };
      }),

    list: t.procedure.query(() => {
      return projectManager.listProjects();
    }),

    getFileTree: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        return projectManager.getFileTree(input.projectId);
      }),

    readFile: t.procedure
      .input((raw): { projectId: string; filePath: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.filePath !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and filePath are required' });
        }
        return { projectId: r.projectId, filePath: r.filePath };
      })
      .query(async ({ input }) => {
        return projectManager.readFile(input.projectId, input.filePath);
      }),

    writeFile: t.procedure
      .input((raw): { projectId: string; filePath: string; content: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.filePath !== 'string' || typeof r.content !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, filePath and content are required' });
        }
        return { projectId: r.projectId, filePath: r.filePath, content: r.content };
      })
      .mutation(async ({ input }) => {
        await projectManager.writeFile(input.projectId, input.filePath, input.content);
        return { ok: true };
      }),

    getSubsystems: t.procedure
      .input((raw): { projectId: string; filter?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return {
          projectId: r.projectId,
          filter: typeof r.filter === 'string' ? r.filter : undefined,
        };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        await ensurePluginsLoaded(project.rootPath);
        const registry = pluginLoader.getRegistry(project.rootPath);
        console.log(`[router:getSubsystems] project=${input.projectId}, subsysDiscoverers=${registry.subsysDiscoverers.length}`);
        if (registry.subsysDiscoverers.length === 0) {
          const loadResults = pluginLoader.getLoadResults(project.rootPath);
          console.log(`[router:getSubsystems] loadResults count=${loadResults.length}`, loadResults.map(r => ({ id: r.manifest.id, kind: r.manifest.kind, error: r.error })));
          return [];
        }

        const discovery = new PluginBackedDiscovery(project.rootPath, registry);
        const result = await discovery.listSubsys(input.filter);
        console.log(`[router:getSubsystems] discovered ${result.length} subsystems`);
        return result;
      }),

    getCases: t.procedure
      .input((raw): { projectId: string; subsys?: string; status?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return {
          projectId: r.projectId,
          subsys: typeof r.subsys === 'string' ? r.subsys : undefined,
          status: typeof r.status === 'string' ? r.status : undefined,
        };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        await ensurePluginsLoaded(project.rootPath);
        const registry = pluginLoader.getRegistry(project.rootPath);
        if (registry.caseParsers.length === 0) return [];

        const discovery = new PluginBackedDiscovery(project.rootPath, registry);
        const status = input.status as CaseStatus | undefined;
        return discovery.listCases(input.subsys, status);
      }),

    getPlugins: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        await ensurePluginsLoaded(project.rootPath);
        const loadResults = pluginLoader.getLoadResults(project.rootPath);
        const config = await projectManager.getPluginConfig(project.rootPath);

        return loadResults.map((r) => {
          const configEntry = config.plugins.find((p) => p.id === r.manifest.id);
          return {
            id: r.manifest.id,
            name: r.manifest.name,
            version: r.manifest.version,
            kind: r.manifest.kind,
            description: r.manifest.description,
            source: r.source,
            path: r.path,
            enabled: configEntry?.enabled ?? !r.error,
            error: r.error,
          };
        });
      }),

    togglePlugin: t.procedure
      .input((raw): { projectId: string; pluginId: string; enabled: boolean } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.pluginId !== 'string' || typeof r.enabled !== 'boolean') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, pluginId and enabled are required' });
        }
        return { projectId: r.projectId, pluginId: r.pluginId, enabled: r.enabled };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const config = await projectManager.togglePlugin(project.rootPath, input.pluginId, input.enabled);

        // Reload plugins
        await pluginLoader.loadPlugins(project.rootPath);

        return config.plugins.find((p) => p.id === input.pluginId);
      }),

    savePluginConfig: t.procedure
      .input((raw): { projectId: string; plugins: PluginConfigEntry[] } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || !Array.isArray(r.plugins)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and plugins are required' });
        }
        return { projectId: r.projectId, plugins: r.plugins as PluginConfigEntry[] };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const config: PluginConfig = { plugins: input.plugins };
        await projectManager.savePluginConfig(project.rootPath, config);

        // Reload plugins
        await pluginLoader.loadPlugins(project.rootPath);

        return { ok: true };
      }),

    getState: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        return projectManager.getProjectState(input.projectId);
      }),

    saveState: t.procedure
      .input((raw): { state: ProjectState } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.state !== 'object' || r.state === null) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'state is required' });
        }
        return { state: r.state as ProjectState };
      })
      .mutation(async ({ input }) => {
        await projectManager.saveProjectState(input.state);
        return { ok: true };
      }),

    create: t.procedure
      .input((raw): { rootPath: string; name: string; plugins?: PluginConfigEntry[] } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.rootPath !== 'string' || typeof r.name !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'rootPath and name are required' });
        }
        return {
          rootPath: r.rootPath,
          name: r.name,
          plugins: Array.isArray(r.plugins) ? r.plugins as PluginConfigEntry[] : undefined,
        };
      })
      .mutation(async ({ input }) => {
        const info = await projectManager.createProject(input.rootPath, input.name, input.plugins);
        return info;
      }),

    getOverview: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        await ensurePluginsLoaded(project.rootPath);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const discovery = new PluginBackedDiscovery(project.rootPath, registry);

        const subsystems = await discovery.listSubsys();
        let totalCases = 0;
        let passCount = 0;
        for (const subsys of subsystems) {
          const cases = await discovery.listCases(subsys.name);
          subsys.caseCount = cases.length;
          totalCases += cases.length;
          passCount += cases.filter((c) => c.status === 'pass').length;
        }

        return {
          subsystemCount: subsystems.length,
          caseCount: totalCases,
          passRate: totalCases > 0 ? (passCount / totalCases) * 100 : 0,
        };
      }),

    getSimOptionsSchema: t.procedure
      .input((raw): { projectId: string; subsys?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return {
          projectId: r.projectId,
          subsys: typeof r.subsys === 'string' ? r.subsys : undefined,
        };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        await ensurePluginsLoaded(project.rootPath);
        const registry = pluginLoader.getRegistry(project.rootPath);
        if (registry.simOptionSchemaProviders.length === 0) {
          return { fields: [] };
        }
        const plugin = registry.simOptionSchemaProviders[0];
        return plugin.getSchema(input.subsys ?? '');
      }),

    saveSimOptionPreset: t.procedure
      .input((raw): { projectId: string; name: string; options: Record<string, unknown> } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.name !== 'string' || typeof r.options !== 'object') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, name and options are required' });
        }
        return {
          projectId: r.projectId,
          name: r.name,
          options: r.options as Record<string, unknown>,
        };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const presetPath = join(project.rootPath, '.socverify', 'sim-presets.json');
        let presets: Record<string, Record<string, unknown>> = {};
        try {
          const content = await readFile(presetPath, 'utf-8');
          presets = JSON.parse(content);
        } catch {
          // file doesn't exist yet
        }
        presets[input.name] = input.options;
        await mkdir(join(project.rootPath, '.socverify'), { recursive: true });
        await writeFile(presetPath, JSON.stringify(presets, null, 2), 'utf-8');
        return { ok: true };
      }),

    getSimOptionPresets: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const presetPath = join(project.rootPath, '.socverify', 'sim-presets.json');
        try {
          const content = await readFile(presetPath, 'utf-8');
          return JSON.parse(content) as Record<string, Record<string, unknown>>;
        } catch {
          return {};
        }
      }),
  }),

  // ─── 会话管理 ─────────────────────────────────────────

  session: t.router({
    create: t.procedure
      .input((raw): { projectId: string; cwd: string; provider?: string; model?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.cwd !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and cwd are required' });
        }
        return {
          projectId: r.projectId,
          cwd: r.cwd,
          provider: typeof r.provider === 'string' ? r.provider : undefined,
          model: typeof r.model === 'string' ? r.model : undefined,
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

        // Load stored credentials and build env vars for agent process
        const credEnv = await credentialManager.buildEnvForAgent();
        const defaultCred = await credentialManager.getDefaultCredential();

        // Determine provider, apiKey, and baseUrl to pass to the agent SDK:
        // 1. Use input.provider/model if explicitly provided (from UI)
        // 2. Fall back to stored credentials' provider
        // This ensures the agent starts with the correct provider matching the API key.
        const provider = input.provider ?? (defaultCred ? credentialManager.mapProviderForAgent(defaultCred.providerId) : undefined);
        const apiKey = defaultCred?.apiKey;
        const baseUrl = defaultCred?.baseUrl;

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
          env: credEnv,
        });

        // Persist session metadata
        const persisted: PersistedSession = {
          sessionId,
          name: `Session ${Date.now().toString(36)}`,
          projectId: input.projectId,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        };
        await addSession(project.rootPath, persisted);

        return { sessionId, name: persisted.name };
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
        console.log(`[router:session.send] sessionId=${input.sessionId}, message=${input.message.slice(0, 80)}${input.message.length > 80 ? '...' : ''}`);
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
        await sessionManager.destroySession(input.sessionId);
        // Remove from persisted sessions if projectId is provided
        if (input.projectId) {
          const project = projectManager.getProject(input.projectId);
          if (project) {
            await removeSession(project.rootPath, input.sessionId);
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

    setModel: t.procedure
      .input((raw): { sessionId: string; provider: string; modelId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.sessionId !== 'string' || typeof r.provider !== 'string' || typeof r.modelId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId, provider and modelId are required' });
        }
        return { sessionId: r.sessionId, provider: r.provider, modelId: r.modelId };
      })
      .mutation(async ({ input }) => {
        await sessionManager.setModel(input.sessionId, input.provider, input.modelId);
        return { ok: true };
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
        return loadSessions(project.rootPath);
      }),

    restore: t.procedure
      .input((raw): { projectId: string; cwd: string; sessionId: string; name?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.cwd !== 'string' || typeof r.sessionId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, cwd and sessionId are required' });
        }
        return {
          projectId: r.projectId,
          cwd: r.cwd,
          sessionId: r.sessionId,
          name: typeof r.name === 'string' ? r.name : undefined,
        };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        await ensurePluginsLoaded(project.rootPath);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const discovery = new PluginBackedDiscovery(project.rootPath, registry);
        const simulation = new PluginBackedSimulation(registry);
        const coverage = new PluginBackedCoverage(project.rootPath, registry);

        const sessionId = await sessionManager.createSession({
          projectId: input.projectId,
          cwd: input.cwd,
          discovery,
          simulationAdapter: simulation,
          coverageAdapter: coverage,
          resumeSessionId: input.sessionId,
        });

        return { sessionId, name: input.name ?? `Session ${input.sessionId.slice(-6)}` };
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
  }),

  // ─── 仿真执行 ─────────────────────────────────────────

  simulation: t.router({
    run: t.procedure
      .input((raw): { projectId: string; options: SimulationRunOptions } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        if (typeof r.options !== 'object' || r.options === null) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'options is required' });
        }
        return { projectId: r.projectId, options: r.options as SimulationRunOptions };
      })
      .mutation(async ({ input }) => {
        const manager = getSimulationManager(input.projectId);
        if (!manager.hasRunner()) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No simulation-runner plugin loaded' });
        }
        const handle = await manager.run(input.options);
        return { runId: handle.runId };
      }),

    getStatus: t.procedure
      .input((raw): { projectId: string; runId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.runId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and runId are required' });
        }
        return { projectId: r.projectId, runId: r.runId };
      })
      .query(async ({ input }) => {
        const manager = getSimulationManager(input.projectId);
        return manager.getStatus(input.runId);
      }),

    getCompileErrors: t.procedure
      .input((raw): { projectId: string; runId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.runId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and runId are required' });
        }
        return { projectId: r.projectId, runId: r.runId };
      })
      .query(async ({ input }) => {
        const manager = getSimulationManager(input.projectId);
        return manager.getCompileErrors(input.runId);
      }),

    abort: t.procedure
      .input((raw): { projectId: string; runId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.runId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and runId are required' });
        }
        return { projectId: r.projectId, runId: r.runId };
      })
      .mutation(async ({ input }) => {
        const manager = getSimulationManager(input.projectId);
        await manager.abort(input.runId);
        return { ok: true };
      }),

    listActiveRuns: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        const manager = getSimulationManager(input.projectId);
        return manager.getActiveRuns();
      }),

    getHistory: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        const manager = getSimulationManager(input.projectId);
        return manager.getHistory();
      }),

    getRunDetail: t.procedure
      .input((raw): { projectId: string; runId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.runId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and runId are required' });
        }
        return { projectId: r.projectId, runId: r.runId };
      })
      .query(async ({ input }) => {
        const manager = getSimulationManager(input.projectId);
        const detail = manager.getRunDetail(input.runId);
        if (!detail) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `Run not found: ${input.runId}` });
        }
        return detail;
      }),

    compareRuns: t.procedure
      .input((raw): { projectId: string; runIdA: string; runIdB: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.runIdA !== 'string' || typeof r.runIdB !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, runIdA and runIdB are required' });
        }
        return { projectId: r.projectId, runIdA: r.runIdA, runIdB: r.runIdB };
      })
      .query(async ({ input }) => {
        const manager = getSimulationManager(input.projectId);
        return manager.compareRuns(input.runIdA, input.runIdB);
      }),
  }),

  // ─── 终端管理 ─────────────────────────────────────────

  terminal: t.router({
    create: t.procedure
      .input((raw): { projectId?: string; cwd?: string; cols?: number; rows?: number } => {
        const r = raw as Record<string, unknown>;
        return {
          projectId: typeof r.projectId === 'string' ? r.projectId : undefined,
          cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
          cols: typeof r.cols === 'number' ? r.cols : undefined,
          rows: typeof r.rows === 'number' ? r.rows : undefined,
        };
      })
      .mutation(async ({ input }) => {
        let cwd = input.cwd;
        if (!cwd && input.projectId) {
          const project = projectManager.getProject(input.projectId);
          cwd = project?.rootPath;
        }
        const session = await terminalManager.create({
          cwd,
          cols: input.cols,
          rows: input.rows,
        });
        return session;
      }),

    write: t.procedure
      .input((raw): { terminalId: string; data: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.terminalId !== 'string' || typeof r.data !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'terminalId and data are required' });
        }
        return { terminalId: r.terminalId, data: r.data };
      })
      .mutation(async ({ input }) => {
        terminalManager.write(input.terminalId, input.data);
        return { ok: true };
      }),

    resize: t.procedure
      .input((raw): { terminalId: string; cols: number; rows: number } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.terminalId !== 'string' || typeof r.cols !== 'number' || typeof r.rows !== 'number') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'terminalId, cols and rows are required' });
        }
        return { terminalId: r.terminalId, cols: r.cols, rows: r.rows };
      })
      .mutation(async ({ input }) => {
        terminalManager.resize(input.terminalId, input.cols, input.rows);
        return { ok: true };
      }),

    destroy: t.procedure
      .input((raw): { terminalId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.terminalId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'terminalId is required' });
        }
        return { terminalId: r.terminalId };
      })
      .mutation(async ({ input }) => {
        terminalManager.destroy(input.terminalId);
        return { ok: true };
      }),

    list: t.procedure.query(() => {
      return terminalManager.list();
    }),
  }),

   // ─── 环境配置 ──────────────────────────────────────────────
  env: t.router({
    detectTools: t.procedure
      .mutation(async () => {
        const tools = await detectEdaTools();
        return { tools };
      }),

    getConfig: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const config = await loadEnvConfig(project.rootPath);
        return config ?? { tools: [], envVars: {} };
      }),

    saveConfig: t.procedure
      .input((raw): { projectId: string; config: EnvConfig } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        const config = r.config as EnvConfig;
        if (!config || !Array.isArray(config.tools) || typeof config.envVars !== 'object') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid config structure' });
        }
        return { projectId: r.projectId, config };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        await saveEnvConfig(project.rootPath, input.config);
        return { ok: true };
      }),

    getKnownEnvVars: t.procedure.query(() => {
      return getKnownEnvVarNames();
    }),
  }),

  // ─── 覆盖率分析 ───────────────────────────────────────────
  coverage: t.router({
    getOverview: t.procedure
      .input((raw): { projectId: string; runId?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId, runId: typeof r.runId === 'string' ? r.runId : undefined };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedCoverage(project.rootPath, registry);
        const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
        return mgr.getOverview(input.runId);
      }),

    getBySubsys: t.procedure
      .input((raw): { projectId: string; runId?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId, runId: typeof r.runId === 'string' ? r.runId : undefined };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedCoverage(project.rootPath, registry);
        const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
        return mgr.getBySubsys(input.runId);
      }),

    getDetail: t.procedure
      .input((raw): { projectId: string; runId?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId, runId: typeof r.runId === 'string' ? r.runId : undefined };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedCoverage(project.rootPath, registry);
        const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
        return mgr.getDetail(input.runId);
      }),

    listCachedRuns: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedCoverage(project.rootPath, registry);
        const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
        return mgr.listCachedRuns();
      }),

    getTrend: t.procedure
      .input((raw): { projectId: string; limit?: number } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId, limit: typeof r.limit === 'number' ? r.limit : undefined };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedCoverage(project.rootPath, registry);
        const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
        return mgr.getTrend(input.limit);
      }),

    getUncovered: t.procedure
      .input((raw): { projectId: string; runId: string; type: 'line' | 'toggle' | 'functional' | 'assertion' } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.runId !== 'string' || typeof r.type !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, runId and type are required' });
        }
        return { projectId: r.projectId, runId: r.runId, type: r.type as 'line' | 'toggle' | 'functional' | 'assertion' };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedCoverage(project.rootPath, registry);
        const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
        return mgr.getUncovered(input.runId, input.type);
      }),

    exportReport: t.procedure
      .input((raw): { projectId: string; runId: string; format: 'html' | 'json'; outputPath: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.runId !== 'string' || typeof r.format !== 'string' || typeof r.outputPath !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, runId, format and outputPath are required' });
        }
        return { projectId: r.projectId, runId: r.runId, format: r.format as 'html' | 'json', outputPath: r.outputPath };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedCoverage(project.rootPath, registry);
        const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
        return mgr.exportReport(input.runId, input.format, input.outputPath);
      }),
  }),

  // ─── 回归套件管理 ─────────────────────────────────────────
  regression: t.router({
    create: t.procedure
      .input((raw): { projectId: string; name: string; caseIds: string[]; options: Record<string, unknown> } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.name !== 'string' || !Array.isArray(r.caseIds)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, name and caseIds are required' });
        }
        return { projectId: r.projectId, name: r.name, caseIds: r.caseIds as string[], options: (r.options as Record<string, unknown>) ?? {} };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedSimulation(registry);
        const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
        return mgr.createSuite(input.name, input.caseIds, input.options);
      }),

    update: t.procedure
      .input((raw): { projectId: string; name: string; caseIds?: string[]; options?: Record<string, unknown> } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.name !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and name are required' });
        }
        return {
          projectId: r.projectId,
          name: r.name,
          caseIds: Array.isArray(r.caseIds) ? r.caseIds as string[] : undefined,
          options: typeof r.options === 'object' ? r.options as Record<string, unknown> : undefined,
        };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedSimulation(registry);
        const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
        return mgr.updateSuite(input.name, { caseIds: input.caseIds, options: input.options });
      }),

    delete: t.procedure
      .input((raw): { projectId: string; name: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.name !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and name are required' });
        }
        return { projectId: r.projectId, name: r.name };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedSimulation(registry);
        const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
        await mgr.deleteSuite(input.name);
        return { ok: true };
      }),

    list: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedSimulation(registry);
        const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
        return mgr.listSuites();
      }),

    run: t.procedure
      .input((raw): { projectId: string; name: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.name !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and name are required' });
        }
        return { projectId: r.projectId, name: r.name };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedSimulation(registry);
        const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
        return mgr.runSuite(input.name);
      }),

    getResult: t.procedure
      .input((raw): { projectId: string; runId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.runId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and runId are required' });
        }
        return { projectId: r.projectId, runId: r.runId };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedSimulation(registry);
        const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
        return mgr.getResult(input.runId);
      }),

    compareRuns: t.procedure
      .input((raw): { projectId: string; runId1: string; runId2: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.runId1 !== 'string' || typeof r.runId2 !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, runId1 and runId2 are required' });
        }
        return { projectId: r.projectId, runId1: r.runId1, runId2: r.runId2 };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedSimulation(registry);
        const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
        return mgr.compareRuns(input.runId1, input.runId2);
      }),

    getHistory: t.procedure
      .input((raw): { projectId: string; suiteName?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId, suiteName: typeof r.suiteName === 'string' ? r.suiteName : undefined };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);
        const adapter = new PluginBackedSimulation(registry);
        const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
        return mgr.getHistory(input.suiteName);
      }),
  }),

  // ─── Dashboard ────────────────────────────────────────────
  dashboard: t.router({
    getMetrics: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const registry = pluginLoader.getRegistry(project.rootPath);

        // Aggregate metrics from simulation history and coverage
        const simHistoryPath = join(project.rootPath, '.socverify', 'sim-history.json');
        let totalRuns = 0;
        let passRate = 0;
        try {
          const data = await readFile(simHistoryPath, 'utf-8');
          const history = JSON.parse(data) as SimulationHistoryEntry[];
          totalRuns = history.length;
          const passed = history.filter((h) => h.status === 'pass').length;
          passRate = totalRuns > 0 ? (passed / totalRuns) * 100 : 0;
        } catch {
          // No history yet
        }

        // Coverage overview
        let coverageOverview: CoverageSummary | null = null;
        try {
          const covAdapter = new PluginBackedCoverage(project.rootPath, registry);
          const covMgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: covAdapter });
          coverageOverview = (await covMgr.getOverview()).summary;
        } catch {
          // No coverage data
        }

        // Regression history
        let regressionCount = 0;
        try {
          const simAdapter = new PluginBackedSimulation(registry);
          const regMgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: simAdapter });
          const history = await regMgr.getHistory();
          regressionCount = history.length;
        } catch {
          // No regression data
        }

        return {
          passRate,
          totalRuns,
          coverage: coverageOverview,
          regressionCount,
        };
      }),

    saveLayout: t.procedure
      .input((raw): { projectId: string; layout: unknown } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId, layout: r.layout };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const layoutPath = join(project.rootPath, '.socverify', 'dashboard-layout.json');
        await mkdir(join(project.rootPath, '.socverify'), { recursive: true });
        await writeFile(layoutPath, JSON.stringify(input.layout, null, 2), 'utf-8');
        return { ok: true };
      }),

    getLayout: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const layoutPath = join(project.rootPath, '.socverify', 'dashboard-layout.json');
        try {
          const data = await readFile(layoutPath, 'utf-8');
          return JSON.parse(data);
        } catch {
          return null;
        }
      }),
  }),

  // ─── TO 检查清单 ──────────────────────────────────────────
  to: t.router({
    getChecklist: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const checklistPath = join(project.rootPath, '.socverify', 'to-checklist.json');
        try {
          const data = await readFile(checklistPath, 'utf-8');
          return JSON.parse(data) as TOChecklistItem[];
        } catch {
          // Return default checklist
          return [
            { id: 'cov-line', category: 'coverage', name: '行覆盖率达标', description: '行覆盖率 >= 95%', status: 'pending', autoEvaluated: true, threshold: 95 },
            { id: 'cov-toggle', category: 'coverage', name: '翻转覆盖率达标', description: '翻转覆盖率 >= 90%', status: 'pending', autoEvaluated: true, threshold: 90 },
            { id: 'cov-func', category: 'coverage', name: '功能覆盖率达标', description: '功能覆盖率 >= 90%', status: 'pending', autoEvaluated: true, threshold: 90 },
            { id: 'reg-pass', category: 'regression', name: '回归测试全部通过', description: '最近回归运行无失败', status: 'pending', autoEvaluated: true, threshold: 100 },
            { id: 'signoff-1', category: 'signoff', name: '设计签核', description: '设计团队负责人签核', status: 'pending', autoEvaluated: false },
            { id: 'signoff-2', category: 'signoff', name: '验证签核', description: '验证团队负责人签核', status: 'pending', autoEvaluated: false },
          ] as TOChecklistItem[];
        }
      }),

    updateItem: t.procedure
      .input((raw): { projectId: string; itemId: string; updates: Partial<TOChecklistItem> } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.itemId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and itemId are required' });
        }
        return { projectId: r.projectId, itemId: r.itemId, updates: (r.updates as Partial<TOChecklistItem>) ?? {} };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const checklistPath = join(project.rootPath, '.socverify', 'to-checklist.json');
        let items: TOChecklistItem[] = [];
        try {
          const data = await readFile(checklistPath, 'utf-8');
          items = JSON.parse(data) as TOChecklistItem[];
        } catch {
          // Start with empty if no file
        }
        const updated = items.map((item) =>
          item.id === input.itemId ? { ...item, ...input.updates } : item,
        );
        await mkdir(join(project.rootPath, '.socverify'), { recursive: true });
        await writeFile(checklistPath, JSON.stringify(updated, null, 2), 'utf-8');
        return { ok: true };
      }),

    exportReport: t.procedure
      .input((raw): { projectId: string; outputPath: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.outputPath !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and outputPath are required' });
        }
        return { projectId: r.projectId, outputPath: r.outputPath };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const checklistPath = join(project.rootPath, '.socverify', 'to-checklist.json');
        let items: TOChecklistItem[] = [];
        try {
          const data = await readFile(checklistPath, 'utf-8');
          items = JSON.parse(data) as TOChecklistItem[];
        } catch {
          // No checklist
        }
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TO Readiness Report</title></head><body><h1>TO Readiness Report</h1><table><tr><th>Item</th><th>Category</th><th>Status</th><th>Threshold</th><th>Actual</th></tr>${items.map((i) => `<tr><td>${i.name}</td><td>${i.category}</td><td>${i.status}</td><td>${i.threshold ?? '-'}</td><td>${i.actualValue ?? '-'}</td></tr>`).join('')}</table></body></html>`;
        await writeFile(input.outputPath, html, 'utf-8');
        return { path: input.outputPath };
      }),
  }),

  // ─── 凭据管理 ─────────────────────────────────────────────
  settings: t.router({
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
          // Build the models endpoint URL
          const base = baseUrl?.replace(/\/$/, '') ?? 'https://api.openai.com';
          const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
          const resp = await fetch(modelsUrl, {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
          });

          if (!resp.ok) {
            const text = await resp.text();
            throw new TRPCError({ code: 'BAD_REQUEST', message: `API returned ${resp.status}: ${text.slice(0, 200)}` });
          }

          const data = await resp.json() as Record<string, unknown>;
          const rawData = data.data;
          const modelList: Array<{ id: string; owned_by?: string }> = [];

          if (Array.isArray(rawData)) {
            for (const item of rawData) {
              if (typeof item === 'object' && item !== null && 'id' in item) {
                const m = item as { id: string; owned_by?: string };
                modelList.push({ id: m.id, owned_by: m.owned_by });
              }
            }
          } else if (typeof rawData === 'object' && rawData !== null && 'id' in rawData) {
            const m = rawData as { id: string; owned_by?: string };
            modelList.push({ id: m.id, owned_by: m.owned_by });
          }

          return modelList.map((m) => ({
            id: m.id,
            name: m.id,
            provider: input.providerId ?? 'openai',
            description: m.owned_by,
          }));
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Failed to fetch models: ${err instanceof Error ? err.message : String(err)}` });
        }
      }),

    listSkills: t.procedure.query(() => {
      // Would call agent skill list in production
      return [];
    }),

    installSkill: t.procedure
      .input((raw): { name: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.name !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'name is required' });
        }
        return { name: r.name };
      })
      .mutation(async () => {
        return { ok: true };
      }),

    uninstallSkill: t.procedure
      .input((raw): { name: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.name !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'name is required' });
        }
        return { name: r.name };
      })
      .mutation(async () => {
        return { ok: true };
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
  }),

  // ─── 全局搜索 ─────────────────────────────────────────────
  search: t.router({
    global: t.procedure
      .input((raw): { projectId: string; query: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.query !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and query are required' });
        }
        return { projectId: r.projectId, query: r.query };
      })
      .query(async ({ input }) => {
        // Search in simulation history
        const project = requireProject(input.projectId);
        const results: Array<{ type: string; label: string; detail: string }> = [];

        // Search sim history
        try {
          const simHistoryPath = join(project.rootPath, '.socverify', 'sim-history.json');
          const data = await readFile(simHistoryPath, 'utf-8');
          const history = JSON.parse(data) as SimulationHistoryEntry[];
          for (const h of history) {
            if (h.caseName.includes(input.query) || h.caseId.includes(input.query)) {
              results.push({
                type: 'simulation',
                label: h.caseName,
                detail: `${h.status} · ${new Date(h.startTime).toLocaleString()}`,
              });
            }
          }
        } catch {
          // No history
        }

        // Search regression suites
        try {
          const registry = pluginLoader.getRegistry(project.rootPath);
          const simAdapter = new PluginBackedSimulation(registry);
          const regMgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: simAdapter });
          const suites = await regMgr.listSuites();
          for (const s of suites) {
            if (s.name.includes(input.query)) {
              results.push({
                type: 'regression',
                label: s.name,
                detail: `${s.caseIds.length} cases`,
              });
            }
          }
        } catch {
          // No suites
        }

        return results;
      }),
  }),
});

export type AppRouter = typeof router;
