/**
 * Shared tRPC builder and helper functions used by all sub-routers.
 *
 * Extracting these into a dedicated module ensures every sub-router uses the
 * same `t` instance (required for type-safe merging) and avoids duplicating
 * the small set of validation/lookup helpers that many procedures rely on.
 */

import { initTRPC, TRPCError } from '@trpc/server';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { sessionManager } from '../agent/session-manager';
import { projectManager } from '../project/project-manager';
import { pluginLoader } from '../plugins/loader';
import { PluginBackedSimulation } from '../host/plugin-discovery';
import { simulationRegistry } from '../simulation/simulation-registry';
import type { PersistedSession } from '../agent/session-persistence';
import type { ProjectInfo } from '@shared/types';

export { TRPCError };
export const t = initTRPC.create();

// ─── Shared helpers ──────────────────────────────────────────

export function requireSession(sessionId: string) {
  const client = sessionManager.getClient(sessionId);
  if (!client) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Session not found: ${sessionId}` });
  }
  return client;
}

export function requireProject(projectId: string): ProjectInfo {
  const project = projectManager.getProject(projectId);
  if (!project) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Project not found: ${projectId}` });
  }
  return project;
}

export function getSimulationManager(projectId: string) {
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
export async function ensurePluginsLoaded(rootPath: string): Promise<void> {
  const loadResults = pluginLoader.getLoadResults(rootPath);
  if (loadResults.length === 0) {
    console.log(`[router] lazy-loading plugins for ${rootPath}`);
    await pluginLoader.loadPlugins(rootPath);
  }
}

export function storedMessagesPath(projectRoot: string, sessionId: string): string {
  return join(projectRoot, '.socverify', 'chat-messages', `${encodeURIComponent(sessionId)}.json`);
}

export async function loadStoredMessages(projectRoot: string, sessionId: string): Promise<unknown[]> {
  try {
    const data = await readFile(storedMessagesPath(projectRoot, sessionId), 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function isPlaceholderSessionName(name: string): boolean {
  return name === '新会话' || /^Session [A-Za-z0-9_-]+$/.test(name);
}

export async function filterEmptyPlaceholderSessions(
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
