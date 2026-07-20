/**
 * Session domain service — session lookup, message persistence, and
 * placeholder-session filtering helpers.
 *
 * Encapsulates the coordination between SessionManager, the file system
 * (.socverify/chat-messages/), and the tRPC error boundary. Previously
 * these helpers lived in the kitchen-sink router-context.ts.
 */

import { TRPCError } from '@trpc/server';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { sessionManager } from '../agent/session-manager';
import type { AgentClient } from '../agent/agent-client';
import type { PersistedSession } from '../agent/session-persistence';

/**
 * Look up a session's agent client by ID or throw a NOT_FOUND tRPC error.
 */
export function requireSession(sessionId: string): AgentClient {
  const client = sessionManager.getClient(sessionId);
  if (!client) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Session not found: ${sessionId}` });
  }
  return client;
}

/**
 * Resolve the file path where a session's chat messages are persisted.
 */
export function storedMessagesPath(projectRoot: string, sessionId: string): string {
  return join(projectRoot, '.socverify', 'chat-messages', `${encodeURIComponent(sessionId)}.json`);
}

/**
 * Load stored chat messages for a session from disk.
 * Returns an empty array if the file doesn't exist or is invalid.
 */
export async function loadStoredMessages(projectRoot: string, sessionId: string): Promise<unknown[]> {
  try {
    const data = await readFile(storedMessagesPath(projectRoot, sessionId), 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Check if a session name is an auto-generated placeholder
 * (e.g. "新会话" or "Session <random>").
 */
export function isPlaceholderSessionName(name: string): boolean {
  return name === '新会话' || /^Session [A-Za-z0-9_-]+$/.test(name);
}

/**
 * Filter out placeholder sessions that have no stored messages
 * (i.e. sessions that were created but never used).
 */
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
