/**
 * resolveKbLlmConfig 单元测试 — KB LLM 配置五级回退链。
 *
 * 测试策略：直捣 resolveKbLlmConfig 接口，mock 三个外部依赖
 * （credentialManager / kbSettingsManager / projectManager + session-persistence），
 * 无需 tRPC caller 或 electron BrowserWindow mock。
 *
 * 回退链覆盖：
 *   1. KB 设置显式配置（providerId + model）→ 直接返回
 *   2. KB 设置显式 providerId 但凭证 model 空白 → 回退 firstAvailableModel
 *   3. KB 设置指向已删除凭证 → 回退 Agent 会话凭证
 *   4. Agent 会话持久化 providerId + model.id
 *   5. 凭证 model 字段 > Agent 会话 model.id
 *   6. 凭证 + 会话都无 model → API 拉取第一个可用模型
 *   7. 凭证 model 为空字符串 → 视为未指定继续回退
 *   8. 无任何凭证 → null
 *   9. 凭证缺 baseUrl 或 apiKey → null
 *  10. gemini 协议端点不加 /v1 前缀
 *  11. anthropic 协议不拉取 /models 端点
 *  12. 无活跃项目时回退默认凭证
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Hoisted tmp dirs ──────────────────────────────────────

const { tmpDir, projectDir, globalDataDir } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const base = os.tmpdir() + `/sv-llm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
}));

// Mock project-manager: 默认返回一个活跃项目
const { mockListProjects } = vi.hoisted(() => ({
  mockListProjects: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock('../src/main/project/project-manager', () => ({
  projectManager: {
    listProjects: mockListProjects.mockReturnValue([
      { id: 'proj-1', rootPath: projectDir, name: 'Test', lastOpenedAt: Date.now() },
    ]),
  },
}));

// Mock credential-manager
const { mockGetCredential, mockDefaultCredential } = vi.hoisted(() => ({
  mockGetCredential: vi.fn() as ReturnType<typeof vi.fn>,
  mockDefaultCredential: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock('../src/main/credentials/credential-manager', () => ({
  credentialManager: {
    get: mockGetCredential,
    getDefaultCredential: mockDefaultCredential,
  },
}));

// ─── Import after mocks ─────────────────────────────────────

import { resolveKbLlmConfig } from '../src/main/kb/llm-config';
import { kbSettingsManager } from '../src/main/kb/kb-settings';

// ─── Helpers ────────────────────────────────────────────────

function resetState(): void {
  kbSettingsManager.resetCache();
  rmSync(join(globalDataDir, 'socverify-data', 'kb-settings.json'), { force: true });
  rmSync(join(projectDir, '.socverify', 'sessions.json'), { force: true });
}

/** 写 KB 设置文件 */
async function writeKbSettings(settings: {
  convertEngine?: string;
  llm?: { providerId?: string; model?: string };
}): Promise<void> {
  await kbSettingsManager.save({
    convertEngine: (settings.convertEngine ?? 'anydoc') as 'anydoc',
    llm: settings.llm ?? {},
  });
}

/** 写 Agent 会话文件 */
function writeSessions(sessions: unknown[]): void {
  const dir = join(projectDir, '.socverify');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify(sessions), 'utf-8');
}

// ─── Test Suite ─────────────────────────────────────────────

