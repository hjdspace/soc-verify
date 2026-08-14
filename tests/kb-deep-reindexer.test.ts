/**
 * Deep Reindexer 测试 — TDD red phase。
 *
 * 测试缝：deepReindex() 函数。
 * mock：SessionManager（createSession / destroySession / getSession / getClient）、
 *       AgentClient（prompt / onEvent）、pipeline（readIndexMd / listDocuments / writeIndexMd）。
 *
 * 覆盖场景：
 *  - 触发：创建临时 omp 会话，发送 prompt
 *  - 进度事件：逐文档推送 N/total
 *  - 成功：原子替换 index.md（写临时文件 → rename）
 *  - 失败保护：会话失败时原 index.md 完好
 *  - 会话销毁：完成后或失败后销毁
 *  - LLM 配置异常返回明确错误
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Hoisted tmp dirs ──────────────────────────────────────

const { tmpDir, projectDir, globalDataDir } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const base = os.tmpdir() + `/sv-kb-reindex-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const dirs = {
    tmpDir: base,
    projectDir: path.join(base, 'project'),
    globalDataDir: path.join(base, 'appdata'),
  };
  fs.mkdirSync(dirs.tmpDir, { recursive: true });
  fs.mkdirSync(dirs.projectDir, { recursive: true });
  fs.mkdirSync(dirs.globalDataDir, { recursive: true });
  return dirs;
});

// ─── Mocks ──────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => globalDataDir),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('../src/main/services/project-service', () => ({
  requireProject: vi.fn(() => ({
    id: 'test-project-id',
    rootPath: projectDir,
    name: 'Test Project',
  })),
}));

// Mock credential-manager
vi.mock('../src/main/credentials/credential-manager', () => ({
  credentialManager: {
    getDefaultCredential: vi.fn(() => ({
      providerId: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://api.test.com/v1',
      provider: 'openai-compatible',
    })),
    buildEnvForAgent: vi.fn(() => ({})),
    get: vi.fn(() => ({
      providerId: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://api.test.com/v1',
      provider: 'openai-compatible',
    })),
    mapProviderForAgent: vi.fn(() => 'openai-compatible'),
  },
}));

// Mock plugin loader
vi.mock('../src/main/plugins/loader', () => ({
  pluginLoader: {
    getRegistry: vi.fn(() => ({
      discover: vi.fn(() => ({ subsystems: [] })),
    })),
  },
}));

vi.mock('../src/main/agent/session-persistence', () => ({
  loadSessions: vi.fn(() => []),
}));

// Mock session manager
const { mockCreateSession, mockDestroySession, mockGetSession, mockGetClient } = vi.hoisted(() => ({
  mockCreateSession: vi.fn() as ReturnType<typeof vi.fn>,
  mockDestroySession: vi.fn() as ReturnType<typeof vi.fn>,
  mockGetSession: vi.fn() as ReturnType<typeof vi.fn>,
  mockGetClient: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock('../src/main/agent/session-manager', () => ({
  sessionManager: {
    createSession: mockCreateSession,
    destroySession: mockDestroySession,
    getSession: mockGetSession,
    getClient: mockGetClient,
  },
  SessionManagerImpl: vi.fn(),
}));

// Mock agent paths
vi.mock('../src/main/agent/paths', () => ({
  resolveAgentRuntime: vi.fn(() => ({ mode: 'binary', runnerPath: '/fake', bunVersionOk: true })),
  resolveBuiltInExtensionDir: vi.fn(() => null),
  resolveRunnerBinary: vi.fn(() => '/fake/runner'),
  resolveRunnerScript: vi.fn(() => null),
  resolveBunPath: vi.fn(() => null),
  checkBunVersion: vi.fn(() => ({ ok: true, version: '1.3.14', required: '1.3.14' })),
}));

vi.mock('../src/main/agent/officecli-paths', () => ({
  ensureOfficecliOnPath: vi.fn(),
}));

vi.mock('../src/main/agent/openai-compatible', () => ({
  ensureV1Prefix: vi.fn((s: string) => s),
  fetchOpenAICompatibleModels: vi.fn(() => []),
  buildOpenAICompatibleModelsConfig: vi.fn(() => ({})),
  buildModelInputOverrideConfig: vi.fn(() => ({})),
  OPENAI_COMPATIBLE_API_KEY_ENV: 'OPENAI_API_KEY',
  OPENAI_COMPATIBLE_PROVIDER: 'openai-compatible',
}));

vi.mock('../src/main/agent/context-settings', () => ({
  contextSettings: { getContextWindow: vi.fn(() => 128000) },
}));

vi.mock('../src/main/mcp/mcp-config', () => ({
  ensureBuiltinMcpServers: vi.fn(),
}));

vi.mock('../src/main/mcp/traceweave-paths', () => ({
  ensureTraceweaveDefaultMcp: vi.fn(() => null),
}));

vi.mock('../src/main/plugin-adapters', () => ({
  PluginBackedDiscovery: vi.fn(),
  PluginBackedSimulation: vi.fn(),
  PluginBackedCoverage: vi.fn(),
}));

// Mock coverage/case-stats registries
vi.mock('../src/main/coverage/coverage-registry', () => ({
  coverageRegistry: { get: vi.fn() },
}));

vi.mock('../src/main/case/case-stats-registry', () => ({
  caseStatsRegistry: { get: vi.fn() },
}));

vi.mock('../src/main/simulation/simulation-registry', () => ({
  simulationRegistry: { get: vi.fn() },
}));

// ─── Imports (after mocks) ──────────────────────────────────

import { deepReindex } from '../src/main/kb/deep-reindexer';

// ─── Helpers ────────────────────────────────────────────────

function makeKbDir(name: string): string {
  const dir = join(tmpDir, name);
  mkdirSync(join(dir, 'sources'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'docs', '协议手册'), { recursive: true });
  writeFileSync(join(dir, 'docs', '协议手册', 'DDR5.md'), '# DDR5\n\nDDR5 协议内容', 'utf-8');
  writeFileSync(join(dir, 'docs', '协议手册', 'AXI.md'), '# AXI\n\nAXI 协议内容', 'utf-8');
  writeFileSync(join(dir, 'index.md'), '# 知识库索引\n\n## 协议手册\n\n### DDR5\n- **路径**: `协议手册/DDR5.md`\n- **摘要**: DDR5 协议\n', 'utf-8');
  return dir;
}

// ─── Test Suite ─────────────────────────────────────────────

describe('deepReindex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSession.mockReset();
    mockDestroySession.mockReset();
    mockGetSession.mockReset();
    mockGetClient.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 触发：创建临时 omp 会话 ───────────────────────────

  it('创建临时 omp 会话并发送 prompt', async () => {
    const kbDir = makeKbDir('trigger-kb');
    mockCreateSession.mockResolvedValue('temp-session-1');
    // Agent prompt mock: 模拟 Agent 写入 .index.md.new
    const mockPrompt = vi.fn().mockImplementation(async () => {
      const newIndexPath = join(kbDir, '.index.md.new');
      writeFileSync(newIndexPath, '# 知识库索引\n\n## 协议手册\n\n### DDR5\n- **路径**: `协议手册/DDR5.md`\n- **摘要**: DDR5 协议规范\n\n### AXI\n- **路径**: `协议手册/AXI.md`\n- **摘要**: AXI 总线协议\n', 'utf-8');
    });
    mockGetSession.mockReturnValue({
      client: { prompt: mockPrompt, onEvent: vi.fn() },
      hostTools: { registerCustom: vi.fn() },
    });
    mockGetClient.mockReturnValue({ prompt: mockPrompt, onEvent: vi.fn() });

    const result = await deepReindex({
      kbPath: kbDir,
      projectId: 'test-project-id',
      cwd: projectDir,
      notify: vi.fn(),
    });

    expect(result.ok).toBe(true);
    expect(mockCreateSession).toHaveBeenCalledOnce();
    expect(mockDestroySession).toHaveBeenCalledWith('temp-session-1');
  });

  // ─── 成功：原子替换 index.md ───────────────────────────

  it('成功时原子替换 index.md（临时文件 → rename）', async () => {
    const kbDir = makeKbDir('success-kb');
    const originalContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');

    mockCreateSession.mockResolvedValue('temp-session-2');
    // Agent prompt mock: 写入 .index.md.new
    const mockPrompt = vi.fn().mockImplementation(async () => {
      const newIndexPath = join(kbDir, '.index.md.new');
      writeFileSync(newIndexPath, '# 知识库索引\n\n## 协议手册\n\n### DDR5\n- **路径**: `协议手册/DDR5.md`\n- **摘要**: 深度重建的 DDR5 摘要\n\n### AXI\n- **路径**: `协议手册/AXI.md`\n- **摘要**: 深度重建的 AXI 摘要\n', 'utf-8');
    });
    mockGetSession.mockReturnValue({
      client: {
        prompt: mockPrompt,
        onEvent: vi.fn(),
      },
      hostTools: { registerCustom: vi.fn() },
    });
    mockGetClient.mockReturnValue({ prompt: mockPrompt, onEvent: vi.fn() });

    const result = await deepReindex({
      kbPath: kbDir,
      projectId: 'test-project-id',
      cwd: projectDir,
      notify: vi.fn(),
    });

    expect(result.ok).toBe(true);

    // index.md 已被替换（内容变化）
    expect(existsSync(join(kbDir, 'index.md'))).toBe(true);
    const newContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');
    expect(newContent).toContain('深度重建的 DDR5 摘要');
    expect(newContent).not.toBe(originalContent);

    // 不存在残留临时文件
    const entries = require('node:fs').readdirSync(kbDir) as string[];
    const tempFiles = entries.filter((f) => f.includes('.tmp') || f.includes('.index.md.new'));
    expect(tempFiles).toHaveLength(0);
  });

  // ─── 失败保护：原 index.md 完好 ───────────────────────────

  it('会话创建失败时原 index.md 完好', async () => {
    const kbDir = makeKbDir('fail-kb');
    const originalContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');

    mockCreateSession.mockRejectedValue(new Error('LLM 配置异常'));

    const result = await deepReindex({
      kbPath: kbDir,
      projectId: 'test-project-id',
      cwd: projectDir,
      notify: vi.fn(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sessionFailed');
      expect(result.error.message).toContain('LLM');
    }

    // 原 index.md 完好
    const afterContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');
    expect(afterContent).toBe(originalContent);
  });

  it('prompt 失败时原 index.md 完好且会话被销毁', async () => {
    const kbDir = makeKbDir('prompt-fail-kb');
    const originalContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');

    mockCreateSession.mockResolvedValue('temp-session-3');
    const mockPrompt = vi.fn().mockRejectedValue(new Error('prompt timeout'));
    mockGetSession.mockReturnValue({
      client: { prompt: mockPrompt, onEvent: vi.fn() },
      hostTools: { registerCustom: vi.fn() },
    });
    mockGetClient.mockReturnValue({ prompt: mockPrompt, onEvent: vi.fn() });

    const result = await deepReindex({
      kbPath: kbDir,
      projectId: 'test-project-id',
      cwd: projectDir,
      notify: vi.fn(),
    });

    expect(result.ok).toBe(false);
    expect(mockDestroySession).toHaveBeenCalledWith('temp-session-3');

    const afterContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');
    expect(afterContent).toBe(originalContent);
  });

  // ─── 进度事件推送 ───────────────────────────────────────

  it('推送进度事件（processing + completed）', async () => {
    const kbDir = makeKbDir('progress-kb');
    const events: Array<{ phase: string; current?: number; total?: number }> = [];

    mockCreateSession.mockResolvedValue('temp-session-4');
    const mockPrompt = vi.fn().mockImplementation(async () => {
      writeFileSync(join(kbDir, '.index.md.new'), '# 新索引\n', 'utf-8');
    });
    mockGetSession.mockReturnValue({
      client: { prompt: mockPrompt, onEvent: vi.fn() },
      hostTools: { registerCustom: vi.fn() },
    });
    mockGetClient.mockReturnValue({ prompt: mockPrompt, onEvent: vi.fn() });

    await deepReindex({
      kbPath: kbDir,
      projectId: 'test-project-id',
      cwd: projectDir,
      notify: (event: { phase: string; current?: number; total?: number; message?: string }) => {
        events.push(event);
      },
    });

    // 至少有 processing 和 completed 事件
    expect(events.some((e) => e.phase === 'processing')).toBe(true);
    expect(events.some((e) => e.phase === 'completed')).toBe(true);
  });

  // ─── 会话销毁：完成后 ───────────────────────────────────

  it('完成后会话被正确销毁', async () => {
    const kbDir = makeKbDir('cleanup-kb');
    mockCreateSession.mockResolvedValue('temp-session-5');
    const mockPrompt = vi.fn().mockImplementation(async () => {
      writeFileSync(join(kbDir, '.index.md.new'), '# 新索引\n', 'utf-8');
    });
    mockGetSession.mockReturnValue({
      client: { prompt: mockPrompt, onEvent: vi.fn() },
      hostTools: { registerCustom: vi.fn() },
    });
    mockGetClient.mockReturnValue({ prompt: mockPrompt, onEvent: vi.fn() });

    await deepReindex({
      kbPath: kbDir,
      projectId: 'test-project-id',
      cwd: projectDir,
      notify: vi.fn(),
    });

    expect(mockDestroySession).toHaveBeenCalledWith('temp-session-5');
  });

  // ─── 会话销毁：失败后 ───────────────────────────────────

  it('失败后会话也被销毁', async () => {
    const kbDir = makeKbDir('fail-cleanup-kb');
    mockCreateSession.mockResolvedValue('temp-session-6');
    const mockPrompt = vi.fn().mockRejectedValue(new Error('network error'));
    mockGetSession.mockReturnValue({
      client: { prompt: mockPrompt, onEvent: vi.fn() },
      hostTools: { registerCustom: vi.fn() },
    });
    mockGetClient.mockReturnValue({ prompt: mockPrompt, onEvent: vi.fn() });

    await deepReindex({
      kbPath: kbDir,
      projectId: 'test-project-id',
      cwd: projectDir,
      notify: vi.fn(),
    });

    expect(mockDestroySession).toHaveBeenCalledWith('temp-session-6');
  });

  // ─── 无文档时直接返回成功 ───────────────────────────────

  it('无文档时直接返回成功（空库）', async () => {
    const kbDir = join(tmpDir, 'empty-kb');
    mkdirSync(join(kbDir, 'sources'), { recursive: true });
    mkdirSync(join(kbDir, 'docs'), { recursive: true });
    writeFileSync(join(kbDir, 'index.md'), '# 知识库索引\n', 'utf-8');

    const result = await deepReindex({
      kbPath: kbDir,
      projectId: 'test-project-id',
      cwd: projectDir,
      notify: vi.fn(),
    });

    expect(result.ok).toBe(true);
    // 空库不应创建会话
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});
