/**
 * pi runner 统一审批逻辑测试（issue 04 验收项 5）。
 *
 * always-ask / write / yolo 必须统一覆盖 pi 内置、Codex（omp 侧同语义）、
 * MCP 和 extension tools：按工具能力层级（read/write/exec）决定是否请求
 * 用户审批；yolo 只跳过单次工具审批（不涉及 trust，trust 由独立机制处理）。
 *
 * 与 omp runner（runner/approval-logic.ts）保持同一套语义，两侧测试
 * 断言一致以保证跨引擎行为统一。
 */
import { describe, expect, it } from 'vitest';
import { getToolTier, needsApproval } from '../../runner-pi/approval-logic';

describe('getToolTier — pi 内置与 host 工具分层', () => {
  it('read 层：pi 只读内置工具', () => {
    expect(getToolTier('read')).toBe('read');
    expect(getToolTier('grep')).toBe('read');
    expect(getToolTier('find')).toBe('read');
    expect(getToolTier('ls')).toBe('read');
  });

  it('read 层：host 转发的交互问答工具 ask 不应触发审批', () => {
    expect(getToolTier('ask')).toBe('read');
  });

  it('write 层：文件修改工具', () => {
    expect(getToolTier('edit')).toBe('write');
    expect(getToolTier('write')).toBe('write');
    expect(getToolTier('ast_edit')).toBe('write');
  });

  it('exec 层：bash 与未知工具（含 MCP/extension 工具）默认 exec', () => {
    expect(getToolTier('bash')).toBe('exec');
    // MCP direct 工具默认命名形如 <server>_<tool>
    expect(getToolTier('searxng_web_search')).toBe('exec');
    // extension 注册的自定义工具一律按 exec（未知副作用）
    expect(getToolTier('subagent')).toBe('exec');
    expect(getToolTier('totally_unknown_tool')).toBe('exec');
  });
});

describe('needsApproval — 三种审批模式', () => {
  describe('yolo：仅跳过单次工具审批', () => {
    it('任何层级都不审批', () => {
      expect(needsApproval('read', 'yolo')).toBe(false);
      expect(needsApproval('write', 'yolo')).toBe(false);
      expect(needsApproval('bash', 'yolo')).toBe(false);
      expect(needsApproval('searxng_web_search', 'yolo')).toBe(false);
    });
  });

  describe('always-ask：write 与 exec 都要审批，read 自动放行', () => {
    it('read 自动放行', () => {
      expect(needsApproval('read', 'always-ask')).toBe(false);
      expect(needsApproval('grep', 'always-ask')).toBe(false);
      expect(needsApproval('ask', 'always-ask')).toBe(false);
    });

    it('write/exec 需要审批', () => {
      expect(needsApproval('edit', 'always-ask')).toBe(true);
      expect(needsApproval('write', 'always-ask')).toBe(true);
      expect(needsApproval('bash', 'always-ask')).toBe(true);
      expect(needsApproval('searxng_web_search', 'always-ask')).toBe(true);
    });
  });

  describe('write：编辑自动放行（走快照 + Diff Review），exec 要审批', () => {
    it('read/write 层自动放行', () => {
      expect(needsApproval('read', 'write')).toBe(false);
      expect(needsApproval('edit', 'write')).toBe(false);
      expect(needsApproval('write', 'write')).toBe(false);
    });

    it('exec 需要审批（bash 与 MCP 工具）', () => {
      expect(needsApproval('bash', 'write')).toBe(true);
      expect(needsApproval('searxng_web_search', 'write')).toBe(true);
    });
  });
});
