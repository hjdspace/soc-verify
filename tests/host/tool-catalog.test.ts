import { describe, it, expect } from 'vitest';
import { HOST_TOOL_GROUPS, HOST_TOOL_NAMES } from '../../src/main/host/tool-catalog';

describe('host tool catalog', () => {
  it('工具名全局唯一（每个工具只有一个开关）', () => {
    expect(new Set(HOST_TOOL_NAMES).size).toBe(HOST_TOOL_NAMES.length);
  });

  it('每个分组非空且工具名符合命名规范', () => {
    for (const group of HOST_TOOL_GROUPS) {
      expect(group.tools.length).toBeGreaterThan(0);
      for (const tool of group.tools) {
        expect(tool.name).toMatch(/^[a-z][a-z_]*$/);
        expect(tool.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('不包含交互通道 ask（ask 不允许禁用，不在目录中）', () => {
    expect(HOST_TOOL_NAMES).not.toContain('ask');
  });
});