describe('resolveKbLlmConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    // 默认无凭证
    mockGetCredential.mockResolvedValue(null);
    mockDefaultCredential.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 1. KB 设置显式配置（最高优先级） ─────────────────

  it('KB 设置显式指定凭证与模型时优先生效', async () => {
    await writeKbSettings({ llm: { providerId: 'kb-cred', model: 'kb-model' } });
    mockGetCredential.mockResolvedValue({
      providerId: 'kb-cred',
      apiKey: 'sk-kb',
      baseUrl: 'http://kb.example:3000',
    });

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    expect(config!.baseUrl).toBe('http://kb.example:3000/v1');
    expect(config!.apiKey).toBe('sk-kb');
    expect(config!.model).toBe('kb-model');
    expect(config!.providerId).toBe('kb-cred');
  });

  // ─── 2. KB 设置有 providerId 但 model 空 → 回退凭证 model ─────

  it('KB 设置未指定 model 时回退凭证的 model 字段', async () => {
    await writeKbSettings({ llm: { providerId: 'kb-cred' } });
    mockGetCredential.mockResolvedValue({
      providerId: 'kb-cred',
      apiKey: 'sk-kb',
      baseUrl: 'http://kb.example:3000',
      model: 'cred-model',
    });

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    expect(config!.model).toBe('cred-model');
  });

  // ─── 3. KB 设置指向已删除凭证 → 回退自动推导链 ─────────

  it('KB 设置指向的凭证已删除时回退默认凭证', async () => {
    await writeKbSettings({ llm: { providerId: 'deleted-cred', model: 'whatever' } });
    // KB 设置的凭证不存在
    mockGetCredential.mockResolvedValue(null);
    // 默认凭证兜底
    mockDefaultCredential.mockResolvedValue({
      providerId: 'fallback-cred',
      apiKey: 'sk-fallback',
      baseUrl: 'http://fallback.example:3000',
      model: 'fallback-model',
    });

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    expect(config!.providerId).toBe('fallback-cred');
    expect(config!.model).toBe('fallback-model');
  });

  // ─── 4. Agent 会话持久化 providerId + model.id ───────────

  it('Agent 会话持久化的 providerId + model.id 生效', async () => {
    // 无 KB 设置（回退自动推导）
    mockGetCredential.mockResolvedValue({
      providerId: 'session-cred',
      apiKey: 'sk-session',
      baseUrl: 'http://session.example:3000',
    });

    writeSessions([{
      sessionId: 's1',
      name: 'Agent 会话',
      projectId: 'proj-1',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      model: { provider: 'openai', id: 'session-model-id', name: 'Session Model', providerId: 'session-cred' },
    }]);

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    expect(config!.providerId).toBe('session-cred');
    expect(config!.model).toBe('session-model-id');
  });

  // ─── 5. 凭证 model > Agent 会话 model.id ────────────────

  it('凭证 model 字段优先于 Agent 会话持久化的 model.id', async () => {
    mockGetCredential.mockResolvedValue({
      providerId: 'session-cred',
      apiKey: 'sk-session',
      baseUrl: 'http://session.example:3000',
      model: 'cred-explicit-model',
    });

    writeSessions([{
      sessionId: 's1',
      name: 'Agent 会话',
      projectId: 'proj-1',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      model: { provider: 'openai', id: 'session-model-id', name: 'Session Model', providerId: 'session-cred' },
    }]);

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    expect(config!.model).toBe('cred-explicit-model');
  });

  // ─── 6. 凭证 + 会话都无 model → API 拉取第一个可用 ──────

  it('凭证与会话均无 model 时自动拉取端点第一个可用模型', async () => {
    mockDefaultCredential.mockResolvedValue({
      providerId: 'openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'http://localhost:8557',
    });

    const fetchMock = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.endsWith('/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'first-model' }, { id: 'second-model' }] }),
        } as unknown as Response;
      }
      return {} as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    expect(config!.model).toBe('first-model');
  });

  // ─── 7. 凭证 model 为空字符串 → 视为未指定 ─────────────

  it('凭证 model 为空字符串时视为未指定并继续回退', async () => {
    mockGetCredential.mockResolvedValue({
      providerId: 'openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'http://localhost:8557',
      model: '',
    });

    writeSessions([{
      sessionId: 's1',
      name: 'Agent 会话',
      projectId: 'proj-1',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      model: { provider: 'openai', id: 'session-model', name: 'Session', providerId: 'openai-compatible' },
    }]);

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    // 空字符串 model 应被跳过，回退到 sessionModelId
    expect(config!.model).toBe('session-model');
  });

  // ─── 8. 无任何凭证 → null ──────────────────────────────

  it('无任何凭证时返回 null', async () => {
    mockGetCredential.mockResolvedValue(null);
    mockDefaultCredential.mockResolvedValue(null);

    const config = await resolveKbLlmConfig();

    expect(config).toBeNull();
  });

  // ─── 9. 凭证缺 baseUrl 或 apiKey → null ────────────────

  it('凭证缺少 baseUrl 时返回 null', async () => {
    mockDefaultCredential.mockResolvedValue({
      providerId: 'openai-compatible',
      apiKey: 'sk-test',
      // no baseUrl
    });

    const config = await resolveKbLlmConfig();

    expect(config).toBeNull();
  });

  it('凭证缺少 apiKey 时返回 null', async () => {
    mockDefaultCredential.mockResolvedValue({
      providerId: 'openai-compatible',
      // no apiKey
      baseUrl: 'http://localhost:8557',
    });

    const config = await resolveKbLlmConfig();

    expect(config).toBeNull();
  });

  // ─── 10. gemini 协议端点不加 /v1 ────────────────────────

  it('gemini 协议端点不加 /v1 前缀', async () => {
    mockDefaultCredential.mockResolvedValue({
      providerId: 'gemini',
      apiKey: 'sk-gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
    });

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    expect(config!.baseUrl).toBe('https://generativelanguage.googleapis.com');
    expect(config!.baseUrl).not.toContain('/v1');
  });

  // ─── 11. anthropic 协议不拉取 /models ──────────────────

  it('anthropic 协议不拉取 /models 端点，使用 provider 默认模型', async () => {
    mockDefaultCredential.mockResolvedValue({
      providerId: 'anthropic',
      apiKey: 'sk-anthropic',
      baseUrl: 'https://api.anthropic.com',
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    expect(config!.model).toBe('claude-sonnet-4-20250514');
    // 不应调用 fetch 拉 /models
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ─── 12. 无活跃项目时回退默认凭证 ──────────────────────

  it('无活跃项目时回退默认凭证', async () => {
    mockListProjects.mockReturnValueOnce([]);

    mockDefaultCredential.mockResolvedValue({
      providerId: 'default-cred',
      apiKey: 'sk-default',
      baseUrl: 'http://default.example:3000',
      model: 'default-model',
    });

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    expect(config!.providerId).toBe('default-cred');
    expect(config!.model).toBe('default-model');
  });

  // ─── 13. KB 设置凭证缺 baseUrl → 回退自动推导 ─────────

  it('KB 设置凭证缺少 baseUrl 时回退自动推导链', async () => {
    await writeKbSettings({ llm: { providerId: 'kb-cred', model: 'kb-model' } });
    mockGetCredential.mockResolvedValue({
      providerId: 'kb-cred',
      apiKey: 'sk-kb',
      // no baseUrl — 不满足 KB 设置路径
    });

    mockDefaultCredential.mockResolvedValue({
      providerId: 'auto-cred',
      apiKey: 'sk-auto',
      baseUrl: 'http://auto.example:3000',
      model: 'auto-model',
    });

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    expect(config!.providerId).toBe('auto-cred');
    expect(config!.model).toBe('auto-model');
  });

  // ─── 14. API 拉取失败 → 回退 provider 默认模型 ──────────

  it('API 拉取模型失败时回退 provider 默认模型', async () => {
    mockDefaultCredential.mockResolvedValue({
      providerId: 'openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'http://localhost:8557',
    });

    const fetchMock = vi.fn().mockRejectedValue(new Error('network error'));
    vi.stubGlobal('fetch', fetchMock);

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    expect(config!.model).toBe('gpt-4o-mini');
  });

  // ─── 15. KB 设置凭证 model 为空字符串 → 回退拉取 ──────

  it('KB 设置 model 空字符串 + 凭证 model 空字符串 → 回退 API 拉取', async () => {
    await writeKbSettings({ llm: { providerId: 'kb-cred' } });
    mockGetCredential.mockResolvedValue({
      providerId: 'kb-cred',
      apiKey: 'sk-kb',
      baseUrl: 'http://kb.example:3000',
      model: '',
    });

    const fetchMock = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.endsWith('/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'fetched' }] }),
        } as unknown as Response;
      }
      return {} as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = await resolveKbLlmConfig();

    expect(config).not.toBeNull();
    expect(config!.model).toBe('fetched');
  });
});
