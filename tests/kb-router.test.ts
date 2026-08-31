/**
 * kb-router 端到端测试。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * mock electron（app.getPath 返回临时目录 + BrowserWindow.getAllWindows 返回空列表）
 * 和 project-service（requireProject 返回临时项目路径）。
 * 参照 dashboard-router 测试模式。
 *
 * 覆盖场景：
 *  - kb.register：空目录初始化标准结构、已有目录兼容校验、重复注册拒绝、路径校验
 *  - kb.unregister：成功注销、未注册拒绝、已挂载拒绝
 *  - kb.list：返回注册列表 + 统计 + 挂载标记
 *  - kb.mount：成功挂载、超限拒绝、未注册拒绝、重复挂载拒绝
 *  - kb.unmount：成功卸载、未挂载拒绝
 *  - kb.status：当前挂载库 + 结构健康检查
 *  - kb.upload：成功上传 → sources/ 副本 → 转换 → 分类 → index.md 条目
 *  - kb.documents：文档列表
 *  - kb.delete：删除文档
 *  - kb.retry：重试失败转换
 *  - kb.categories：分类树 + 计数
 *  - 输入校验：缺少必填参数拒绝
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Hoisted tmp dirs ──────────────────────────────────────

const { tmpDir, projectDir, globalDataDir } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const base = os.tmpdir() + `/sv-kb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
  dialog: {
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
  },
}));

vi.mock('../src/main/project/project-manager', () => ({
  projectManager: {
    listProjects: vi.fn(() => [{
      id: 'test-project-id',
      rootPath: projectDir,
      name: 'Test Project',
      lastOpenedAt: Date.now(),
    }]),
    getProjectByPath: vi.fn(() => ({
      id: 'test-project-id',
      rootPath: projectDir,
      name: 'Test Project',
      lastOpenedAt: Date.now(),
    })),
  },
}));

// Mock credential-manager: 默认返回 null 使 LLM 降级为占位条目
const { mockGetCredential, mockDefaultCredential } = vi.hoisted(() => ({
  mockGetCredential: vi.fn() as ReturnType<typeof vi.fn>,
  mockDefaultCredential: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock('../src/main/credentials/credential-manager', () => ({
  credentialManager: {
    get: mockGetCredential,
    getDefaultCredential: mockDefaultCredential.mockReturnValue(null),
  },
}));

// Mock deep-reindexer
const { mockDeepReindex } = vi.hoisted(() => ({
  mockDeepReindex: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock('../src/main/kb/deep-reindexer', () => ({
  deepReindex: mockDeepReindex,
}));

// Mock @firecrawl/anydoc：converter 依赖
const { toDocumentMock, toMarkdownBytesMock, formatFromPathMock } = vi.hoisted(() => ({
  toDocumentMock: vi.fn(),
  toMarkdownBytesMock: vi.fn(),
  formatFromPathMock: vi.fn(),
}));

vi.mock('@firecrawl/anydoc', () => ({
  toDocument: toDocumentMock,
  toMarkdownBytes: toMarkdownBytesMock,
  formatFromPath: formatFromPathMock,
  toMarkdown: vi.fn(),
  formatFromBytes: vi.fn(),
  formatFromExtension: vi.fn(),
}));

// ─── Imports (after mocks) ──────────────────────────────────

import { kbRouter } from '../src/main/ipc/routers/kb-router';
import { kbSettingsManager } from '../src/main/kb/kb-settings';
import type { KbListEntry, KbStatus, KbDocument, KbCategory } from '../src/main/kb/types';

const caller = kbRouter.createCaller({});

// ─── Type-safe extraction helpers ───────────────────────────

/** 从 register 结果提取 id（断言 ok） */
function regId(r: { ok: boolean; id?: string; error?: { code: string } }): string {
  if (!r.ok || !r.id) throw new Error('expected register success');
  return r.id;
}

/** 从 register 结果提取 data（断言 ok） */
function regData(r: { ok: boolean; id?: string; name?: string; path?: string; registeredAt?: number }): {
  id: string;
  name: string;
  path: string;
  registeredAt: number;
} {
  if (!r.ok || !r.id || !r.name || !r.path || !r.registeredAt) throw new Error('expected register success');
  return { id: r.id, name: r.name, path: r.path, registeredAt: r.registeredAt };
}

/** 从 mount 结果提取 data（断言 ok） */
function mountData(r: { ok: boolean; data?: { kbId: string; mountedAt: number }; error?: { code: string } }): {
  kbId: string;
  mountedAt: number;
} {
  if (!r.ok || !r.data) throw new Error('expected mount success');
  return r.data;
}

/** 从失败结果提取 error（断言 !ok） */
function errCode(r: { ok: boolean; error?: { code: string; message: string } }): string {
  if (r.ok || !r.error) throw new Error('expected failure');
  return r.error.code;
}

// ─── Helpers ────────────────────────────────────────────────

/** 重置注册表与挂载文件（确保每个测试干净） */
async function resetState(): Promise<void> {
  const { writeFile, mkdir: mkdirP } = await import('node:fs/promises');
  const regDir = join(globalDataDir, 'socverify-data');
  await mkdirP(regDir, { recursive: true });
  await writeFile(join(regDir, 'kb-registry.json'), '[]', 'utf-8');

  const mountDir = join(projectDir, '.socverify');
  await mkdirP(mountDir, { recursive: true });
  await writeFile(join(mountDir, 'kb-mounts.json'), '[]', 'utf-8');

  // 重置知识库设置（引擎 + LLM 显式配置）
  kbSettingsManager.resetCache();
  rmSync(join(regDir, 'kb-settings.json'), { force: true });
}

/** 创建一个空的知识库目录 */
function makeEmptyKbDir(name: string): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 创建一个已有结构的知识库目录（sources/ docs/ index.md） */
function makeExistingKbDir(name: string): string {
  const dir = join(tmpDir, name);
  mkdirSync(join(dir, 'sources'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'index.md'), '# 已有索引\n', 'utf-8');
  writeFileSync(join(dir, 'docs', 'doc1.md'), '# 文档1\n', 'utf-8');
  return dir;
}

