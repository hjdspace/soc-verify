import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requireSession,
  storedMessagesPath,
  isPlaceholderSessionName,
  filterEmptyPlaceholderSessions,
} from '../../src/main/services/session-service';
import type { PersistedSession } from '../../src/main/agent/session-persistence';

// Mock dependencies
vi.mock('../../src/main/agent/session-manager', () => ({
  sessionManager: {
    getClient: vi.fn(),
  },
}));

import { sessionManager } from '../../src/main/agent/session-manager';

describe('session-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('requireSession', () => {
    it('returns the client when session exists', () => {
      const mockClient = { send: vi.fn() } as never;
      vi.mocked(sessionManager.getClient).mockReturnValue(mockClient);
      expect(requireSession('s1')).toBe(mockClient);
    });

    it('throws TRPCError NOT_FOUND when session does not exist', () => {
      vi.mocked(sessionManager.getClient).mockReturnValue(null);
      expect(() => requireSession('missing')).toThrow(/Session not found: missing/);
    });
  });

  describe('storedMessagesPath', () => {
    it('builds the correct path with URL-encoded session ID', () => {
      const path = storedMessagesPath('/tmp/proj', 'session_123');
      expect(path).toContain('.socverify');
      expect(path).toContain('chat-messages');
      expect(path).toContain('session_123.json');
    });

    it('URL-encodes special characters in session ID', () => {
      const path = storedMessagesPath('/tmp/proj', 'session/with/slashes');
      expect(path).toContain('session%2Fwith%2Fslashes.json');
    });
  });

  describe('isPlaceholderSessionName', () => {
    it('identifies "新会话" as placeholder', () => {
      expect(isPlaceholderSessionName('新会话')).toBe(true);
    });

    it('identifies "Session <id>" as placeholder', () => {
      expect(isPlaceholderSessionName('Session abc123')).toBe(true);
      expect(isPlaceholderSessionName('Session AbC-xyz')).toBe(true);
    });

    it('does not identify real names as placeholder', () => {
      expect(isPlaceholderSessionName('Debug reset failure')).toBe(false);
      expect(isPlaceholderSessionName('My Session')).toBe(false);
      expect(isPlaceholderSessionName('')).toBe(false);
    });
  });

  describe('filterEmptyPlaceholderSessions (history list perf)', () => {
    let projectRoot: string;

    const persisted = (sessionId: string, name: string): PersistedSession => ({
      sessionId,
      name,
      projectId: 'p1',
      createdAt: 0,
      lastActivityAt: 0,
    });

    beforeEach(async () => {
      projectRoot = await mkdtemp(join(tmpdir(), 'socverify-filter-'));
      await mkdir(join(projectRoot, '.socverify', 'chat-messages'), { recursive: true });
    });

    async function writeMessages(sessionId: string, messages: unknown[]): Promise<void> {
      const file = storedMessagesPath(projectRoot, sessionId);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, JSON.stringify(messages), 'utf-8');
    }

    it('keeps non-placeholder sessions without touching the filesystem', async () => {
      const sessions = [persisted('session_named', 'Debug reset failure')];
      const visible = await filterEmptyPlaceholderSessions(projectRoot, sessions);
      expect(visible.map((s) => s.sessionId)).toEqual(['session_named']);
    });

    it('keeps placeholder sessions whose message file has content', async () => {
      await writeMessages('session_used', [
        { id: 'm1', role: 'user', content: 'hi', timestamp: 1 },
      ]);
      const sessions = [persisted('session_used', '新会话')];
      const visible = await filterEmptyPlaceholderSessions(projectRoot, sessions);
      expect(visible.map((s) => s.sessionId)).toEqual(['session_used']);
    });

    it('drops placeholder sessions with an empty message file ([] or missing)', async () => {
      await writeMessages('session_empty', []);
      const sessions = [
        persisted('session_empty', '新会话'),
        persisted('session_missing', 'Session abc123'),
      ];
      const visible = await filterEmptyPlaceholderSessions(projectRoot, sessions);
      expect(visible).toEqual([]);
    });

    it('judges by file size without parsing — hundreds of KB tool results stay fast', async () => {
      // 20 个占位会话 × 300KB 消息文件 ≈ 6MB。旧实现串行 readFile + JSON.parse
      // 每次打开历史页耗时数百 ms（GUI 卡顿主因）；stat 实现应在几十 ms 内。
      const big = Array.from({ length: 40 }, (_, i) => ({
        id: `m${i}`,
        role: 'tool',
        content: '',
        toolName: 'read',
        toolResult: { content: 'x'.repeat(300_000) },
        timestamp: 0,
      }));
      const sessions = Array.from({ length: 20 }, (_, i) => persisted(`session_${i}`, '新会话'));
      await Promise.all(sessions.map((s) => writeMessages(s.sessionId, big)));

      const t0 = performance.now();
      const visible = await filterEmptyPlaceholderSessions(projectRoot, sessions);
      const elapsed = performance.now() - t0;
      expect(visible).toHaveLength(20);
      expect(elapsed).toBeLessThan(200);
    });
  });
});
