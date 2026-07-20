import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  requireSession,
  storedMessagesPath,
  isPlaceholderSessionName,
} from '../../src/main/services/session-service';

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
});
