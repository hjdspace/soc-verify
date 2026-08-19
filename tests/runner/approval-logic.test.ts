import { describe, it, expect } from 'vitest';
import { getToolTier, needsApproval, type ApprovalMode } from '../../runner/approval-logic';

describe('getToolTier', () => {
  describe('read tier', () => {
    const readTools = ['read', 'grep', 'glob', 'ast_grep', 'todo', 'web_search', 'ask', 'inspect_image'];

    for (const tool of readTools) {
      it(`classifies "${tool}" as read`, () => {
        expect(getToolTier(tool)).toBe('read');
      });
    }
  });

  describe('write tier', () => {
    const writeTools = ['edit', 'write', 'ast_edit'];

    for (const tool of writeTools) {
      it(`classifies "${tool}" as write`, () => {
        expect(getToolTier(tool)).toBe('write');
      });
    }
  });

  describe('exec tier', () => {
    const execTools = ['bash', 'run_sim', 'execute', 'make', 'compile', 'unknown_tool', ''];

    for (const tool of execTools) {
      it(`classifies "${tool || '(empty)'}" as exec`, () => {
        expect(getToolTier(tool)).toBe('exec');
      });
    }
  });
});

describe('needsApproval', () => {
  describe('yolo mode', () => {
    const mode: ApprovalMode = 'yolo';

    it('never requires approval for read tools', () => {
      expect(needsApproval('read', mode)).toBe(false);
      expect(needsApproval('grep', mode)).toBe(false);
    });

    it('never requires approval for write tools', () => {
      expect(needsApproval('edit', mode)).toBe(false);
      expect(needsApproval('write', mode)).toBe(false);
    });

    it('never requires approval for exec tools', () => {
      expect(needsApproval('bash', mode)).toBe(false);
      expect(needsApproval('run_sim', mode)).toBe(false);
    });
  });

  describe('always-ask mode', () => {
    const mode: ApprovalMode = 'always-ask';

    it('does not require approval for read tools', () => {
      expect(needsApproval('read', mode)).toBe(false);
      expect(needsApproval('grep', mode)).toBe(false);
      expect(needsApproval('glob', mode)).toBe(false);
      expect(needsApproval('ask', mode)).toBe(false);
    });

    it('requires approval for write tools', () => {
      expect(needsApproval('edit', mode)).toBe(true);
      expect(needsApproval('write', mode)).toBe(true);
      expect(needsApproval('ast_edit', mode)).toBe(true);
    });

    it('requires approval for exec tools', () => {
      expect(needsApproval('bash', mode)).toBe(true);
      expect(needsApproval('run_sim', mode)).toBe(true);
      expect(needsApproval('unknown', mode)).toBe(true);
    });
  });

  describe('write mode', () => {
    const mode: ApprovalMode = 'write';

    it('does not require approval for read tools', () => {
      expect(needsApproval('read', mode)).toBe(false);
      expect(needsApproval('grep', mode)).toBe(false);
    });

    it('does not require approval for write tools', () => {
      expect(needsApproval('edit', mode)).toBe(false);
      expect(needsApproval('write', mode)).toBe(false);
    });

    it('requires approval for exec tools', () => {
      expect(needsApproval('bash', mode)).toBe(true);
      expect(needsApproval('run_sim', mode)).toBe(true);
      expect(needsApproval('unknown', mode)).toBe(true);
    });
  });

  describe('approval matrix summary', () => {
    // A concise table-style verification of the full approval matrix.
    const matrix: Array<{ tool: string; yolo: boolean; alwaysAsk: boolean; write: boolean }> = [
      { tool: 'read', yolo: false, alwaysAsk: false, write: false },
      { tool: 'grep', yolo: false, alwaysAsk: false, write: false },
      { tool: 'glob', yolo: false, alwaysAsk: false, write: false },
      { tool: 'edit', yolo: false, alwaysAsk: true, write: false },
      { tool: 'write', yolo: false, alwaysAsk: true, write: false },
      { tool: 'bash', yolo: false, alwaysAsk: true, write: true },
      { tool: 'unknown', yolo: false, alwaysAsk: true, write: true },
    ];

    for (const row of matrix) {
      it(`"${row.tool}": yolo=${row.yolo}, always-ask=${row.alwaysAsk}, write=${row.write}`, () => {
        expect(needsApproval(row.tool, 'yolo')).toBe(row.yolo);
        expect(needsApproval(row.tool, 'always-ask')).toBe(row.alwaysAsk);
        expect(needsApproval(row.tool, 'write')).toBe(row.write);
      });
    }
  });
});
