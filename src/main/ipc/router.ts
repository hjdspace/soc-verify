import { initTRPC, TRPCError } from '@trpc/server';
import { sessionManager } from '../omp/session-manager';
import { resolveOmpRuntime, resolveBunPath, resolveOmpEntryPath } from '../omp/paths';
import { projectManager } from '../project/project-manager';
import { pluginLoader } from '../plugins/loader';
import { PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage } from '../omp/plugin-discovery';
import type { CaseStatus } from '../omp/discovery';
import { dialog, ipcMain, BrowserWindow } from 'electron';
import type {
  ProjectInfo,
  ProjectState,
  FileTreeNode,
  PluginConfig,
  PluginConfigEntry,
} from '@shared/types';
import type { PluginLoadResult } from '@shared/plugin-types';

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

export const router = t.router({
  ping: t.procedure.query(() => 'pong' as const),

  version: t.procedure.query(() => ({
    app: 'soc-verify',
    version: '0.2.0',
    stage: 'M2' as const,
  })),

  // ─── 系统 ─────────────────────────────────────────────

  system: t.router({
    resolveOmp: t.procedure.query(() => {
      const runtime = resolveOmpRuntime();
      return {
        available: runtime !== null,
        bunPath: resolveBunPath(),
        ompEntryPath: resolveOmpEntryPath(),
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
        const registry = pluginLoader.getRegistry(project.rootPath);
        if (registry.subsysDiscoverers.length === 0) return [];

        const discovery = new PluginBackedDiscovery(project.rootPath, registry);
        return discovery.listSubsys(input.filter);
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
        const registry = pluginLoader.getRegistry(project.rootPath);
        const discovery = new PluginBackedDiscovery(project.rootPath, registry);
        const simulation = new PluginBackedSimulation(registry);
        const coverage = new PluginBackedCoverage(project.rootPath, registry);

        const sessionId = await sessionManager.createSession({
          projectId: input.projectId,
          cwd: input.cwd,
          provider: input.provider,
          model: input.model,
          discovery,
          simulationAdapter: simulation,
          coverageAdapter: coverage,
        });
        return { sessionId };
      }),

    send: t.procedure
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
        await client.prompt(input.message);
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
      .input((raw): { sessionId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.sessionId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
        }
        return { sessionId: r.sessionId };
      })
      .mutation(async ({ input }) => {
        await sessionManager.destroySession(input.sessionId);
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
  }),
});

export type AppRouter = typeof router;
