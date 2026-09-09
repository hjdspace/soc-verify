import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSessions,
  saveSessions,
  addSession,
  updateSessionEngineId,
  updateSessionOmpId,
  type PersistedSession,
} from '../../src/main/agent/session-persistence';

describe('session persistence — engine-neutral fields', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-persist-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  function makeSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
    return {
      sessionId: 's1',
      name: 'Session 1',
      projectId: 'proj_1',
      createdAt: 1,
      lastActivityAt: 1,
      ...overrides,
    };
  }

  it('persists engine, engineSessionId and cwd on new sessions', async () => {
    await addSession(
      projectRoot,
      makeSession({
        engine: 'omp',
        engineSessionId: 'omp-123',
        cwd: 'D:/proj/demo',
      }),
    );

    const sessions = await loadSessions(projectRoot);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].engine).toBe('omp');
    expect(sessions[0].engineSessionId).toBe('omp-123');
    expect(sessions[0].cwd).toBe('D:/proj/demo');
  });

  it('never writes the legacy ompSessionId field to disk', async () => {
    await addSession(
      projectRoot,
      makeSession({
        engine: 'omp',
        engineSessionId: 'omp-123',
        // Callers may still carry the legacy field on the object — it must
        // not leak into the persisted JSON.
        ompSessionId: 'omp-123',
      } as Partial<PersistedSession>),
    );

    const raw = await readFile(join(projectRoot, '.socverify', 'sessions.json'), 'utf-8');
    expect(raw).not.toContain('ompSessionId');
  });

  it('normalizes legacy ompSessionId-only records on load (read compatibility)', async () => {
    // A sessions.json written by an older build — no engine/engineSessionId/cwd.
    // Written as raw JSON because saveSessions no longer emits the legacy field.
    const dir = join(projectRoot, '.socverify');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'sessions.json'),
      JSON.stringify([
        {
          sessionId: 's1',
          name: 'Session 1',
          projectId: 'proj_1',
          createdAt: 1,
          lastActivityAt: 1,
          ompSessionId: 'legacy-omp-42',
        },
      ], null, 2),
      'utf-8',
    );

    const sessions = await loadSessions(projectRoot);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].engine).toBe('omp');
    expect(sessions[0].engineSessionId).toBe('legacy-omp-42');
    expect(sessions[0].cwd).toBe(projectRoot);
    // The legacy field is consumed, not propagated.
    expect((sessions[0] as unknown as Record<string, unknown>).ompSessionId).toBeUndefined();
  });

  it('keeps explicit engine/cwd when both legacy and new fields exist', async () => {
    await saveSessions(projectRoot, [
      makeSession({
        engine: 'pi',
        engineSessionId: 'pi-7',
        cwd: 'D:/proj/explicit',
        ompSessionId: 'legacy-omp-1',
      } as Partial<PersistedSession>),
    ] as PersistedSession[]);

    const sessions = await loadSessions(projectRoot);

    expect(sessions[0].engine).toBe('pi');
    expect(sessions[0].engineSessionId).toBe('pi-7');
    expect(sessions[0].cwd).toBe('D:/proj/explicit');
  });

  it('updateSessionEngineId writes engine and engineSessionId', async () => {
    await addSession(projectRoot, makeSession({ engine: 'omp', engineSessionId: 'omp-1' }));

    await updateSessionEngineId(projectRoot, 's1', 'pi', 'pi-9');

    const sessions = await loadSessions(projectRoot);
    expect(sessions[0].engine).toBe('pi');
    expect(sessions[0].engineSessionId).toBe('pi-9');
  });

  it('updateSessionOmpId (deprecated) still works by delegating to the engine-neutral update', async () => {
    await addSession(projectRoot, makeSession());

    await updateSessionOmpId(projectRoot, 's1', 'omp-after-regen');

    const sessions = await loadSessions(projectRoot);
    expect(sessions[0].engine).toBe('omp');
    expect(sessions[0].engineSessionId).toBe('omp-after-regen');
  });

  it('updateSessionEngineId is a no-op for unknown sessions', async () => {
    await addSession(projectRoot, makeSession());

    await expect(
      updateSessionEngineId(projectRoot, 'unknown', 'pi', 'pi-x'),
    ).resolves.toBeUndefined();

    const sessions = await loadSessions(projectRoot);
    expect(sessions[0].engineSessionId).toBeUndefined();
  });
});
