import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SOCVERIFY_DIR = '.socverify';
const SESSIONS_FILE = 'sessions.json';

export interface PersistedSession {
  sessionId: string;
  name: string;
  projectId: string;
  createdAt: number;
  lastActivityAt: number;
  /** Persisted model info so the model survives app restart */
  model?: { provider: string; id: string; name: string };
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
  await writeFile(filePath, JSON.stringify(sessions, null, 2), 'utf-8');
}

export async function loadSessions(
  projectRoot: string,
): Promise<PersistedSession[]> {
  const filePath = join(projectRoot, SOCVERIFY_DIR, SESSIONS_FILE);
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed as PersistedSession[];
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
  model: { provider: string; id: string; name: string },
): Promise<void> {
  const sessions = await loadSessions(projectRoot);
  const idx = sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], model };
    await saveSessions(projectRoot, sessions);
  }
}
