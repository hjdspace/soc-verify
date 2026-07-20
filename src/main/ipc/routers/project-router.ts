/**
 * Project router — open, close, list, file tree, subsystems, cases, plugins, diff review.
 */

import { join, relative } from 'node:path';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { dialog, shell } from 'electron';
import { t, TRPCError, requireProject, ensurePluginsLoaded } from '../router-context';
import { projectManager } from '../../project/project-manager';
import { pluginLoader } from '../../plugins/loader';
import { PluginBackedDiscovery } from '../../host/plugin-discovery';
import type { CaseStatus } from '../../host/discovery';
import { getFileDiff, applyRejections } from '../../diff/diff-engine';
import type {
  PluginConfig,
  PluginConfigEntry,
  ProjectState,
  DiffToolCall,
  DiffRejection,
} from '@shared/types';

export const projectRouter = t.router({
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

  // ─── File / Folder picker (for AI context) ────────

  pickFiles: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .mutation(async ({ input }) => {
      console.log('[pickFiles] Called with projectId:', input.projectId);
      const project = requireProject(input.projectId);
      console.log('[pickFiles] Project root path:', project.rootPath);
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        title: '选择文件添加到上下文',
        defaultPath: project.rootPath,
      });
      console.log('[pickFiles] Dialog result:', result);
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const };
      }
      const files = result.filePaths.map((fp) => {
        const parts = fp.split(/[/\\]/);
        return { name: parts[parts.length - 1] || fp, path: fp, type: 'file' as const };
      });
      return { canceled: false as const, files };
    }),

  pickFolder: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .mutation(async ({ input }) => {
      console.log('[pickFolder] Called with projectId:', input.projectId);
      const project = requireProject(input.projectId);
      console.log('[pickFolder] Project root path:', project.rootPath);
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: '选择文件夹添加到上下文',
        defaultPath: project.rootPath,
      });
      console.log('[pickFolder] Dialog result:', result);
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const };
      }
      const fp = result.filePaths[0];
      const parts = fp.split(/[/\\]/);
      return {
        canceled: false as const,
        folder: { name: parts[parts.length - 1] || fp, path: fp, type: 'directory' as const },
      };
    }),

  // ─── Open file / directory in system ───────────────────

  openInSystem: t.procedure
    .input((raw): { path: string; type: 'file' | 'directory' } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.path !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'path is required' });
      }
      if (r.type !== 'file' && r.type !== 'directory') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'type must be "file" or "directory"' });
      }
      return { path: r.path, type: r.type as 'file' | 'directory' };
    })
    .mutation(async ({ input }) => {
      if (input.type === 'directory') {
        const errorMessage = await shell.openPath(input.path);
        if (errorMessage) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: errorMessage });
        }
      } else {
        // Open file with text editor: notepad on Windows, gvim on Linux
        const editor = process.platform === 'win32' ? 'notepad' : 'gvim';
        exec(`"${editor}" "${input.path}"`, (error) => {
          if (error) {
            console.error(`[openInSystem] Failed to open file with ${editor}:`, error);
          }
        });
      }
      return { ok: true };
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
});
