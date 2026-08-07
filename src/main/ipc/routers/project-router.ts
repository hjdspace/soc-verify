/**
 * Project router — open, close, list, file tree, subsystems, cases, plugins, diff review.
 */

import { join, relative } from 'node:path';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { dialog, shell } from 'electron';
import { t, TRPCError } from '../router-context';
import { requireProject, ensurePluginsLoaded } from '../../services/project-service';
import { projectManager } from '../../project/project-manager';
import { pluginLoader } from '../../plugins/loader';
import type { CaseStatus } from '../../host/discovery';
import { getFileDiff, applyRejections } from '../../diff/diff-engine';
import { caseStatsRegistry } from '../../case/case-stats-registry';
import { simulationRegistry } from '../../simulation/simulation-registry';
import type { CaseStatsService } from '../../case/case-stats-service';
import { getScanMetadata, getSubsysWithCaseCount } from '../../case/db/case-repository';
import type {
  PluginConfig,
  PluginConfigEntry,
  ProjectState,
  DiffToolCall,
  DiffRejection,
} from '@shared/types';

/**
 * 获取或创建指定项目的 CaseStatsService（UI tRPC 与 AI HostTools 共享）。
 *
 * 不主动创建 SimulationManager——仅在已存在时注入，避免查询路径过早创建。
 * SimulationManager 会在首次仿真运行时由 simulation-service 创建并回填到 service。
 *
 * 当 DB 可用时（ADR 0017），CaseStatsService 从 DB 读取数据（秒开）。
 */
async function getCaseStatsService(projectId: string): Promise<CaseStatsService> {
  const project = requireProject(projectId);
  await ensurePluginsLoaded(project.rootPath);
  const registry = pluginLoader.getRegistry(project.rootPath);
  const simManager = simulationRegistry.get(project.rootPath);
  return caseStatsRegistry.getOrCreate(project.rootPath, registry, simManager);
}

/**
 * 获取或创建指定项目的 CaseScanner（ADR 0017）。
 * 用于 refreshCases 全量扫描和项目打开时后台增量扫描。
 */
async function getCaseScanner(projectId: string) {
  const project = requireProject(projectId);
  await ensurePluginsLoaded(project.rootPath);
  const registry = pluginLoader.getRegistry(project.rootPath);
  return caseStatsRegistry.getOrCreateScanner(project.rootPath, registry);
}

/**
 * 后台触发 Case Scanner 增量扫描（fire-and-forget）。
 *
 * 项目打开时调用：有 DB 数据则 UI 秒开，后台扫描有差异则更新 DB。
 * 扫描失败只记日志，不影响 UI 响应。
 */
