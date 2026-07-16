import { initTRPC, TRPCError } from '@trpc/server';
import { join, relative, basename, resolve, isAbsolute } from 'node:path';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sessionManager } from '../agent/session-manager';
import { resolveAgentRuntime, resolveRunnerBinary, resolveRunnerScript, resolveBunPath } from '../agent/paths';
import { projectManager } from '../project/project-manager';
import { pluginLoader } from '../plugins/loader';
import { PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage } from '../host/plugin-discovery';
import type { CaseStatus } from '../host/discovery';
import { simulationRegistry } from '../simulation/simulation-registry';
import { simTerminalLinker } from '../simulation/sim-terminal-linker';
import { detectEdaTools, loadEnvConfig, saveEnvConfig, getKnownEnvVarNames } from '../env/env-manager';
import { CoverageManager } from '../coverage/coverage-manager';
import { RegressionManager } from '../regression/regression-manager';
import { terminalManager } from '../terminal/terminal-manager';
import { credentialManager } from '../credentials/credential-manager';
import { sourceControlService } from '../scm/source-control';
import { addSession, removeSession, loadSessions, saveSessions, updateSessionModel, updateSessionActivity, type PersistedSession } from '../agent/session-persistence';
import { discoverSkills, readSkillContent } from '../agent/skill-discovery';
import { errorAnalysisCoordinator } from '../simulation/error-analysis-coordinator';
import { logAnalyzer } from '../simulation/log-analyzer';
import { getFileDiff, applyRejections } from '../diff/diff-engine';
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
  ErrorType,
  ErrorAnalysisSession,
  DiffToolCall,
  DiffRejection,
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

function storedMessagesPath(projectRoot: string, sessionId: string): string {
  return join(projectRoot, '.socverify', 'chat-messages', `${encodeURIComponent(sessionId)}.json`);
}

