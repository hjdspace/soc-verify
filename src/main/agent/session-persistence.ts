import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextBreakdown, ContextUsage } from '@shared/context-management';
import type { AgentEngine } from '@shared/agent-events';

const SOCVERIFY_DIR = '.socverify';
const SESSIONS_FILE = 'sessions.json';

export interface PersistedSession {
  sessionId: string;
  /**
   * Engine-neutral engine session id — used for resuming conversations via
   * the runner. Legacy files only carry `ompSessionId`; `loadSessions`
   * normalizes it into this field (read-only compatibility).
   */
  engineSessionId?: string;
  /** Which engine the session belongs to. Defaults to 'omp' for legacy files. */
  engine?: AgentEngine;
  /** The cwd the session was created with (restored sessions resume in it). */
  cwd?: string;
  /**
   * @deprecated Legacy omp-only field. Never written by new code; consumed
   * and normalized into `engineSessionId` by `loadSessions`.
   */
  ompSessionId?: string;
  name: string;
  projectId: string;
  createdAt: number;
  lastActivityAt: number;
  /** Persisted model info so the model survives app restart */
  model?: { provider: string; id: string; name: string; providerId?: string };
  /** Last known context usage — restored on app reopen so the indicator
   *  shows the correct value before the runtime session is started. */
  contextUsage?: ContextUsage;
  contextBreakdown?: ContextBreakdown;
}

/** Legacy on-disk record shape (pre engine-neutral contract). */
type LegacyPersistedSession = PersistedSession & { ompSessionId?: string };

/**
 * Normalize a raw persisted record into the engine-neutral shape:
 *   - `engine` defaults to 'omp' (all legacy sessions are omp-backed)
 *   - `engineSessionId` falls back to the legacy `ompSessionId`
 *   - `cwd` falls back to the project root the sessions file lives under
 *   - the legacy `ompSessionId` field is consumed, never propagated
 */
function normalizePersistedSession(raw: LegacyPersistedSession, projectRoot: string): PersistedSession {
  const { ompSessionId, ...rest } = raw;
  return {
    ...rest,
    engine: rest.engine ?? 'omp',
    engineSessionId: rest.engineSessionId ?? ompSessionId,
    cwd: rest.cwd ?? projectRoot,
  };
}

/** Strip the deprecated legacy field so it never reaches disk. */
function stripLegacyFields(session: PersistedSession): PersistedSession {
  const { ompSessionId: _legacy, ...rest } = session as LegacyPersistedSession;
  return rest;
}

/**
 * Manages persistence of AI session metadata to .socverify/sessions.json.
 * This allows sessions to be restored when a project is reopened.
 */
export async function saveSessions(
  projectRoot: string,
  sessions: PersistedSession[],
): Promise<void> {
  const dir = join(projectRoot, SOCVERIFY_DIR);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const filePath = join(dir, SESSIONS_FILE);
  const sanitized = sessions.map(stripLegacyFields);
  await writeFile(filePath, JSON.stringify(sanitized, null, 2), 'utf-8');
}

export async function loadSessions(
  projectRoot: string,
): Promise<PersistedSession[]> {
  const filePath = join(projectRoot, SOCVERIFY_DIR, SESSIONS_FILE);
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return (parsed as LegacyPersistedSession[]).map((raw) => normalizePersistedSession(raw, projectRoot));
    }
    return [];
  } catch {
    return [];
  }
}

export async function addSession(
  projectRoot: string,
  session: PersistedSession,
): Promise<void> {
  const sessions = await loadSessions(projectRoot);
  // Replace if already exists, otherwise add
  const idx = sessions.findIndex((s) => s.sessionId === session.sessionId);
  if (idx >= 0) {
    sessions[idx] = session;
  } else {
    sessions.push(session);
  }
  await saveSessions(projectRoot, sessions);
}

export async function removeSession(
  projectRoot: string,
  sessionId: string,
): Promise<void> {
  const sessions = await loadSessions(projectRoot);
  const filtered = sessions.filter((s) => s.sessionId !== sessionId);
  await saveSessions(projectRoot, filtered);
}

/**
 * Update the model info on a persisted session.
 * Called when the user switches model so the choice survives restarts.
 */
export async function updateSessionModel(
  projectRoot: string,
  sessionId: string,
  model: { provider: string; id: string; name: string; providerId?: string },
): Promise<void> {
  const sessions = await loadSessions(projectRoot);
  const idx = sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], model };
    await saveSessions(projectRoot, sessions);
  }
}

/**
 * Update the engine session id on a persisted session (engine-neutral).
 * Called after a regenerate branch forks the engine session file, or when
 * the engine session is re-created, so a future app restart resumes the
 * right branch.
 */
export async function updateSessionEngineId(
  projectRoot: string,
  sessionId: string,
  engine: AgentEngine,
  engineSessionId: string,
): Promise<void> {
  const sessions = await loadSessions(projectRoot);
  const idx = sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], engine, engineSessionId };
    await saveSessions(projectRoot, sessions);
  }
}

/**
 * Update the omp engine's session id on a persisted session.
 *
 * @deprecated Use `updateSessionEngineId` — kept so existing callers keep
 * working while they migrate to the engine-neutral naming.
 */
export async function updateSessionOmpId(
  projectRoot: string,
  sessionId: string,
  ompSessionId: string,
): Promise<void> {
  return updateSessionEngineId(projectRoot, sessionId, 'omp', ompSessionId);
}

/**
 * Update the lastActivityAt timestamp on a persisted session.
 * Called when the user sends a message so the history list stays sorted by recency.
 */
export async function updateSessionActivity(
  projectRoot: string,
  sessionId: string,
): Promise<void> {
  const sessions = await loadSessions(projectRoot);
  const idx = sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], lastActivityAt: Date.now() };
    await saveSessions(projectRoot, sessions);
  }
}

/**
 * Update the context usage on a persisted session.
 * Called when context_usage events arrive so the indicator shows the correct
 * value immediately when the app is reopened (before the runtime session is
 * started).
 */
export async function updateSessionContextUsage(
  projectRoot: string,
  sessionId: string,
  contextUsage: ContextUsage,
  contextBreakdown?: ContextBreakdown,
): Promise<void> {
  const sessions = await loadSessions(projectRoot);
  const idx = sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], contextUsage, contextBreakdown };
    await saveSessions(projectRoot, sessions);
  }
}