function triggerBackgroundScan(projectId: string, projectRoot: string): void {
  // fire-and-forget — 不 await，不阻塞 UI 响应
  ensurePluginsLoaded(projectRoot)
    .then(() => {
      const registry = pluginLoader.getRegistry(projectRoot);
      if (registry.subsysDiscoverers.length === 0 || registry.caseParsers.length === 0) {
        return;
      }
      const scanner = caseStatsRegistry.getOrCreateScanner(projectRoot, registry);
      return scanner.fullScan().then((result) => {
        console.log(
          `[router:triggerBackgroundScan] project=${projectId}, ` +
          `scanned ${result.subsysCount} subsystems, ${result.caseCount} cases`,
        );
      });
    })
    .catch((err) => {
      console.error(`[router:triggerBackgroundScan] background scan failed for project=${projectId}:`, err);
    });
}

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
      await pluginLoader.activateForEvent(info.rootPath, 'onProjectOpen');
      await pluginLoader.emitEvent(info.rootPath, 'project.opened', info);
      const _registry = pluginLoader.getRegistry(info.rootPath);

      // 后台触发 Case Scanner 增量扫描（ADR 0017）
      // 有 DB 数据则 UI 秒开，后台扫描有差异则更新 DB
      triggerBackgroundScan(info.id, info.rootPath);

      // Return plugin load info alongside project info
      const plugins = loadResults.map((r) => ({
        id: r.manifest.id,
        apiVersion: r.manifest.apiVersion,
        name: r.manifest.name,
        version: r.manifest.version,
        kind: r.manifest.kind,
        source: r.source,
        path: r.path,
        contributes: r.contributes,
        active: r.active ?? false,
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
      await pluginLoader.activateForEvent(info.rootPath, 'onProjectOpen');
      await pluginLoader.emitEvent(info.rootPath, 'project.opened', info);

      // 后台触发 Case Scanner 增量扫描（ADR 0017）
      triggerBackgroundScan(info.id, info.rootPath);

      const plugins = loadResults.map((r) => ({
        id: r.manifest.id,
        apiVersion: r.manifest.apiVersion,
        name: r.manifest.name,
        version: r.manifest.version,
        kind: r.manifest.kind,
        source: r.source,
        path: r.path,
        contributes: r.contributes,
        active: r.active ?? false,
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
      await pluginLoader.emitEvent(project.rootPath, 'project.closed', project);
      await pluginLoader.deactivateProject(project.rootPath);
      pluginLoader.clearProject(project.rootPath);
      // 关闭 DB 连接，释放资源（ADR 0017）
      caseStatsRegistry.remove(project.rootPath);
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

      // 走 CaseStatsService 填充真实 caseCount（原 PluginBackedDiscovery 永远返回 0）
      const statsService = await getCaseStatsService(input.projectId);
      const result = await statsService.listSubsysWithCaseCount(input.filter);
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

      // 走 CaseStatsService：status 实时 join 自 SimulationManager 历史
      const statsService = await getCaseStatsService(input.projectId);
      const cases = await statsService.listCasesWithStatus(input.subsys);
      const status = input.status as CaseStatus | undefined;
      if (status && status !== 'all') {
        return cases.filter((c) => c.status === status);
      }
      return cases;
    }),

  searchCases: t.procedure
    .input((raw): { projectId: string; query: string; subsys?: string; limit?: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.query !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and query are required' });
      }
      return {
        projectId: r.projectId,
        query: r.query,
        subsys: typeof r.subsys === 'string' && r.subsys.length > 0 ? r.subsys : undefined,
        limit: typeof r.limit === 'number' ? r.limit : 200,
      };
    })
    .query(async ({ input }) => {
      // 走 CaseStatsService：DB LIKE 查询替代内存倒排索引（ADR 0017）
      const statsService = await getCaseStatsService(input.projectId);
      return statsService.searchCases(input.query, input.subsys, input.limit);
    }),

  /** 获取用例索引统计信息（从 DB 聚合） */
  getIndexStats: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      const db = caseStatsRegistry.getDb(project.rootPath);
      if (!db) return null;
      const subsysRows = getSubsysWithCaseCount(db);
      return {
        caseCount: subsysRows.reduce((sum, s) => sum + s.caseCount, 0),
        subsysCount: subsysRows.length,
      };
    }),

  /** 手动重建用例索引（触发全量扫描刷新 DB） */
  rebuildIndex: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .mutation(async ({ input }) => {
      const scanner = await getCaseScanner(input.projectId);
      const scanResult = await scanner.fullScan({ sync: true });
      const db = caseStatsRegistry.getDb(requireProject(input.projectId).rootPath);
      if (!db) return null;
      const subsysRows = getSubsysWithCaseCount(db);
      return {
        caseCount: subsysRows.reduce((sum, s) => sum + s.caseCount, 0),
        subsysCount: subsysRows.length,
        scanResult,
      };
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
          apiVersion: r.manifest.apiVersion,
          name: r.manifest.name,
          version: r.manifest.version,
          kind: r.manifest.kind,
          description: r.manifest.description,
          source: r.source,
          path: r.path,
          contributes: r.contributes,
          active: r.active ?? false,
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
      await pluginLoader.activateForEvent(project.rootPath, 'onProjectOpen');

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
      await pluginLoader.activateForEvent(project.rootPath, 'onProjectOpen');

      return { ok: true };
    }),

  invokePluginCommand: t.procedure
    .input((raw): { projectId: string; command: string; args?: unknown[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.command !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and command are required' });
      }
      return {
        projectId: r.projectId,
        command: r.command,
        args: Array.isArray(r.args) ? r.args : [],
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      await ensurePluginsLoaded(project.rootPath);
      try {
        return {
          result: await pluginLoader.executeCommand(project.rootPath, input.command, input.args),
        };
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  getPluginNotifications: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      return pluginLoader.getNotifications(project.rootPath);
    }),

  clearPluginNotifications: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .mutation(({ input }) => {
      const project = requireProject(input.projectId);
      pluginLoader.clearNotifications(project.rootPath);
      return { ok: true };
    }),

  activatePluginView: t.procedure
    .input((raw): { projectId: string; pluginId: string; viewId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.pluginId !== 'string' || typeof r.viewId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, pluginId and viewId are required' });
      }
      return { projectId: r.projectId, pluginId: r.pluginId, viewId: r.viewId };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      await ensurePluginsLoaded(project.rootPath);
      await pluginLoader.activateForView(project.rootPath, input.pluginId, input.viewId);
      return { ok: true };
    }),

  reloadPlugins: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const results = await pluginLoader.loadPlugins(project.rootPath);
      await pluginLoader.activateForEvent(project.rootPath, 'onProjectOpen');
      return results.map((result) => ({
        id: result.manifest.id,
        apiVersion: result.manifest.apiVersion,
        name: result.manifest.name,
        version: result.manifest.version,
        kind: result.manifest.kind,
        source: result.source,
        path: result.path,
        contributes: result.contributes,
        active: result.active ?? false,
        enabled: !result.error,
        error: result.error,
      }));
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
      if (registry.subsysDiscoverers.length === 0) {
        return { subsystemCount: 0, caseCount: 0, passRate: 0 };
      }

      // 走 CaseStatsService：与 AI get_project_overview 同源，passRate 基于实时 status
      const statsService = await getCaseStatsService(input.projectId);
      const overview = await statsService.getProjectOverview();
      const passCount = overview.bySubsys.reduce((sum, s) => sum + s.byStatus.pass, 0);
      return {
        subsystemCount: overview.subsysCount,
        caseCount: overview.totalCases,
        passRate: overview.totalCases > 0 ? (passCount / overview.totalCases) * 100 : 0,
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

  // ─── Open HTML file in external browser ────────────────

  openInExternalBrowser: t.procedure
    .input((raw): { path: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.path !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'path is required' });
      }
      return { path: r.path };
    })
    .mutation(async ({ input }) => {
      // shell.openPath opens a file with the system's default application.
      // For .html / .htm files this is the default web browser on all platforms.
      const errorMessage = await shell.openPath(input.path);
      if (errorMessage) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: errorMessage });
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

  /**
   * 刷新用例树缓存。
   *
   * 当用户修改了 case_cfg（增加/删除/重命名用例）后，
   * 调用此 procedure 清除 discovery 内部缓存和搜索索引，
   * 使得下次 getSubsystems / getCases / searchCases 返回最新数据。
   *
   * 传入 subsys 时仅刷新该子系统的用例缓存（快速刷新）；
   * 不传时刷新全部缓存。
   */
  refreshCases: t.procedure
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
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      // 清除 discovery 缓存（按子系统或全部）
      caseStatsRegistry.clearDiscoveryCache(project.rootPath, input.subsys);

      // 触发 Case Scanner 全量扫描并更新 DB（ADR 0017）
      const scanner = await getCaseScanner(input.projectId);
      const scanResult = await scanner.fullScan({ sync: true });
      console.log(`[router:refreshCases] scan complete: ${scanResult.subsysCount} subsystems, ${scanResult.caseCount} cases`);

      return { ok: true, scanResult };
    }),

  /**
   * 查询后台扫描状态（ADR 0017）。
   *
   * 返回 idle / scanning / complete + 最后扫描时间。
   * 前端可轮询此 procedure 在扫描完成后刷新 UI。
   */
  scanStatus: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      const db = caseStatsRegistry.getDb(project.rootPath);
      if (!db) {
        return { status: 'idle' as const, lastScanTime: null };
      }
      const status = getScanMetadata(db, 'scanStatus') ?? 'idle';
      const lastScanTime = getScanMetadata(db, 'lastScanTime');
      return { status, lastScanTime };
    }),
});