async function loadStoredMessages(projectRoot: string, sessionId: string): Promise<unknown[]> {
  try {
    const data = await readFile(storedMessagesPath(projectRoot, sessionId), 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isPlaceholderSessionName(name: string): boolean {
  return name === '新会话' || /^Session [A-Za-z0-9_-]+$/.test(name);
}

async function filterEmptyPlaceholderSessions(
  projectRoot: string,
  sessions: PersistedSession[],
): Promise<PersistedSession[]> {
  const visible: PersistedSession[] = [];
  for (const session of sessions) {
    if (!isPlaceholderSessionName(session.name)) {
      visible.push(session);
      continue;
    }
    const messages = await loadStoredMessages(projectRoot, session.sessionId);
    if (messages.length > 0) visible.push(session);
  }
  return visible;
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
        mode: runtime?.mode ?? null,
        runnerBinaryPath: resolveRunnerBinary(),
        runnerScriptPath: resolveRunnerScript(),
        bunPath: resolveBunPath(),
        runnerPath: runtime?.runnerPath ?? null,
        bunVersion: runtime?.bunVersion ?? null,
        bunVersionOk: runtime?.bunVersionOk ?? false,
      };
    }),
  }),

  // ─── 源代码管理 ───────────────────────────────────────

  scm: t.router({
    status: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        return sourceControlService.getStatus(project.rootPath);
      }),

    generateCommitMessage: t.procedure
      .input((raw): { projectId: string; modelId?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return {
          projectId: r.projectId,
          modelId: typeof r.modelId === 'string' ? r.modelId : undefined,
        };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const credential = await credentialManager.getDefaultCredential();
        if (!credential) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'No AI credential configured. Add one in Settings first.',
          });
        }
        try {
          const message = await sourceControlService.generateCommitMessage(project.rootPath, credential, input.modelId);
          return { message };
        } catch (err) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }),

    commitAll: t.procedure
      .input((raw): { projectId: string; message: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.message !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and message are required' });
        }
        return { projectId: r.projectId, message: r.message };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        try {
          return await sourceControlService.commitAll(project.rootPath, input.message);
        } catch (err) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: err instanceof Error ? err.message : String(err),
          });
        }
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

    searchFiles: t.procedure
      .input((raw): { projectId: string; query: string; limit?: number } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.query !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and query are required' });
        }
        return {
          projectId: r.projectId,
          query: r.query,
          limit: typeof r.limit === 'number' ? r.limit : 50,
        };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const rootPath = project.rootPath;
        const query = input.query.toLowerCase();
        const limit = input.limit ?? 50;
        const results: Array<{ name: string; path: string; type: 'file' | 'directory' }> = [];

        // Ignore patterns matching the file tree builder
        const ignorePatterns = [
          'node_modules', '.git', '.socverify', 'out', 'dist', 'build',
          '__pycache__', '.next', 'coverage', 'work', 'sim_build',
        ];
        const ignoreExts = ['.pyc', '.log', '.tmp', '.o', '.a', '.so', '.dll', '.exe'];

        function shouldIgnore(name: string): boolean {
          if (ignorePatterns.includes(name)) return true;
          if (ignoreExts.some((ext) => name.endsWith(ext))) return true;
          return false;
        }

        async function walkDir(dirPath: string, depth: number): Promise<void> {
          if (results.length >= limit) return;
          if (depth > 5) return;

          try {
            const entries = await readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
              if (results.length >= limit) return;
              if (shouldIgnore(entry.name)) continue;

              const fullPath = join(dirPath, entry.name);
              const relPath = relative(rootPath, fullPath);
              const matches = entry.name.toLowerCase().includes(query) || relPath.toLowerCase().includes(query);

              if (matches) {
                results.push({
                  name: entry.name,
                  path: fullPath,
                  type: entry.isDirectory() ? 'directory' : 'file',
                });
              }

              if (entry.isDirectory() && depth < 5) {
                await walkDir(fullPath, depth + 1);
              }
            }
          } catch {
            // Permission errors — skip
          }
        }

        await walkDir(rootPath, 0);
        return results;
      }),

    // ─── Diff Review ──────────────────────────────────

    getFileDiff: t.procedure
      .input((raw): { projectId: string; filePath: string; toolCalls: DiffToolCall[] } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.filePath !== 'string' || !Array.isArray(r.toolCalls)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, filePath and toolCalls are required' });
        }
        return {
          projectId: r.projectId,
          filePath: r.filePath,
          toolCalls: r.toolCalls as DiffToolCall[],
        };
      })
      .query(async ({ input }) => {
        const project = requireProject(input.projectId);
        const rel = relative(project.rootPath, input.filePath);
        if (rel.startsWith('..')) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'File path is outside project root' });
        }
        return getFileDiff(input.filePath, input.toolCalls);
      }),

    applyDiffRejections: t.procedure
      .input((raw): { projectId: string; filePath: string; rejections: DiffRejection[] } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.filePath !== 'string' || !Array.isArray(r.rejections)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, filePath and rejections are required' });
        }
        return {
          projectId: r.projectId,
          filePath: r.filePath,
          rejections: r.rejections as DiffRejection[],
        };
      })
      .mutation(async ({ input }) => {
        const project = requireProject(input.projectId);
        const rel = relative(project.rootPath, input.filePath);
        if (rel.startsWith('..')) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'File path is outside project root' });
        }
        return applyRejections(input.filePath, input.rejections);
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
        const ompSessionId = sessionManager.getOmpSessionId(sessionId);
        const persisted: PersistedSession = {
          sessionId,
          ompSessionId,
          name: '新会话',
          projectId: input.projectId,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          model: provider && input.model ? { provider, id: input.model, name: input.model } : undefined,
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
      .input((raw): { sessionId: string; provider: string; modelId: string; modelName?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.sessionId !== 'string' || typeof r.provider !== 'string' || typeof r.modelId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId, provider and modelId are required' });
        }
        return { sessionId: r.sessionId, provider: r.provider, modelId: r.modelId, modelName: typeof r.modelName === 'string' ? r.modelName : undefined };
      })
      .mutation(async ({ input }) => {
        await sessionManager.setModel(input.sessionId, input.provider, input.modelId);
        // Persist model info so it survives app restarts
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
        return filterEmptyPlaceholderSessions(project.rootPath, await loadSessions(project.rootPath));
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

        // Load persisted session to restore model info and omp sessionId
        const persistedSessions = await loadSessions(project.rootPath);
        const persisted = persistedSessions.find((s) => s.sessionId === input.sessionId);

        // Load stored credentials for env vars
        const credEnv = await credentialManager.buildEnvForAgent();
        const defaultCred = await credentialManager.getDefaultCredential();
        const provider = persisted?.model?.provider ?? (defaultCred ? credentialManager.mapProviderForAgent(defaultCred.providerId) : undefined);
        const apiKey = defaultCred?.apiKey;
        const baseUrl = defaultCred?.baseUrl;

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
          // Use the omp sessionId for resume — this is what the runner matches against
          resumeSessionId: persisted?.ompSessionId ?? input.sessionId,
          persistedSessionId: input.sessionId,
          env: credEnv,
        });

        // Persist the latest runtime resume handle and activity timestamp.
        const ompSessionId = sessionManager.getOmpSessionId(sessionId);
        const sessions = await loadSessions(project.rootPath);
        const idx = sessions.findIndex((s) => s.sessionId === input.sessionId);
        if (idx >= 0) {
          sessions[idx] = {
            ...sessions[idx],
            ompSessionId,
            lastActivityAt: Date.now(),
          };
          await saveSessions(project.rootPath, sessions);
        } else {
          await updateSessionActivity(project.rootPath, input.sessionId);
        }

        return { sessionId, name: input.name ?? `Session ${input.sessionId.slice(-6)}`, model: persisted?.model };
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
        const project = requireProject(input.projectId);
        const manager = getSimulationManager(input.projectId);
        if (!manager.hasRunner()) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No simulation-runner plugin loaded' });
        }
        const handle = await manager.run({ ...input.options, projectRoot: project.rootPath });
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

    // ── 终端仿真（在终端 PTY 中执行 runsim 命令）──────────

    /**
     * 在终端中启动仿真：创建 PTY 会话 → 写入 runsim 命令 → 注册仿真跟踪。
     *
     * 与 `simulation.run` 不同，此过程不会在隐藏子进程中执行仿真，
     * 而是在可见终端中执行，用户可以实时查看仿真输出。
     * 仿真状态通过终端退出码判定（0=pass, 非零=fail）。
     */
    runInTerminal: t.procedure
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
        const project = requireProject(input.projectId);
        await ensurePluginsLoaded(project.rootPath);
        const registry = pluginLoader.getRegistry(project.rootPath);
        if (registry.simulationRunners.length === 0) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No simulation-runner plugin loaded' });
        }

        // 获取仿真 runner 插件路径，重新 require 以访问导出的命令生成函数
        const loadResults = pluginLoader.getLoadResults(project.rootPath);
        const simRunnerResult = loadResults.find(
          (r) => r.manifest.kind === 'simulation-runner' && !r.error,
        );
        if (!simRunnerResult) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Simulation runner plugin path not found' });
        }

        const pluginPath =
          simRunnerResult.source === 'local' && !isAbsolute(simRunnerResult.path)
            ? resolve(project.rootPath, simRunnerResult.path)
            : simRunnerResult.path;

        const nodeRequire = createRequire(import.meta.url);
        const mod = nodeRequire(pluginPath);

        const opts: SimulationRunOptions = { ...input.options, projectRoot: project.rootPath };

        // 生成 runsim 命令
        const command: string | null =
          typeof mod.generateRunsimCommand === 'function'
            ? mod.generateRunsimCommand(opts)
            : null;
        const cwd: string =
          typeof mod.resolveCwd === 'function'
            ? mod.resolveCwd(opts)
            : project.rootPath;

        if (!command) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Simulation runner plugin does not export generateRunsimCommand',
          });
        }

        // 创建终端 PTY 会话（初始工作目录为 resolveCwd 的结果）
        const session = await terminalManager.create({ cwd });

        // 等待 shell 初始化完成（PTY 启动后 shell 需要短暂时间初始化并显示提示符）
        await new Promise(resolve => setTimeout(resolve, 500));

        // 写入仿真命令到终端：
        //   - 若 $PROJ_WORK 环境变量已定义，先执行 cd "$PROJ_WORK" 切换到项目工作目录
        //   - 若未定义，终端已在 resolveCwd 返回的 cwd 中，直接执行 runsim 命令
        //   - 追加 '; echo "__SIM_DONE__$?__"' 作为完成标记（不执行 exit，shell 保持存活）
        //     simTerminalLinker 监听终端输出，检测到标记后判定 pass/fail
        //   - 使用 \r（回车）而非 \n 作为 PTY 的 Enter 键
        const projWork = process.env.PROJ_WORK;
        const cdPrefix = projWork ? `cd "${projWork}" && ` : '';
        const displayCommand = `${cdPrefix}${command}`;
        const execCommand = `${displayCommand}; echo "__SIM_DONE__$?__"`;
        terminalManager.write(session.id, `${execCommand}\r`);

        // 注册仿真-终端关联（监听终端退出 → 判定 pass/fail）
        const run = simTerminalLinker.register(
          input.projectId,
          session.id,
          displayCommand,
          cwd,
          input.options,
        );

        return {
          runId: run.runId,
          terminalId: session.id,
          command: displayCommand,
          cwd,
        };
      }),

    /**
     * 获取当前活跃的终端仿真运行列表。
     */
    getActiveTerminalRuns: t.procedure
      .input((raw): { projectId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
        }
        return { projectId: r.projectId };
      })
      .query(({ input }) => {
        return simTerminalLinker.getActiveRuns(input.projectId);
      }),

    /**
     * 中止终端仿真运行（销毁终端 PTY 会话）。
     */
    abortTerminalRun: t.procedure
      .input((raw): { terminalId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.terminalId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'terminalId is required' });
        }
        return { terminalId: r.terminalId };
      })
      .mutation(({ input }) => {
        simTerminalLinker.abort(input.terminalId);
        return { ok: true };
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

    /**
     * Get the buffered output for a terminal session.
     * Used by TerminalView to restore output when the component is remounted
     * (e.g., switching tabs and switching back).
     */
    getOutputBuffer: t.procedure
      .input((raw): { terminalId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.terminalId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'terminalId is required' });
        }
        return { terminalId: r.terminalId };
      })
      .query(({ input }) => {
        return terminalManager.getOutputBuffer(input.terminalId);
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

  // ─── 错误分析 ─────────────────────────────────────────────

  errorAnalysis: t.router({
    /**
     * 获取所有活跃的错误分析会话
     */
    listActive: t.procedure
      .input((raw): { projectId?: string } => {
        const r = raw as Record<string, unknown>;
        return { projectId: typeof r.projectId === 'string' ? r.projectId : undefined };
      })
      .query(({ input }) => {
        const sessions = errorAnalysisCoordinator.getActiveSessions();
        return input.projectId
          ? sessions.filter((s: ErrorAnalysisSession) => s.projectId === input.projectId)
          : sessions;
      }),

    /**
     * 获取特定错误分析会话状态
     */
    getStatus: t.procedure
      .input((raw): { sessionId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.sessionId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
        }
        return { sessionId: r.sessionId };
      })
      .query(({ input }) => {
        const session = errorAnalysisCoordinator.getSession(input.sessionId);
        if (!session) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `Error analysis session not found: ${input.sessionId}` });
        }
        return session;
      }),

    /**
     * 分析指定用例的错误类型和上下文（不创建 AI 会话）
     */
    analyzeErrors: t.procedure
      .input((raw): { caseName: string; cwd?: string; projectId?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.caseName !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'caseName is required' });
        }
        return {
          caseName: r.caseName,
          cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
          projectId: typeof r.projectId === 'string' ? r.projectId : undefined,
        };
      })
      .query(({ input }) => {
        // Resolve cwd from projectId if not provided
        let cwd = input.cwd;
        if (!cwd && input.projectId) {
          const project = projectManager.getProject(input.projectId);
          cwd = project?.rootPath;
        }
        const result = logAnalyzer.analyzeErrors(input.caseName, cwd);
        return result;
      }),

    /**
     * 获取编译/仿真日志路径
     */
    getLogPaths: t.procedure
      .input((raw): { caseName: string; cwd?: string; projectId?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.caseName !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'caseName is required' });
        }
        return {
          caseName: r.caseName,
          cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
          projectId: typeof r.projectId === 'string' ? r.projectId : undefined,
        };
      })
      .query(({ input }) => {
        let cwd = input.cwd;
        if (!cwd && input.projectId) {
          const project = projectManager.getProject(input.projectId);
          cwd = project?.rootPath;
        }
        return {
          compileLogPath: logAnalyzer.getCompileLogPath(input.caseName, cwd),
          simLogPath: logAnalyzer.getSimulationLogPath(input.caseName, cwd),
        };
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
