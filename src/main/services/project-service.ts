/**
 * Project domain service — project lookup and plugin loading helpers.
 *
 * Encapsulates the coordination between ProjectManager, PluginLoader, and
 * the tRPC error boundary. Previously these helpers lived in the
 * kitchen-sink router-context.ts.
 *
 * 「活跃项目」是渲染端的一等概念（最近打开的项目），主进程此前无人拥有 ——
 * kb-router 私有 getActiveProjectRoot() 手写了一份排序取最新的逻辑。
 * 现收归到本模块，下一个需要「当前项目」的 router 直接消费 activeProject()。
 */

import { TRPCError } from '@trpc/server';
import { projectManager } from '../project/project-manager';
import { pluginLoader } from '../plugins/loader';
import type { ProjectInfo } from '@shared/types';

/**
 * Look up a project by ID or throw a NOT_FOUND tRPC error.
 */
export function requireProject(projectId: string): ProjectInfo {
  const project = projectManager.getProject(projectId);
  if (!project) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Project not found: ${projectId}` });
  }
  return project;
}

/**
 * 获取当前活跃项目（单用户桌面应用：取最近打开的项目）。
 *
 * 此前 kb-router 私有 getActiveProjectRoot() 手写了一份「排序取最新」逻辑，
 * 现收归到此，统一为「活跃项目」概念的单一拥有者。
 *
 * @returns 最近打开的项目；无项目时抛 NOT_FOUND。
 */
export function activeProject(): ProjectInfo {
  const projects = projectManager.listProjects();
  if (projects.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: '未找到打开的项目，请先打开项目' });
  }
  // 取最近打开的项目
  const latest = projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
  return latest;
}

/**
 * Ensure plugins are loaded for a project root path.
 * When a project is restored from persisted state (not opened via project.open),
 * loadPlugins() may never have been called. This lazy-loads plugins on demand.
 */
export async function ensurePluginsLoaded(rootPath: string): Promise<void> {
  const loadResults = pluginLoader.getLoadResults(rootPath);
  if (loadResults.length === 0) {
    console.log(`[router] lazy-loading plugins for ${rootPath}`);
    await pluginLoader.loadPlugins(rootPath);
  }
}
