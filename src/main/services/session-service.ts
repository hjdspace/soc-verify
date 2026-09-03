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
import { readFile, stat } from 'node:fs/promises';
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
 *
 * Perf: history list 只需要判断"消息文件是否有内容"，用 stat 的文件大小
 * 判断（>2 字节排除空 `[]`/`null` 序列化）并并行探测，避免串行读取 +
 * 完整 JSON.parse 数百 KB 的工具结果文件（这是历史页卡顿的主因）。
 * saveStoredMessages 以 `[]` 起步、内容递增，小文件必然对应空会话；
 * 畸形文件（<3 字节）按空会话处理，与 loadStoredMessages 的容错一致。
 */
export async function filterEmptyPlaceholderSessions(
  projectRoot: string,
  sessions: PersistedSession[],
): Promise<PersistedSession[]> {
  const visible = await Promise.all(
    sessions.map(async (session) => {
      if (!isPlaceholderSessionName(session.name)) return session;
      try {
        const st = await stat(storedMessagesPath(projectRoot, session.sessionId));
        return st.size > 2 ? session : null;
      } catch {
        return null;
      }
    }),
  );
  return visible.filter((s): s is PersistedSession => s !== null);
}