/** 创建一个有分类结构的知识库目录 */
function makeCategorizedKbDir(name: string): string {
  const dir = join(tmpDir, name);
  mkdirSync(join(dir, 'sources'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'docs', '协议手册'), { recursive: true });
  mkdirSync(join(dir, 'docs', '验证计划'), { recursive: true });
  writeFileSync(join(dir, 'index.md'), '# 已有索引\n', 'utf-8');
  writeFileSync(join(dir, 'docs', '协议手册', 'DDR5.md'), '# DDR5\n', 'utf-8');
  writeFileSync(join(dir, 'docs', '验证计划', 'plan.md'), '# 验证计划\n', 'utf-8');
  return dir;
}

/** 创建一个假的源文件（模拟上传的 docx） */
function makeSourceFile(name: string): string {
  const dir = join(tmpDir, 'source-files');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04])); // fake zip header
  return filePath;
}

/** 设置 converter mock 为成功（返回无图片的 doc） */
function setupConverterSuccess(): void {
  formatFromPathMock.mockReturnValue('docx');
  toDocumentMock.mockResolvedValue({
    blocks: [{ kind: 'heading', level: 1, content: [{ kind: 'text', text: '测试文档' }] }],
    notes: [],
    assets: [],
  });
  toMarkdownBytesMock.mockResolvedValue('# 测试文档\n\n这是一段测试内容。');
}

/** 设置 converter mock 为失败 */
function setupConverterFailure(code: string, message: string): void {
  formatFromPathMock.mockReturnValue('docx');
  const err = new Error(message);
  (err as Error & { code: string }).code = code;
  toDocumentMock.mockRejectedValue(err);
}

// ─── Test Suite ─────────────────────────────────────────────

