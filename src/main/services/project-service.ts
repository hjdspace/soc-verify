/**
 * Project domain service — project lookup and plugin loading helpers.
 *
 * Encapsulates the coordination between ProjectManager, PluginLoader, and
 * the tRPC error boundary. Previously these helpers lived in the
 * kitchen-sink router-context.ts.
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