describe('kb-router', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetState();
    // 重置 converter mocks
    toDocumentMock.mockReset();
    toMarkdownBytesMock.mockReset();
    formatFromPathMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── kb.register ──────────────────────────────────────────

  describe('kb.register', () => {
    it('注册空目录自动创建 sources/ docs/ index.md 骨架', async () => {
      const kbDir = makeEmptyKbDir('empty-kb');
      const result = await caller.register({ name: '空库', path: kbDir });

      expect(result.ok).toBe(true);
      const data = regData(result);
      expect(data.name).toBe('空库');
      expect(data.path).toBe(kbDir);
      expect(data.id).toBeDefined();

      // 验证目录结构已初始化
      expect(existsSync(join(kbDir, 'sources'))).toBe(true);
      expect(existsSync(join(kbDir, 'docs'))).toBe(true);
      expect(existsSync(join(kbDir, 'index.md'))).toBe(true);

      // index.md 有骨架内容
      const indexContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('知识库索引');
    });

    it('注册已有结构目录通过兼容校验，不破坏既有内容', async () => {
      const kbDir = makeExistingKbDir('existing-kb');
      const result = await caller.register({ name: '已有库', path: kbDir });

      expect(result.ok).toBe(true);

      // 既有内容未被破坏
      expect(existsSync(join(kbDir, 'docs', 'doc1.md'))).toBe(true);
      const indexContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');
      expect(indexContent).toBe('# 已有索引\n');
    });

    it('注册已有结构但无 index.md 的目录补创建 index.md', async () => {
      const kbDir = makeEmptyKbDir('no-index-kb');
      // 创建 sources/ 和 docs/ 但不创建 index.md
      mkdirSync(join(kbDir, 'sources'), { recursive: true });
      mkdirSync(join(kbDir, 'docs'), { recursive: true });

      const result = await caller.register({ name: '补索引库', path: kbDir });

      expect(result.ok).toBe(true);
      expect(existsSync(join(kbDir, 'index.md'))).toBe(true);
    });

    it('重复注册相同路径被拒绝', async () => {
      const kbDir = makeEmptyKbDir('dup-kb');
      const result1 = await caller.register({ name: '库A', path: kbDir });
      expect(result1.ok).toBe(true);

      const result2 = await caller.register({ name: '库B', path: kbDir });
      expect(result2.ok).toBe(false);
      expect(errCode(result2)).toBe('alreadyRegistered');
    });

    it('重复注册相同名称被拒绝', async () => {
      const kbDir1 = makeEmptyKbDir('dup-name-1');
      const kbDir2 = makeEmptyKbDir('dup-name-2');
      await caller.register({ name: '同名库', path: kbDir1 });

      const result2 = await caller.register({ name: '同名库', path: kbDir2 });
      expect(result2.ok).toBe(false);
      expect(errCode(result2)).toBe('alreadyRegistered');
    });

    it('路径不存在被拒绝', async () => {
      const result = await caller.register({ name: '不存在的库', path: join(tmpDir, 'nonexistent-path') });
      expect(result.ok).toBe(false);
      expect(errCode(result)).toBe('pathNotFound');
    });

    it('路径是文件不是目录被拒绝', async () => {
      const filePath = join(tmpDir, 'a-file.txt');
      writeFileSync(filePath, 'hello', 'utf-8');
      const result = await caller.register({ name: '文件库', path: filePath });
      expect(result.ok).toBe(false);
      expect(errCode(result)).toBe('pathNotDirectory');
    });

    it('缺少 name 参数抛出 BAD_REQUEST', async () => {
      const kbDir = makeEmptyKbDir('no-name');
      await expect(
        caller.register({ path: kbDir } as { name: string; path: string }),
      ).rejects.toThrow();
    });

    it('缺少 path 参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.register({ name: '无路径库' } as { name: string; path: string }),
      ).rejects.toThrow();
    });
  });

  // ─── kb.list ──────────────────────────────────────────────

  describe('kb.list', () => {
    it('返回已注册库列表 + 文档数/分类数统计', async () => {
      const kbDir = makeCategorizedKbDir('list-kb');
      await caller.register({ name: '统计库', path: kbDir });

      const list: KbListEntry[] = await caller.list({});
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('统计库');
      expect(list[0].documentCount).toBe(2);
      expect(list[0].categoryCount).toBe(2);
      expect(list[0].isMounted).toBe(false);
    });

    it('未挂载时 isMounted 为 false', async () => {
      const kbDir = makeEmptyKbDir('unmounted-kb');
      await caller.register({ name: '未挂载库', path: kbDir });

      const list: KbListEntry[] = await caller.list({});
      expect(list[0].isMounted).toBe(false);
    });

    it('挂载后 isMounted 为 true', async () => {
      const kbDir = makeEmptyKbDir('mounted-kb');
      const regResult = await caller.register({ name: '挂载库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      const list: KbListEntry[] = await caller.list({});
      expect(list[0].isMounted).toBe(true);
    });

    it('空注册表返回空数组', async () => {
      const list: KbListEntry[] = await caller.list({});
      expect(list).toEqual([]);
    });
  });

  // ─── kb.mount ─────────────────────────────────────────────

  describe('kb.mount', () => {
    it('成功挂载知识库到项目', async () => {
      const kbDir = makeEmptyKbDir('mount-kb');
      const regResult = await caller.register({ name: '可挂载库', path: kbDir });

      const result = await caller.mount({ kbId: regId(regResult) });
      expect(result.ok).toBe(true);
      expect(mountData(result).kbId).toBe(regId(regResult));
    });

    it('挂载关系持久化到项目配置', async () => {
      const kbDir = makeEmptyKbDir('persist-kb');
      const regResult = await caller.register({ name: '持久化库', path: kbDir });
      const id = regId(regResult);
      await caller.mount({ kbId: id });

      const mountPath = join(projectDir, '.socverify', 'kb-mounts.json');
      expect(existsSync(mountPath)).toBe(true);
      const mounts = JSON.parse(readFileSync(mountPath, 'utf-8'));
      expect(mounts).toHaveLength(1);
      expect(mounts[0].kbId).toBe(id);
    });

    it('v1 挂载第二个库被拒绝并返回明确错误', async () => {
      const kbDir1 = makeEmptyKbDir('first-kb');
      const kbDir2 = makeEmptyKbDir('second-kb');
      const reg1 = await caller.register({ name: '第一库', path: kbDir1 });
      const reg2 = await caller.register({ name: '第二库', path: kbDir2 });

      await caller.mount({ kbId: regId(reg1) });
      const result = await caller.mount({ kbId: regId(reg2) });

      expect(result.ok).toBe(false);
      expect(errCode(result)).toBe('mountLimitExceeded');
    });

    it('挂载未注册的库被拒绝', async () => {
      const result = await caller.mount({ kbId: 'nonexistent-id' });
      expect(result.ok).toBe(false);
      expect(errCode(result)).toBe('notRegistered');
    });

    it('重复挂载同一库被拒绝', async () => {
      const kbDir = makeEmptyKbDir('remount-kb');
      const regResult = await caller.register({ name: '重复挂载库', path: kbDir });
      const id = regId(regResult);

      await caller.mount({ kbId: id });
      const result = await caller.mount({ kbId: id });

      expect(result.ok).toBe(false);
      expect(errCode(result)).toBe('alreadyMounted');
    });

    it('缺少 kbId 参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.mount({} as { kbId: string }),
      ).rejects.toThrow();
    });

    it('挂载扫描不吞知识库自身的 index.md', async () => {
      const kbDir = makeExistingKbDir('self-ingest-kb');
      const regResult = await caller.register({ name: '自吞检查库', path: kbDir });

      try {
        await caller.mount({ kbId: regId(regResult) });

        // 根目录 index.md 不应被复制进 sources/ 当作文档上传
        expect(existsSync(join(kbDir, 'sources', 'index.md'))).toBe(false);
        expect(existsSync(join(kbDir, 'index.md'))).toBe(true);
      } finally {
        await caller.unmount({ kbId: regId(regResult) }).catch(() => undefined);
      }
    });
  });

  // ─── kb.unmount ───────────────────────────────────────────

  describe('kb.unmount', () => {
    it('成功卸载知识库', async () => {
      const kbDir = makeEmptyKbDir('unmount-kb');
      const regResult = await caller.register({ name: '可卸载库', path: kbDir });
      const id = regId(regResult);
      await caller.mount({ kbId: id });

      const result = await caller.unmount({ kbId: id });
      expect(result.ok).toBe(true);

      const mountPath = join(projectDir, '.socverify', 'kb-mounts.json');
      const mounts = JSON.parse(readFileSync(mountPath, 'utf-8'));
      expect(mounts).toHaveLength(0);
    });

    it('卸载未挂载的库被拒绝', async () => {
      const result = await caller.unmount({ kbId: 'nonexistent-id' });
      expect(result.ok).toBe(false);
      expect(errCode(result)).toBe('notMounted');
    });

    it('缺少 kbId 参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.unmount({} as { kbId: string }),
      ).rejects.toThrow();
    });
  });

  // ─── kb.unregister ────────────────────────────────────────

  describe('kb.unregister', () => {
    it('成功注销知识库', async () => {
      const kbDir = makeEmptyKbDir('unreg-kb');
      const regResult = await caller.register({ name: '可注销库', path: kbDir });

      const result = await caller.unregister({ kbId: regId(regResult) });
      expect(result.ok).toBe(true);

      const list: KbListEntry[] = await caller.list({});
      expect(list).toHaveLength(0);
    });

    it('注销未注册的库被拒绝', async () => {
      const result = await caller.unregister({ kbId: 'nonexistent-id' });
      expect(result.ok).toBe(false);
      expect(errCode(result)).toBe('notRegistered');
    });

    it('已挂载的库不可注销（先卸载提示）', async () => {
      const kbDir = makeEmptyKbDir('mounted-unreg-kb');
      const regResult = await caller.register({ name: '已挂载注销库', path: kbDir });
      const id = regId(regResult);
      await caller.mount({ kbId: id });

      const result = await caller.unregister({ kbId: id });
      expect(result.ok).toBe(false);
      expect(errCode(result)).toBe('alreadyMounted');
      if (result.ok || !result.error) throw new Error('expected failure');
      expect(result.error.message).toContain('卸载');
    });

    it('缺少 kbId 参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.unregister({} as { kbId: string }),
      ).rejects.toThrow();
    });
  });

  // ─── kb.status ────────────────────────────────────────────

  describe('kb.status', () => {
    it('返回当前挂载库 + 结构健康检查', async () => {
      const kbDir = makeExistingKbDir('status-kb');
      const regResult = await caller.register({ name: '状态库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      const result: KbStatus = await caller.status({});
      expect(result.mounted).not.toBeNull();
      expect(result.mounted!.name).toBe('状态库');
      expect(result.mounted!.path).toBe(kbDir);
      expect(result.health.hasSources).toBe(true);
      expect(result.health.hasDocs).toBe(true);
      expect(result.health.hasIndex).toBe(true);
    });

    it('未挂载时 mounted 为 null', async () => {
      const result: KbStatus = await caller.status({});
      expect(result.mounted).toBeNull();
      expect(result.health.hasSources).toBe(false);
      expect(result.health.hasDocs).toBe(false);
      expect(result.health.hasIndex).toBe(false);
    });

    it('挂载库被注销后 status 不报错（mounted 为 null）', async () => {      const kbDir = makeEmptyKbDir('gone-kb');
      const regResult = await caller.register({ name: '已消失库', path: kbDir });
      const id = regId(regResult);
      await caller.mount({ kbId: id });

      // 先卸载再注销，然后手动恢复挂载记录（模拟残留）
      await caller.unmount({ kbId: id });
      await caller.unregister({ kbId: id });
      const { writeFile, mkdir: mkdirP } = await import('node:fs/promises');
      const mountDir = join(projectDir, '.socverify');
      await mkdirP(mountDir, { recursive: true });
      await writeFile(
        join(mountDir, 'kb-mounts.json'),
        JSON.stringify([{ kbId: id, mountedAt: Date.now() }]),
        'utf-8',
      );

      const result: KbStatus = await caller.status({});
      expect(result.mounted).toBeNull();
    });

    it('挂载库路径被删除后 health 反映缺失', async () => {
      const kbDir = makeExistingKbDir('deleted-kb');
      const regResult = await caller.register({ name: '被删库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      rmSync(kbDir, { recursive: true, force: true });

      const result: KbStatus = await caller.status({});
      expect(result.mounted).not.toBeNull();
      expect(result.health.hasSources).toBe(false);
      expect(result.health.hasDocs).toBe(false);
      expect(result.health.hasIndex).toBe(false);
    });
  });

  // ─── 持久化验证 ───────────────────────────────────────────

  describe('持久化', () => {
    it('挂载关系持久化到项目配置，重开应用后保持', async () => {
      const kbDir = makeEmptyKbDir('persist-mount-kb');
      const regResult = await caller.register({ name: '持久挂载库', path: kbDir });
      const id = regId(regResult);
      await caller.mount({ kbId: id });

      // 模拟"重开应用"：重新读取注册表和挂载配置
      const list: KbListEntry[] = await caller.list({});
      expect(list[0].isMounted).toBe(true);

      const statusResult: KbStatus = await caller.status({});
      expect(statusResult.mounted).not.toBeNull();
      expect(statusResult.mounted!.kbId).toBe(id);
    });
  });

  // ─── kb.upload ────────────────────────────────────────────

  describe('kb.upload', () => {
    it('上传 → sources/ 副本 → 转换 → 分类归位 → index.md 增量条目', async () => {
      const kbDir = makeEmptyKbDir('upload-kb');
      const regResult = await caller.register({ name: '上传库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      // Mock converter 成功
      setupConverterSuccess();

      const sourcePath = makeSourceFile('验证计划.docx');
      const result = await caller.upload({ filePaths: [sourcePath] });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].ok).toBe(true);

      // 验证 sources/ 副本存在
      expect(existsSync(join(kbDir, 'sources', '验证计划.docx'))).toBe(true);

      // 验证 index.md 有条目
      const indexContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('验证计划');
    });

    it('同名上传覆盖触发完整重转', async () => {
      const kbDir = makeEmptyKbDir('overwrite-kb');
      const regResult = await caller.register({ name: '覆盖库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      setupConverterSuccess();

      const sourcePath = makeSourceFile('覆盖测试.docx');

      // 第一次上传
      await caller.upload({ filePaths: [sourcePath] });

      // 第二次上传同名文件
      const result = await caller.upload({ filePaths: [sourcePath] });
      expect(result.results[0].ok).toBe(true);
    });

    it('扫描版 PDF（unsupported）失败可见：状态 + 错误码持久化', async () => {
      const kbDir = makeEmptyKbDir('pdf-kb');
      const regResult = await caller.register({ name: 'PDF库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      setupConverterFailure('unsupported', 'image-only PDF');

      const sourcePath = makeSourceFile('扫描版.pdf');
      const result = await caller.upload({ filePaths: [sourcePath] });

      expect(result.results).toHaveLength(1);
      // 转换失败时 document.status 为 failed + errorCode
      if (!result.results[0].ok) throw new Error('expected document result');
      expect(result.results[0].document.status).toBe('failed');
      expect(result.results[0].document.errorCode).toBe('unsupported');
    });

    it('未挂载知识库时上传被拒绝', async () => {
      setupConverterSuccess();
      const sourcePath = makeSourceFile('无库.docx');
      await expect(
        caller.upload({ filePaths: [sourcePath] }),
      ).rejects.toThrow();
    });

    it('缺少 filePaths 参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.upload({} as { filePaths: string[] }),
      ).rejects.toThrow();
    });

    it('空 filePaths 数组抛出 BAD_REQUEST', async () => {
      await expect(
        caller.upload({ filePaths: [] }),
      ).rejects.toThrow();
    });
  });

  // ─── kb.documents ──────────────────────────────────────────

  describe('kb.documents', () => {
    it('返回文档列表', async () => {
      const kbDir = makeEmptyKbDir('docs-kb');
      const regResult = await caller.register({ name: '文档库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      // 手动放入 sources/ 文件和 docs/ Markdown
      writeFileSync(join(kbDir, 'sources', 'manual.docx'), 'fake');
      mkdirSync(join(kbDir, 'docs', '协议手册'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '协议手册', 'manual.md'), '# 手动文档\n');

      const docs: KbDocument[] = await caller.documents({});
      expect(docs.length).toBeGreaterThan(0);
      expect(docs.some((d) => d.name === 'manual')).toBe(true);
      const manualDoc = docs.find((d) => d.name === 'manual');
      expect(manualDoc?.category).toBe('协议手册');
      expect(manualDoc?.status).toBe('done');
    });

    it('未挂载知识库时查询被拒绝', async () => {
      await expect(caller.documents({})).rejects.toThrow();
    });
  });

  // ─── kb.delete ────────────────────────────────────────────

  describe('kb.delete', () => {
    it('删除文档：源文件 + Markdown + 索引条目一并清理', async () => {
      const kbDir = makeEmptyKbDir('delete-kb');
      const regResult = await caller.register({ name: '删除库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      setupConverterSuccess();
      const sourcePath = makeSourceFile('待删除.docx');
      await caller.upload({ filePaths: [sourcePath] });

      // 确认文档存在
      expect(existsSync(join(kbDir, 'sources', '待删除.docx'))).toBe(true);

      // 删除
      const result = await caller.delete({ name: '待删除' });
      expect(result.ok).toBe(true);

      // 源文件已删除
      expect(existsSync(join(kbDir, 'sources', '待删除.docx'))).toBe(false);
    });

    it('删除 DDR5 不误删 My_DDR5：索引条目按路径末段精确匹配（不用子串匹配）', async () => {
      const kbDir = makeEmptyKbDir('delete-suffix-kb');
      const regResult = await caller.register({ name: '后缀安全库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      // 手工构造两个名字互为后缀的文档（子串匹配会把 My_DDR5 误判为 DDR5 的条目）
      mkdirSync(join(kbDir, 'docs', '协议手册'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '协议手册', 'DDR5.md'), '# DDR5\n');
      writeFileSync(join(kbDir, 'docs', '协议手册', 'My_DDR5.md'), '# My DDR5\n');
      writeFileSync(
        join(kbDir, 'index.md'),
        [
          '# 知识库索引',
          '',
          '## 协议手册',
          '',
          '### DDR5',
          '- **路径**: `协议手册/DDR5.md`',
          '- **摘要**: DDR5',
          '',
          '### My DDR5',
          '- **路径**: `协议手册/My_DDR5.md`',
          '- **摘要**: My DDR5',
          '',
        ].join('\n'),
        'utf-8',
      );

      const result = await caller.delete({ name: 'DDR5' });
      expect(result.ok).toBe(true);

      // DDR5.md 与其索引条目被删除
      expect(existsSync(join(kbDir, 'docs', '协议手册', 'DDR5.md'))).toBe(false);
      const indexAfter = readFileSync(join(kbDir, 'index.md'), 'utf-8');
      expect(indexAfter).not.toContain('`协议手册/DDR5.md`');

      // My_DDR5.md 及其索引条目完好
      expect(existsSync(join(kbDir, 'docs', '协议手册', 'My_DDR5.md'))).toBe(true);
      expect(indexAfter).toContain('`协议手册/My_DDR5.md`');
    });

    it('缺少 name 参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.delete({} as { name: string }),
      ).rejects.toThrow();
    });
  });

  // ─── kb.retry ─────────────────────────────────────────────

  describe('kb.retry', () => {
    it('重试失败转换：清理旧产物并重新走流水线', async () => {
      const kbDir = makeEmptyKbDir('retry-kb');
      const regResult = await caller.register({ name: '重试库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      // 第一次上传失败
      setupConverterFailure('unsupported', 'image-only PDF');
      const sourcePath = makeSourceFile('重试测试.pdf');
      await caller.upload({ filePaths: [sourcePath] });

      // 第二次重试时设置成功（模拟用户修复了文件）
      setupConverterSuccess();
      const result = await caller.retry({ name: '重试测试' });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected retry success');
      expect(result.document.status).toBe('done');
    });

    it('重试不存在的文档返回错误', async () => {
      const kbDir = makeEmptyKbDir('retry-not-found-kb');
      const regResult = await caller.register({ name: '重试不存在库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      const result = await caller.retry({ name: '不存在' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('notFound');
      }
    });

    it('缺少 name 参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.retry({} as { name: string }),
      ).rejects.toThrow();
    });
  });

  // ─── kb.categories ─────────────────────────────────────────

  describe('kb.categories', () => {
    it('返回分类树 + 计数', async () => {
      const kbDir = makeCategorizedKbDir('categories-kb');
      const regResult = await caller.register({ name: '分类库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      const cats: KbCategory[] = await caller.categories({});
      expect(cats.length).toBeGreaterThanOrEqual(2);
      expect(cats.some((c) => c.name === '协议手册')).toBe(true);
      expect(cats.some((c) => c.name === '验证计划')).toBe(true);
      // 每个分类下有 1 个文档
      const protocolCat = cats.find((c) => c.name === '协议手册');
      expect(protocolCat?.count).toBe(1);
    });

    it('未挂载知识库时查询被拒绝', async () => {
      await expect(caller.categories({})).rejects.toThrow();
    });
  });

  // ─── kb.index ──────────────────────────────────────────────

  describe('kb.index', () => {
    it('读取 index.md 内容', async () => {
      const kbDir = makeExistingKbDir('index-read-kb');
      const regResult = await caller.register({ name: '索引读取库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      const result = await caller.index({});
      expect(result.content).toContain('已有索引');
    });

    it('写入 index.md 内容', async () => {
      const kbDir = makeEmptyKbDir('index-write-kb');
      const regResult = await caller.register({ name: '索引写入库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      await caller.index({ content: '# 自定义索引\n\n## 测试\n' });

      const result = await caller.index({});
      expect(result.content).toContain('自定义索引');
    });

    it('未挂载知识库时被拒绝', async () => {
      await expect(caller.index({})).rejects.toThrow();
    });
  });

  // ─── kb.preview ────────────────────────────────────────────

  describe('kb.preview', () => {
    it('读取文档 Markdown 内容', async () => {
      const kbDir = makeEmptyKbDir('preview-kb');
      const regResult = await caller.register({ name: '预览库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      // 手动放入 docs/ Markdown
      mkdirSync(join(kbDir, 'docs', '协议手册'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '协议手册', 'test.md'), '# 测试文档\n\n内容', 'utf-8');

      const result = await caller.preview({ name: 'test' });
      expect(result.content).toContain('测试文档');
    });

    it('文档不存在时返回 null', async () => {
      const kbDir = makeEmptyKbDir('preview-not-found-kb');
      const regResult = await caller.register({ name: '预览不存在库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      const result = await caller.preview({ name: '不存在' });
      expect(result.content).toBeNull();
    });

    it('未挂载知识库时被拒绝', async () => {
      await expect(caller.preview({ name: 'test' })).rejects.toThrow();
    });

    it('缺少 name 参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.preview({} as { name: string }),
      ).rejects.toThrow();
    });
  });

  // ─── kb.moveCategory ───────────────────────────────────────

  describe('kb.moveCategory', () => {
    it('移动文档到新分类', async () => {
      const kbDir = makeEmptyKbDir('move-kb');
      const regResult = await caller.register({ name: '移动库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      // 创建初始分类和文档
      mkdirSync(join(kbDir, 'docs', '旧分类'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '旧分类', 'movetest.md'), '# 测试\n', 'utf-8');
      writeFileSync(join(kbDir, 'index.md'), '# 知识库索引\n\n## 旧分类\n\n### 测试\n- **路径**: `旧分类/movetest.md`\n- **摘要**: 测试摘要\n', 'utf-8');

      const result = await caller.moveCategory({ name: 'movetest', category: '新分类' });
      expect(result.ok).toBe(true);

      // 验证文件已移动
      expect(existsSync(join(kbDir, 'docs', '新分类', 'movetest.md'))).toBe(true);
      expect(existsSync(join(kbDir, 'docs', '旧分类', 'movetest.md'))).toBe(false);

      // 验证 index.md 已更新
      const indexContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('新分类');
      expect(indexContent).toContain('新分类/movetest.md');
    });

    it('文档不存在时返回 notFound', async () => {
      const kbDir = makeEmptyKbDir('move-not-found-kb');
      const regResult = await caller.register({ name: '移动不存在库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      const result = await caller.moveCategory({ name: '不存在', category: '新分类' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('notFound');
      }
    });

    it('未挂载知识库时被拒绝', async () => {
      await expect(
        caller.moveCategory({ name: 'test', category: 'cat' }),
      ).rejects.toThrow();
    });

    it('缺少 name 参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.moveCategory({ category: 'cat' } as { name: string; category: string }),
      ).rejects.toThrow();
    });

    it('缺少 category 参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.moveCategory({ name: 'test' } as { name: string; category: string }),
      ).rejects.toThrow();
    });
  });

  // ─── kb.renameCategory ─────────────────────────────────────

  describe('kb.renameCategory', () => {
    it('重命名分类：目录重命名 + index.md 路径与分类同步更新', async () => {
      const kbDir = makeEmptyKbDir('rename-kb');
      const regResult = await caller.register({ name: '重命名库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      mkdirSync(join(kbDir, 'docs', '未分类'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '未分类', '03_UVM-Harness.md'), '# UVM Harness\n', 'utf-8');
      writeFileSync(join(kbDir, 'index.md'), [
        '# 知识库索引',
        '',
        '## 未分类',
        '',
        '### 03_UVM-Harness',
        '- **路径**: `未分类/03_UVM-Harness.md`',
        '- **摘要**: （暂无摘要）',
        '',
      ].join('\n'), 'utf-8');

      const result = await caller.renameCategory({ oldName: '未分类', newName: 'UVM' });
      expect(result.ok).toBe(true);

      // 目录已重命名
      expect(existsSync(join(kbDir, 'docs', 'UVM', '03_UVM-Harness.md'))).toBe(true);
      expect(existsSync(join(kbDir, 'docs', '未分类'))).toBe(false);

      // index.md 路径已更新为新分类前缀
      const indexContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('`UVM/03_UVM-Harness.md`');
      expect(indexContent).not.toContain('未分类');
    });

    it('历史脏数据（未分类/未分类/x.md）重命名后路径一并修复', async () => {
      const kbDir = makeEmptyKbDir('rename-dirty-kb');
      const regResult = await caller.register({ name: '脏数据库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      mkdirSync(join(kbDir, 'docs', '未分类'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '未分类', 'doc.md'), '# doc\n', 'utf-8');
      // 历史重复上传 bug 产生的双层前缀脏路径
      writeFileSync(join(kbDir, 'index.md'), [
        '# 知识库索引',
        '',
        '## 未分类',
        '',
        '### doc',
        '- **路径**: `未分类/未分类/doc.md`',
        '- **摘要**: （暂无摘要）',
        '',
      ].join('\n'), 'utf-8');

      const result = await caller.renameCategory({ oldName: '未分类', newName: '验证方法' });
      expect(result.ok).toBe(true);

      const indexContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('`验证方法/doc.md`');
      expect(indexContent).not.toContain('未分类/未分类');
    });

    it('分类不存在时返回 notFound', async () => {
      const kbDir = makeEmptyKbDir('rename-not-found-kb');
      const regResult = await caller.register({ name: '重命名不存在库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      const result = await caller.renameCategory({ oldName: '不存在', newName: '新名字' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('notFound');
      }
    });

    it('缺少参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.renameCategory({ oldName: 'a' } as { oldName: string; newName: string }),
      ).rejects.toThrow();
    });
  });

  // ─── kb.reclassify ─────────────────────────────────────────

  describe('kb.reclassify', () => {
    it('未配置 LLM 凭证时返回 noLlmConfig 错误（不静默降级）', async () => {
      const kbDir = makeEmptyKbDir('reclassify-nollm-kb');
      const regResult = await caller.register({ name: '无凭证库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      mkdirSync(join(kbDir, 'docs', '未分类'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '未分类', 'doc.md'), '# doc\n', 'utf-8');

      const result = await caller.reclassify({ name: 'doc' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('noLlmConfig');
      }
    });

    it('AI 重新分类成功：更新摘要并移动到新分类目录', async () => {
      const kbDir = makeEmptyKbDir('reclassify-ok-kb');
      const regResult = await caller.register({ name: '重分类库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      mkdirSync(join(kbDir, 'docs', '未分类'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '未分类', 'uvm.md'), '# UVM Harness\n\nUVM 验证方法学文档。\n', 'utf-8');
      writeFileSync(join(kbDir, 'index.md'), '# 知识库索引\n', 'utf-8');

      // 配置 LLM 凭证（resolveActiveCredential 回退 default credential）
      mockDefaultCredential.mockReturnValue({
        providerId: 'openai-compatible',
        apiKey: 'sk-test',
        baseUrl: 'http://localhost:8557',
        model: 'test-model',
      });

      // mock 全局 fetch 返回 openai 格式分类结果
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: '{"category": "验证方法", "title": "UVM Harness", "summary": "UVM 验证方法学", "keywords": ["UVM", "验证"]}',
            },
          }],
        }),
      } as unknown as Response);
      vi.stubGlobal('fetch', fetchMock);

      try {
        const result = await caller.reclassify({ name: 'uvm' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.category).toBe('验证方法');
          expect(result.moved).toBe(true);
        }

        // 文件已移动
        expect(existsSync(join(kbDir, 'docs', '验证方法', 'uvm.md'))).toBe(true);
        expect(existsSync(join(kbDir, 'docs', '未分类', 'uvm.md'))).toBe(false);

        // index.md 已更新（最终路径 + 摘要）
        const indexContent = readFileSync(join(kbDir, 'index.md'), 'utf-8');
        expect(indexContent).toContain('`验证方法/uvm.md`');
        expect(indexContent).toContain('UVM 验证方法学');
      } finally {
        vi.unstubAllGlobals();
        mockDefaultCredential.mockReturnValue(null);
      }
    });

    it('凭证未配置模型时复用 Agent 会话持久化的模型（修复 404 model not found）', async () => {
      const kbDir = makeEmptyKbDir('reclassify-session-model-kb');
      const regResult = await caller.register({ name: '会话模型库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      mkdirSync(join(kbDir, 'docs', '未分类'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '未分类', 'doc.md'), '# doc\n', 'utf-8');

      // 项目最近 AI 会话持久化了中转网关上实际使用的模型
      const socverifyDir = join(projectDir, '.socverify');
      mkdirSync(socverifyDir, { recursive: true });
      writeFileSync(join(socverifyDir, 'sessions.json'), JSON.stringify([{
        sessionId: 's1',
        name: 'Agent 会话',
        projectId: 'test-project-id',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        model: { provider: 'openai', id: 'glm-4.7', name: 'GLM-4.7', providerId: 'relay-cred' },
      }]), 'utf-8');

      // 对应凭证存在但未填写可选的 model 字段
      mockGetCredential.mockResolvedValue({
        providerId: 'relay-cred',
        apiKey: 'sk-relay',
        baseUrl: 'http://relay.example:3000',
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: '{"category": "验证方法", "title": "doc", "summary": "摘要", "keywords": ["a"]}',
            },
          }],
        }),
      } as unknown as Response);
      vi.stubGlobal('fetch', fetchMock);

      try {
        const result = await caller.reclassify({ name: 'doc' });
        expect(result.ok).toBe(true);

        // LLM 请求使用会话模型而非硬编码默认模型
        const chatCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/chat/completions'));
        expect(chatCall).toBeDefined();
        const body = JSON.parse(String((chatCall?.[1] as RequestInit | undefined)?.body)) as { model: string };
        expect(body.model).toBe('glm-4.7');
      } finally {
        vi.unstubAllGlobals();
        mockGetCredential.mockReset();
        rmSync(join(socverifyDir, 'sessions.json'), { force: true });
      }
    });

    it('凭证与会话均无模型时自动拉取端点第一个可用模型', async () => {
      const kbDir = makeEmptyKbDir('reclassify-autofetch-kb');
      const regResult = await caller.register({ name: '自动选模库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      mkdirSync(join(kbDir, 'docs', '未分类'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '未分类', 'doc.md'), '# doc\n', 'utf-8');

      // 默认凭证（无 model 字段、无 Agent 会话）
      mockDefaultCredential.mockReturnValue({
        providerId: 'openai-compatible',
        apiKey: 'sk-test',
        baseUrl: 'http://localhost:8557',
      });

      const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: 'relay-first-model' }, { id: 'relay-second' }] }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: '{"category": "验证方法", "title": "doc", "summary": "摘要", "keywords": ["a"]}',
              },
            }],
          }),
        } as unknown as Response;
      });
      vi.stubGlobal('fetch', fetchMock);

      try {
        const result = await caller.reclassify({ name: 'doc' });
        expect(result.ok).toBe(true);

        const chatCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/chat/completions'));
        expect(chatCall).toBeDefined();
        const body = JSON.parse(String((chatCall?.[1] as RequestInit | undefined)?.body)) as { model: string };
        expect(body.model).toBe('relay-first-model');
      } finally {
        vi.unstubAllGlobals();
        mockDefaultCredential.mockReturnValue(null);
      }
    });

    it('凭证 model 为空字符串时视为未指定（继续回退拉取，不产生空模型名）', async () => {
      const kbDir = makeEmptyKbDir('reclassify-empty-model-kb');
      const regResult = await caller.register({ name: '空模型库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      mkdirSync(join(kbDir, 'docs', '未分类'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '未分类', 'doc.md'), '# doc\n', 'utf-8');

      // 凭证 model 字段被清空为 ''（表单清空场景）
      mockDefaultCredential.mockReturnValue({
        providerId: 'openai-compatible',
        apiKey: 'sk-test',
        baseUrl: 'http://localhost:8557',
        model: '',
      });

      const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: 'fetched-model' }] }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: '{"category": "验证方法", "title": "doc", "summary": "摘要", "keywords": ["a"]}',
              },
            }],
          }),
        } as unknown as Response;
      });
      vi.stubGlobal('fetch', fetchMock);

      try {
        const result = await caller.reclassify({ name: 'doc' });
        expect(result.ok).toBe(true);

        const chatCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/chat/completions'));
        expect(chatCall).toBeDefined();
        const body = JSON.parse(String((chatCall?.[1] as RequestInit | undefined)?.body)) as { model: string };
        expect(body.model).toBe('fetched-model');
      } finally {
        vi.unstubAllGlobals();
        mockDefaultCredential.mockReturnValue(null);
      }
    });

    it('LLM 调用失败时返回 llmFailed 错误', async () => {
      const kbDir = makeEmptyKbDir('reclassify-fail-kb');
      const regResult = await caller.register({ name: '重分类失败库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      mkdirSync(join(kbDir, 'docs', '未分类'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '未分类', 'doc.md'), '# doc\n', 'utf-8');

      mockDefaultCredential.mockReturnValue({
        providerId: 'openai-compatible',
        apiKey: 'sk-test',
        baseUrl: 'http://localhost:8557',
        model: 'test-model',
      });

      const fetchMock = vi.fn().mockRejectedValue(new Error('network error'));
      vi.stubGlobal('fetch', fetchMock);

      try {
        const result = await caller.reclassify({ name: 'doc' });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('llmFailed');
          expect(result.error.message).toContain('network error');
        }
      } finally {
        vi.unstubAllGlobals();
        mockDefaultCredential.mockReturnValue(null);
      }
    });

    it('文档不存在时返回 notFound', async () => {
      const kbDir = makeEmptyKbDir('reclassify-notfound-kb');
      const regResult = await caller.register({ name: '重分类不存在库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      const result = await caller.reclassify({ name: '不存在' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('notFound');
      }
    });

    it('缺少 name 参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.reclassify({} as { name: string }),
      ).rejects.toThrow();
    });
  });

  // ─── kb.deepReindex ────────────────────────────────────────

  describe('kb.deepReindex', () => {
    it('触发深度重建并返回成功', async () => {
      const kbDir = makeEmptyKbDir('reindex-kb');
      const regResult = await caller.register({ name: '重建库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      mockDeepReindex.mockResolvedValue({
        ok: true,
        sessionId: 'temp-session-1',
        documentCount: 5,
      });

      const result = await caller.deepReindex({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sessionId).toBe('temp-session-1');
        expect(result.documentCount).toBe(5);
      }
    });

    it('深度重建失败时返回错误', async () => {
      const kbDir = makeEmptyKbDir('reindex-fail-kb');
      const regResult = await caller.register({ name: '重建失败库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      mockDeepReindex.mockResolvedValue({
        ok: false,
        error: { code: 'sessionFailed', message: 'LLM 配置异常' },
      });

      const result = await caller.deepReindex({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('sessionFailed');
        expect(result.error.message).toContain('LLM');
      }
    });

    it('未挂载知识库时被拒绝', async () => {
      await expect(caller.deepReindex({})).rejects.toThrow();
    });
  });

  // ─── kb.getSettings / kb.updateSettings ─────────────────────

  describe('kb.getSettings', () => {
    it('默认返回 anydoc 引擎 + 空 LLM 配置 + 引擎元信息', async () => {
      const result = await caller.getSettings({});

      expect(result.settings.convertEngine).toBe('anydoc');
      expect(result.settings.llm).toEqual({});
      expect(result.engines.map((e) => e.id)).toEqual(['anydoc']);
      for (const engine of result.engines) {
        expect(engine.label).toBeTruthy();
        expect(engine.supportedExtensions.length).toBeGreaterThan(0);
      }
    });
  });

  describe('kb.updateSettings', () => {
    it('保存引擎与 LLM 显式配置并持久化（重新读取生效）', async () => {
      await caller.updateSettings({
        convertEngine: 'anydoc',
        llm: { providerId: 'relay-cred', model: 'glm-4.7' },
      });

      // 清缓存模拟重启
      kbSettingsManager.resetCache();
      const result = await caller.getSettings({});
      expect(result.settings.convertEngine).toBe('anydoc');
      expect(result.settings.llm.providerId).toBe('relay-cred');
      expect(result.settings.llm.model).toBe('glm-4.7');
    });

    it('llm 传空字符串清除显式配置（回退自动）', async () => {
      await caller.updateSettings({
        convertEngine: 'anydoc',
        llm: { providerId: 'relay-cred', model: 'glm-4.7' },
      });
      const result = await caller.updateSettings({
        convertEngine: 'anydoc',
        llm: { providerId: '', model: '' },
      });

      expect(result.settings.llm).toEqual({});
    });

    it('非法引擎 ID 抛出 BAD_REQUEST', async () => {
      await expect(
        caller.updateSettings({ convertEngine: 'pandoc' } as { convertEngine: string; llm: { providerId?: string; model?: string } }),
      ).rejects.toThrow();
    });

    it('llm 字段类型错误抛出 BAD_REQUEST', async () => {
      await expect(
        caller.updateSettings({
          convertEngine: 'anydoc',
          llm: { providerId: 123 },
        } as unknown as { convertEngine: string; llm: { providerId?: string; model?: string } }),
      ).rejects.toThrow();
    });
  });

  // ─── KB 设置显式模型 > 自动推导 ─────────────────────────────

  describe('reclassify × KB 设置显式模型', () => {
    it('KB 设置显式指定凭证与模型时优先生效', async () => {
      const kbDir = makeEmptyKbDir('reclassify-kb-settings-kb');
      const regResult = await caller.register({ name: '显式模型库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      mkdirSync(join(kbDir, 'docs', '未分类'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '未分类', 'doc.md'), '# doc\n', 'utf-8');

      // KB 设置显式指定专用凭证（与默认凭证不同）
      await caller.updateSettings({
        convertEngine: 'anydoc',
        llm: { providerId: 'kb-dedicated-cred', model: 'kb-classifier-model' },
      });
      mockGetCredential.mockResolvedValue({
        providerId: 'kb-dedicated-cred',
        apiKey: 'sk-kb',
        baseUrl: 'http://kb-relay.example:3000',
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: '{"category": "验证方法", "title": "doc", "summary": "摘要", "keywords": ["a"]}',
            },
          }],
        }),
      } as unknown as Response);
      vi.stubGlobal('fetch', fetchMock);

      try {
        const result = await caller.reclassify({ name: 'doc' });
        expect(result.ok).toBe(true);

        // 请求打到显式凭证的 baseUrl 且使用显式模型（未拉取 /models）
        const chatCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/chat/completions'));
        expect(chatCall).toBeDefined();
        expect(String(chatCall?.[0])).toContain('kb-relay.example:3000');
        const body = JSON.parse(String((chatCall?.[1] as RequestInit | undefined)?.body)) as { model: string };
        expect(body.model).toBe('kb-classifier-model');
        expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/models'))).toBe(false);
      } finally {
        vi.unstubAllGlobals();
        mockGetCredential.mockReset();
      }
    });

    it('KB 设置指向的凭证已删除时回退自动推导链', async () => {
      const kbDir = makeEmptyKbDir('reclassify-stale-cred-kb');
      const regResult = await caller.register({ name: '失效凭证库', path: kbDir });
      await caller.mount({ kbId: regId(regResult) });

      mkdirSync(join(kbDir, 'docs', '未分类'), { recursive: true });
      writeFileSync(join(kbDir, 'docs', '未分类', 'doc.md'), '# doc\n', 'utf-8');

      // 显式配置指向已不存在的凭证
      await caller.updateSettings({
        convertEngine: 'anydoc',
        llm: { providerId: 'deleted-cred', model: 'whatever' },
      });
      mockGetCredential.mockResolvedValue(null);

      // 默认凭证兜底
      mockDefaultCredential.mockReturnValue({
        providerId: 'fallback-cred',
        apiKey: 'sk-fallback',
        baseUrl: 'http://fallback.example:3000',
        model: 'fallback-model',
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: '{"category": "验证方法", "title": "doc", "summary": "摘要", "keywords": ["a"]}',
            },
          }],
        }),
      } as unknown as Response);
      vi.stubGlobal('fetch', fetchMock);

      try {
        const result = await caller.reclassify({ name: 'doc' });
        expect(result.ok).toBe(true);

        const chatCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/chat/completions'));
        expect(String(chatCall?.[0])).toContain('fallback.example:3000');
        const body = JSON.parse(String((chatCall?.[1] as RequestInit | undefined)?.body)) as { model: string };
        expect(body.model).toBe('fallback-model');
      } finally {
        vi.unstubAllGlobals();
        mockGetCredential.mockReset();
        mockDefaultCredential.mockReturnValue(null);
      }
    });
  });
});
