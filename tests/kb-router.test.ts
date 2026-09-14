/**
 * kb-router 端到端测试（issue 01 — 新布局注册与恢复边界）。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * mock electron（app.getPath 返回临时目录 + BrowserWindow/dialog）和
 * project-service（requireProject 返回临时项目路径），registry 落盘到真实临时目录。
 *
 * 覆盖场景：
 *  - kb.register：空目录初始化 wiki 布局、wiki 目录读取库内 kbId（身份与路径分离）、
 *    同路径/同名拒绝、legacy 目录拦截 + 处置记录（文件保留）、foreign 拒绝、
 *    manifest 损坏拒绝、复制库冲突 kbIdConflict + asCopy 副本注册、路径校验
 *  - kb.disposals / kb.dismissDisposal：处置记录查询、去重、移除（不触碰目录）
 *  - kb.list：wiki 条目 + 统计、挂载标记、离线/已删除不误判（unreadable 保留）、
 *    旧格式登记条目惰性处置
 *  - kb.mount：成功挂载 + 事务恢复报告、prepared 现场 roll-forward、
 *    上限/未注册/重复挂载拒绝、旧格式登记挂载 → 处置拒绝
 *  - kb.unmount / kb.unregister / kb.deleteKb：基本流与拒绝
 *  - kb.status：wiki 挂载 + wikiHealth、未挂载、注销残留、目录被删 unreadable、
 *    旧格式挂载残留 → 处置 + mounted null
 *  - 旧分类入口守卫：wiki 挂载时 upload/documents/... 全部 PRECONDITION_FAILED；
 *    未挂载拒绝；输入校验
 *  - kb.pickFiles / kb.getSettings / kb.updateSettings
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
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

// Mock credential-manager：kb-router 依赖链（llm-config）加载需要，守卫测试不会触达
vi.mock('../src/main/credentials/credential-manager', () => ({
  credentialManager: {
    get: vi.fn().mockResolvedValue(null),
    getDefaultCredential: vi.fn().mockReturnValue(null),
  },
}));

// Mock deep-reindexer（router 顶层导入）
vi.mock('../src/main/kb/deep-reindexer', () => ({
  deepReindex: vi.fn(),
}));

// Mock @firecrawl/anydoc：pipeline 依赖链加载需要，守卫测试不会触达
vi.mock('@firecrawl/anydoc', () => ({
  toDocument: vi.fn(),
  toMarkdownBytes: vi.fn(),
  formatFromPath: vi.fn(),
  toMarkdown: vi.fn(),
  formatFromBytes: vi.fn(),
  formatFromExtension: vi.fn(),
}));

// Mock kb/vision 的 verifyVisionModel / retryVisionAsset / createDefaultVisionLlmFactory
// （issue 12/13 验证与单图重试接口测试不触真实网络；其余导出保留并默认透传）
vi.mock('../src/main/kb/vision', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/kb/vision')>();
  return {
    ...actual,
    verifyVisionModel: vi.fn(),
    retryVisionAsset: vi.fn(),
    createDefaultVisionLlmFactory: vi.fn(actual.createDefaultVisionLlmFactory),
  };
});

// ─── Imports (after mocks) ──────────────────────────────────

import { kbRouter } from '../src/main/ipc/routers/kb-router';
import { kbSettingsManager } from '../src/main/kb/kb-settings';
import { verifyVisionModel, retryVisionAsset, createDefaultVisionLlmFactory, type VisionLlm } from '../src/main/kb/vision';
import { credentialManager } from '../src/main/credentials/credential-manager';
import { initWikiLayout, readWikiManifest } from '../src/main/kb/wiki-layout';
import { prepareCommit } from '../src/main/kb/atomic-commit';
import type { WikiSourceSummary, WikiSourceRevisionInfo, WikiVisionInterpretation } from '@shared/kb-types';
import type {
  KbListEntry,
  KbStatus,
  KbDisposal,
  KbRecoveryReport,
  KbRegistration,
} from '../src/main/kb/types';

const caller = kbRouter.createCaller({});

// ─── Type-safe extraction helpers ───────────────────────────

type RegisterOutcome = {
  ok: boolean;
  id?: string;
  name?: string;
  path?: string;
  registeredAt?: number;
  format?: string;
  error?: { code: string; message: string };
};

/** 从 register 结果提取完整数据（断言 ok） */
function regData(r: RegisterOutcome): { id: string; name: string; path: string; registeredAt: number; format: string } {
  if (!r.ok || !r.id || !r.name || !r.path || !r.registeredAt) throw new Error('expected register success');
  return { id: r.id, name: r.name, path: r.path, registeredAt: r.registeredAt, format: r.format ?? '' };
}

/** 从 register 结果提取 id（断言 ok） */
function regId(r: RegisterOutcome): string {
  return regData(r).id;
}

/** 从 mount 结果提取 data + recovery（断言 ok） */
function mountOk(r: { ok: boolean; data?: { kbId: string; mountedAt: number }; recovery?: KbRecoveryReport | null }): {
  kbId: string;
  mountedAt: number;
  recovery: KbRecoveryReport | null;
} {
  if (!r.ok || !r.data) throw new Error('expected mount success');
  return { kbId: r.data.kbId, mountedAt: r.data.mountedAt, recovery: r.recovery ?? null };
}

/** 从失败结果提取 error（断言 !ok） */
function errOf(r: { ok: boolean; error?: { code: string; message: string } }): { code: string; message: string } {
  if (r.ok || !r.error) throw new Error('expected failure');
  return r.error;
}

// ─── Helpers ────────────────────────────────────────────────

/** 重置注册表 / 处置记录 / 挂载 / 设置（确保每个测试干净） */
async function resetState(): Promise<void> {
  const { writeFile, mkdir: mkdirP } = await import('node:fs/promises');
  const regDir = join(globalDataDir, 'socverify-data');
  await mkdirP(regDir, { recursive: true });
  await writeFile(join(regDir, 'kb-registry.json'), '[]', 'utf-8');
  await writeFile(join(regDir, 'kb-disposals.json'), '[]', 'utf-8');

  const mountDir = join(projectDir, '.socverify');
  await mkdirP(mountDir, { recursive: true });
  await writeFile(join(mountDir, 'kb-mounts.json'), '[]', 'utf-8');

  kbSettingsManager.resetCache();
  rmSync(join(regDir, 'kb-settings.json'), { force: true });
}

/** 创建空目录 */
function makeEmptyDir(name: string): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 创建已初始化的 wiki 布局库目录（指定库内持久身份） */
async function makeWikiKbDir(name: string, identity: { kbId: string; name: string }): Promise<string> {
  const dir = makeEmptyDir(name);
  await initWikiLayout(dir, identity);
  return dir;
}

/** 创建旧格式目录（sources/ + docs/，legacy 判定条件） */
function makeLegacyKbDir(name: string): string {
  const dir = join(tmpDir, name);
  mkdirSync(join(dir, 'sources'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'sources', 'old.docx'), 'fake-source', 'utf-8');
  writeFileSync(join(dir, 'docs', 'old.md'), '# 旧文档\n', 'utf-8');
  return dir;
}

/** 直接向注册表注入一条登记条目（模拟旧版本遗留数据） */
async function injectRegistryEntry(entry: KbRegistration): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  const regPath = join(globalDataDir, 'socverify-data', 'kb-registry.json');
  const current = JSON.parse(readFileSync(regPath, 'utf-8')) as KbRegistration[];
  current.push(entry);
  await writeFile(regPath, JSON.stringify(current, null, 2), 'utf-8');
}

// ─── Test Suite ─────────────────────────────────────────────

describe('kb-router', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── kb.register ──────────────────────────────────────────

  describe('kb.register', () => {
    it('空目录注册初始化 wiki 布局 + manifest 身份', async () => {
      const kbDir = makeEmptyDir('empty-kb');
      const result = await caller.register({ name: '空库', path: kbDir });

      expect(result.ok).toBe(true);
      const data = regData(result);
      expect(data.name).toBe('空库');
      expect(data.path).toBe(kbDir);
      expect(data.format).toBe('wiki');

      // wiki 布局结构
      expect(existsSync(join(kbDir, 'schema.md'))).toBe(true);
      expect(existsSync(join(kbDir, 'purpose.md'))).toBe(true);
      expect(existsSync(join(kbDir, 'raw', 'sources'))).toBe(true);
      expect(existsSync(join(kbDir, 'wiki'))).toBe(true);
      expect(existsSync(join(kbDir, '.kb', 'manifest.json'))).toBe(true);

      // manifest 身份与注册结果一致
      const manifest = JSON.parse(readFileSync(join(kbDir, '.kb', 'manifest.json'), 'utf-8')) as { kbId: string; name: string; format: string };
      expect(manifest.kbId).toBe(data.id);
      expect(manifest.name).toBe('空库');
      expect(manifest.format).toBe('wiki');
    });

    it('注册已有 wiki 目录读取库内持久 kbId（身份与路径分离）', async () => {
      const kbDir = await makeWikiKbDir('pre-wiki-kb', { kbId: 'my-kb-0001', name: '手工库' });

      const result = await caller.register({ name: '重注册库', path: kbDir });
      expect(result.ok).toBe(true);
      expect(regId(result)).toBe('my-kb-0001');
    });

    it('库目录移动后注销重注册仍是同一身份（kbId 持久于库内）', async () => {
      const dirA = await makeWikiKbDir('move-src-kb', { kbId: 'move-kb-0001', name: '移动库' });
      const reg1 = await caller.register({ name: '移动库', path: dirA });
      expect(regId(reg1)).toBe('move-kb-0001');

      // 注销 → 目录移动 → 重新注册
      await caller.unregister({ kbId: 'move-kb-0001' });
      const dirB = join(tmpDir, 'move-dst-kb');
      cpSync(dirA, dirB, { recursive: true });
      rmSync(dirA, { recursive: true, force: true });

      const reg2 = await caller.register({ name: '移动库', path: dirB });
      expect(reg2.ok).toBe(true);
      expect(regId(reg2)).toBe('move-kb-0001');
    });

    it('同一路径重复注册被拒绝', async () => {
      const kbDir = makeEmptyDir('dup-path-kb');
      await caller.register({ name: '库A', path: kbDir });

      const result = await caller.register({ name: '库B', path: kbDir });
      const err = errOf(result);
      expect(err.code).toBe('alreadyRegistered');
      expect(err.message).toContain('库A');
    });

    it('同名注册被拒绝', async () => {
      const kbDir1 = makeEmptyDir('dup-name-1');
      const kbDir2 = makeEmptyDir('dup-name-2');
      await caller.register({ name: '同名库', path: kbDir1 });

      const result = await caller.register({ name: '同名库', path: kbDir2 });
      expect(errOf(result).code).toBe('alreadyRegistered');
    });

    it('旧格式目录（sources/ + docs/）被拦截：不登记、写处置记录、文件保留', async () => {
      const kbDir = makeLegacyKbDir('legacy-kb');
      const result = await caller.register({ name: '旧库', path: kbDir });

      const err = errOf(result);
      expect(err.code).toBe('legacyFormat');
      expect(err.message).toContain('旧格式');

      // 文件未被删除
      expect(existsSync(join(kbDir, 'sources', 'old.docx'))).toBe(true);
      expect(existsSync(join(kbDir, 'docs', 'old.md'))).toBe(true);

      // 处置记录已保留
      const disposals: KbDisposal[] = await caller.disposals({});
      expect(disposals).toHaveLength(1);
      expect(disposals[0].path).toBe(kbDir);
      expect(disposals[0].reason).toBe('legacyFormat');
      expect(disposals[0].kbId).toBeNull();

      // 活动表为空
      const list: KbListEntry[] = await caller.list({});
      expect(list).toHaveLength(0);
    });

    it('重复拦截同一旧格式目录时处置记录去重', async () => {
      const kbDir = makeLegacyKbDir('legacy-dup-kb');
      await caller.register({ name: '旧库一', path: kbDir });
      await caller.register({ name: '旧库二', path: kbDir });

      const disposals: KbDisposal[] = await caller.disposals({});
      expect(disposals).toHaveLength(1);
    });

    it('foreign 目录（未知文件且无库结构标记）被拒绝', async () => {
      const kbDir = makeEmptyDir('foreign-kb');
      writeFileSync(join(kbDir, 'random.txt'), 'not a kb', 'utf-8');

      const result = await caller.register({ name: '外来库', path: kbDir });
      expect(errOf(result).code).toBe('structureIncompatible');
    });

    it('manifest 损坏的 wiki 目录被拒绝（manifestCorrupted）', async () => {
      const kbDir = makeEmptyDir('corrupt-kb');
      mkdirSync(join(kbDir, '.kb'), { recursive: true });
      writeFileSync(join(kbDir, '.kb', 'manifest.json'), '{ broken json', 'utf-8');

      const result = await caller.register({ name: '损坏库', path: kbDir });
      expect(errOf(result).code).toBe('manifestCorrupted');
    });

    it('复制库冲突：同 kbId 不同路径拒绝，asCopy 注册为副本并写回新身份', async () => {
      const dirA = await makeWikiKbDir('copy-src-kb', { kbId: 'copy-kb-0001', name: '正本库' });
      await caller.register({ name: '正本库', path: dirA });

      // 整目录复制 → 与正本同 kbId
      const dirB = join(tmpDir, 'copy-dup-kb');
      cpSync(dirA, dirB, { recursive: true });

      // 不带 asCopy：冲突拒绝
      const conflict = await caller.register({ name: '副本库', path: dirB });
      const err = errOf(conflict);
      expect(err.code).toBe('kbIdConflict');
      expect(err.message).toContain('副本');

      // asCopy：赋新 kbId + 写回 manifest
      const copy = await caller.register({ name: '副本库', path: dirB, asCopy: true });
      expect(copy.ok).toBe(true);
      const copyData = regData(copy);
      expect(copyData.id).not.toBe('copy-kb-0001');

      const manifest = JSON.parse(readFileSync(join(dirB, '.kb', 'manifest.json'), 'utf-8')) as { kbId: string; name: string };
      expect(manifest.kbId).toBe(copyData.id);
      expect(manifest.name).toBe('副本库');

      // 正本 manifest 不受影响
      const originManifest = JSON.parse(readFileSync(join(dirA, '.kb', 'manifest.json'), 'utf-8')) as { kbId: string };
      expect(originManifest.kbId).toBe('copy-kb-0001');
    });

    it('路径不存在被拒绝（pathNotFound）', async () => {
      const result = await caller.register({ name: '不存在的库', path: join(tmpDir, 'nonexistent-path') });
      expect(errOf(result).code).toBe('pathNotFound');
    });

    it('路径是文件不是目录被拒绝（pathNotDirectory）', async () => {
      const filePath = join(tmpDir, 'a-file.txt');
      writeFileSync(filePath, 'hello', 'utf-8');
      const result = await caller.register({ name: '文件库', path: filePath });
      expect(errOf(result).code).toBe('pathNotDirectory');
    });

    it('缺少 name / path 参数抛出 BAD_REQUEST', async () => {
      await expect(
        caller.register({ path: join(tmpDir, 'x') } as { name: string; path: string }),
      ).rejects.toThrow();
      await expect(
        caller.register({ name: '无路径库' } as { name: string; path: string }),
      ).rejects.toThrow();
    });
  });

  // ─── kb.disposals / kb.dismissDisposal ────────────────────

  describe('kb.disposals / kb.dismissDisposal', () => {
    it('dismissDisposal 移除记录且不触碰库目录', async () => {
      const kbDir = makeLegacyKbDir('dismiss-kb');
      await caller.register({ name: '待移除旧库', path: kbDir });

      const before: KbDisposal[] = await caller.disposals({});
      expect(before).toHaveLength(1);

      const result = await caller.dismissDisposal({ disposalId: before[0].id });
      expect(result.ok).toBe(true);

      const after: KbDisposal[] = await caller.disposals({});
      expect(after).toHaveLength(0);

      // 库目录未被触碰
      expect(existsSync(join(kbDir, 'sources', 'old.docx'))).toBe(true);
    });

    it('dismiss 不存在的处置记录被拒绝', async () => {
      const result = await caller.dismissDisposal({ disposalId: 'no-such-id' });
      expect(result.ok).toBe(false);
      expect(errOf(result).code).toBe('notRegistered');
    });

    it('缺少 disposalId 抛出 BAD_REQUEST', async () => {
      await expect(caller.dismissDisposal({} as { disposalId: string })).rejects.toThrow();
    });

    it('空注册表时 disposals 返回空数组', async () => {
      const disposals: KbDisposal[] = await caller.disposals({});
      expect(disposals).toEqual([]);
    });
  });

  // ─── kb.list ──────────────────────────────────────────────

  describe('kb.list', () => {
    it('返回 wiki 条目 + 挂载标记（统计恒为 0，由后继票接入）', async () => {
      const kbDir = makeEmptyDir('list-kb');
      const id = regId(await caller.register({ name: '列表库', path: kbDir }));

      const list: KbListEntry[] = await caller.list({});
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(id);
      expect(list[0].format).toBe('wiki');
      expect(list[0].state).toBe('ok');
      expect(list[0].documentCount).toBe(0);
      expect(list[0].categoryCount).toBe(0);
      expect(list[0].isMounted).toBe(false);
    });

    it('挂载后 isMounted 为 true', async () => {
      const kbDir = makeEmptyDir('list-mounted-kb');
      const id = regId(await caller.register({ name: '挂载标记库', path: kbDir }));
      await caller.mount({ kbId: id });

      const list: KbListEntry[] = await caller.list({});
      expect(list[0].isMounted).toBe(true);
    });

    it('目录被删除（离线/已删除）→ unreadable 保留登记，不误判处置', async () => {
      const kbDir = makeEmptyDir('gone-kb');
      regId(await caller.register({ name: '消失库', path: kbDir }));
      rmSync(kbDir, { recursive: true, force: true });

      const list: KbListEntry[] = await caller.list({});
      expect(list).toHaveLength(1);
      expect(list[0].state).toBe('unreadable');
      expect(list[0].stateReason).toBe('ENOENT');

      // 不产生处置记录
      const disposals: KbDisposal[] = await caller.disposals({});
      expect(disposals).toHaveLength(0);
    });

    it('旧格式登记条目（旧版本遗留）被惰性处置', async () => {
      const kbDir = makeLegacyKbDir('stale-legacy-kb');
      await injectRegistryEntry({
        id: 'legacy-stale-1',
        name: '遗留旧库',
        path: kbDir,
        registeredAt: Date.now(),
        format: 'legacy',
      });

      const list: KbListEntry[] = await caller.list({});
      expect(list).toHaveLength(0);

      const disposals: KbDisposal[] = await caller.disposals({});
      expect(disposals).toHaveLength(1);
      expect(disposals[0].id).toBe('legacy-stale-1');
      expect(disposals[0].kbId).toBe('legacy-stale-1');
    });

    it('空注册表返回空数组', async () => {
      const list: KbListEntry[] = await caller.list({});
      expect(list).toEqual([]);
    });
  });

  // ─── kb.mount ─────────────────────────────────────────────

  describe('kb.mount', () => {
    it('成功挂载 wiki 库并返回空恢复报告', async () => {
      const kbDir = makeEmptyDir('mount-kb');
      const id = regId(await caller.register({ name: '可挂载库', path: kbDir }));

      const result = await caller.mount({ kbId: id });
      expect(result.ok).toBe(true);
      const data = mountOk(result);
      expect(data.kbId).toBe(id);
      expect(data.recovery).not.toBeNull();
      expect(data.recovery!.cleaned).toBe(0);
      expect(data.recovery!.rolledForward).toBe(0);
      expect(data.recovery!.rolledBack).toBe(0);
      expect(data.recovery!.failures).toHaveLength(0);
    });

    it('挂载执行事务恢复：prepared 现场 roll-forward 到完整新版', async () => {
      const kbDir = makeEmptyDir('mount-recover-kb');
      const id = regId(await caller.register({ name: '恢复库', path: kbDir }));

      // 模拟崩溃残留：prepared 事务（镜像完整、rename 未发生）
      const prepared = await prepareCommit(kbDir, {
        txId: 'tx-recover-1',
        writes: [{ relPath: 'wiki/recovered.md', content: 'NEW' }],
      });
      expect(prepared.ok).toBe(true);

      const result = await caller.mount({ kbId: id });
      expect(result.ok).toBe(true);
      const data = mountOk(result);
      expect(data.recovery!.rolledForward).toBe(1);

      // 新版内容已应用，事务目录已清理
      expect(readFileSync(join(kbDir, 'wiki', 'recovered.md'), 'utf-8')).toBe('NEW');
      expect(existsSync(join(kbDir, '.kb', 'transactions', 'tx-recover-1'))).toBe(false);
    });

    it('挂载关系持久化到项目配置', async () => {
      const kbDir = makeEmptyDir('mount-persist-kb');
      const id = regId(await caller.register({ name: '持久挂载库', path: kbDir }));
      await caller.mount({ kbId: id });

      const mountPath = join(projectDir, '.socverify', 'kb-mounts.json');
      expect(existsSync(mountPath)).toBe(true);
      const mounts = JSON.parse(readFileSync(mountPath, 'utf-8')) as Array<{ kbId: string }>;
      expect(mounts).toHaveLength(1);
      expect(mounts[0].kbId).toBe(id);
    });

    it('v1 挂载第二个库被拒绝（mountLimitExceeded）', async () => {
      const kbDir1 = makeEmptyDir('mount-first-kb');
      const kbDir2 = makeEmptyDir('mount-second-kb');
      const id1 = regId(await caller.register({ name: '第一库', path: kbDir1 }));
      const id2 = regId(await caller.register({ name: '第二库', path: kbDir2 }));

      await caller.mount({ kbId: id1 });
      const result = await caller.mount({ kbId: id2 });
      expect(errOf(result).code).toBe('mountLimitExceeded');
    });

    it('挂载未注册的库被拒绝（notRegistered）', async () => {
      const result = await caller.mount({ kbId: 'nonexistent-id' });
      expect(errOf(result).code).toBe('notRegistered');
    });

    it('重复挂载同一库被拒绝（alreadyMounted）', async () => {
      const kbDir = makeEmptyDir('mount-remount-kb');
      const id = regId(await caller.register({ name: '重复挂载库', path: kbDir }));
      await caller.mount({ kbId: id });

      const result = await caller.mount({ kbId: id });
      expect(errOf(result).code).toBe('alreadyMounted');
    });

    it('挂载旧格式登记条目 → 处置并拒绝（legacyFormat）', async () => {
      const kbDir = makeLegacyKbDir('mount-legacy-kb');
      await injectRegistryEntry({
        id: 'legacy-mount-1',
        name: '旧格式挂载库',
        path: kbDir,
        registeredAt: Date.now(),
        format: 'legacy',
      });

      const result = await caller.mount({ kbId: 'legacy-mount-1' });
      expect(errOf(result).code).toBe('legacyFormat');

      // 挂载记录未写入；条目已处置
      const mounts = JSON.parse(readFileSync(join(projectDir, '.socverify', 'kb-mounts.json'), 'utf-8')) as unknown[];
      expect(mounts).toHaveLength(0);
      const disposals: KbDisposal[] = await caller.disposals({});
      expect(disposals).toHaveLength(1);
      expect(disposals[0].kbId).toBe('legacy-mount-1');
    });

    it('缺少 kbId 抛出 BAD_REQUEST', async () => {
      await expect(caller.mount({} as { kbId: string })).rejects.toThrow();
    });
  });

  // ─── kb.unmount / kb.unregister / kb.deleteKb ─────────────

  describe('kb.unmount', () => {
    it('成功卸载并清空项目挂载配置', async () => {
      const kbDir = makeEmptyDir('unmount-kb');
      const id = regId(await caller.register({ name: '可卸载库', path: kbDir }));
      await caller.mount({ kbId: id });

      const result = await caller.unmount({ kbId: id });
      expect(result.ok).toBe(true);

      const mounts = JSON.parse(readFileSync(join(projectDir, '.socverify', 'kb-mounts.json'), 'utf-8')) as unknown[];
      expect(mounts).toHaveLength(0);
    });

    it('卸载未挂载的库被拒绝（notMounted）', async () => {
      const result = await caller.unmount({ kbId: 'nonexistent-id' });
      expect(errOf(result).code).toBe('notMounted');
    });

    it('缺少 kbId 抛出 BAD_REQUEST', async () => {
      await expect(caller.unmount({} as { kbId: string })).rejects.toThrow();
    });
  });

  describe('kb.unregister', () => {
    it('成功注销（文件保留）', async () => {
      const kbDir = makeEmptyDir('unreg-kb');
      const id = regId(await caller.register({ name: '可注销库', path: kbDir }));

      const result = await caller.unregister({ kbId: id });
      expect(result.ok).toBe(true);

      const list: KbListEntry[] = await caller.list({});
      expect(list).toHaveLength(0);
      // 库目录未被删除
      expect(existsSync(join(kbDir, '.kb', 'manifest.json'))).toBe(true);
    });

    it('注销未注册的库被拒绝（notRegistered）', async () => {
      const result = await caller.unregister({ kbId: 'nonexistent-id' });
      expect(errOf(result).code).toBe('notRegistered');
    });

    it('已挂载的库不可注销（先卸载提示）', async () => {
      const kbDir = makeEmptyDir('unreg-mounted-kb');
      const id = regId(await caller.register({ name: '已挂载注销库', path: kbDir }));
      await caller.mount({ kbId: id });

      const result = await caller.unregister({ kbId: id });
      const err = errOf(result);
      expect(err.code).toBe('alreadyMounted');
      expect(err.message).toContain('卸载');
    });

    it('缺少 kbId 抛出 BAD_REQUEST', async () => {
      await expect(caller.unregister({} as { kbId: string })).rejects.toThrow();
    });
  });

  describe('kb.deleteKb', () => {
    it('删除库尚未支持，明确返回 deleteNotSupported', async () => {
      const kbDir = makeEmptyDir('del-kb');
      const id = regId(await caller.register({ name: '待删库', path: kbDir }));

      const result = await caller.deleteKb({ kbId: id });
      const err = errOf(result);
      expect(err.code).toBe('deleteNotSupported');
      expect(err.message).toContain('注销');

      // 登记未被破坏
      const list: KbListEntry[] = await caller.list({});
      expect(list).toHaveLength(1);
    });
  });

  // ─── kb.status ────────────────────────────────────────────

  describe('kb.status', () => {
    it('wiki 挂载 → mounted + wikiHealth（legacy health 全 false）', async () => {
      const kbDir = makeEmptyDir('status-kb');
      const id = regId(await caller.register({ name: '状态库', path: kbDir }));
      await caller.mount({ kbId: id });

      const result: KbStatus = await caller.status({});
      expect(result.mounted).not.toBeNull();
      expect(result.mounted!.kbId).toBe(id);
      expect(result.mounted!.name).toBe('状态库');
      expect(result.mounted!.path).toBe(kbDir);
      expect(result.mounted!.format).toBe('wiki');
      expect(result.mounted!.state).toBe('ok');

      expect(result.wikiHealth).not.toBeNull();
      expect(result.wikiHealth!.hasManifest).toBe(true);
      expect(result.wikiHealth!.hasSchema).toBe(true);
      expect(result.wikiHealth!.hasPurpose).toBe(true);
      expect(result.wikiHealth!.hasRaw).toBe(true);
      expect(result.wikiHealth!.hasWiki).toBe(true);

      // legacy 健康字段对新布局无意义，全 false
      expect(result.health.hasSources).toBe(false);
      expect(result.health.hasDocs).toBe(false);
      expect(result.health.hasIndex).toBe(false);
    });

    it('未挂载时 mounted 为 null 且 wikiHealth 为 null', async () => {
      const result: KbStatus = await caller.status({});
      expect(result.mounted).toBeNull();
      expect(result.wikiHealth).toBeNull();
      expect(result.health.hasSources).toBe(false);
    });

    it('挂载库被注销后挂载残留 → mounted 为 null', async () => {
      const kbDir = makeEmptyDir('status-gone-kb');
      const id = regId(await caller.register({ name: '已消失库', path: kbDir }));
      await caller.mount({ kbId: id });
      await caller.unmount({ kbId: id });
      await caller.unregister({ kbId: id });

      // 手动恢复挂载记录（模拟跨项目残留）
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        join(projectDir, '.socverify', 'kb-mounts.json'),
        JSON.stringify([{ kbId: id, mountedAt: Date.now() }]),
        'utf-8',
      );

      const result: KbStatus = await caller.status({});
      expect(result.mounted).toBeNull();
    });

    it('挂载库目录被删除 → mounted 保留并标记 unreadable（不误判处置）', async () => {
      const kbDir = makeEmptyDir('status-deleted-kb');
      const id = regId(await caller.register({ name: '被删库', path: kbDir }));
      await caller.mount({ kbId: id });
      rmSync(kbDir, { recursive: true, force: true });

      const result: KbStatus = await caller.status({});
      expect(result.mounted).not.toBeNull();
      expect(result.mounted!.state).toBe('unreadable');
      expect(result.wikiHealth).toBeNull();

      const disposals: KbDisposal[] = await caller.disposals({});
      expect(disposals).toHaveLength(0);
    });

    it('挂载残留指向旧格式登记 → 处置并清理挂载（mounted null）', async () => {
      const kbDir = makeLegacyKbDir('status-legacy-kb');
      await injectRegistryEntry({
        id: 'legacy-status-1',
        name: '旧格式状态库',
        path: kbDir,
        registeredAt: Date.now(),
        format: 'legacy',
      });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        join(projectDir, '.socverify', 'kb-mounts.json'),
        JSON.stringify([{ kbId: 'legacy-status-1', mountedAt: Date.now() }]),
        'utf-8',
      );

      const result: KbStatus = await caller.status({});
      expect(result.mounted).toBeNull();

      // 处置 + 本项目挂载清理
      const disposals: KbDisposal[] = await caller.disposals({});
      expect(disposals).toHaveLength(1);
      const mounts = JSON.parse(readFileSync(join(projectDir, '.socverify', 'kb-mounts.json'), 'utf-8')) as unknown[];
      expect(mounts).toHaveLength(0);
    });
  });

  // ─── 持久化验证 ───────────────────────────────────────────

  describe('持久化', () => {
    it('注册 + 挂载关系持久化，重新读取保持', async () => {
      const kbDir = makeEmptyDir('persist-kb');
      const id = regId(await caller.register({ name: '持久库', path: kbDir }));
      await caller.mount({ kbId: id });

      // 模拟「重开应用」：重新读取注册表和挂载配置
      const list: KbListEntry[] = await caller.list({});
      expect(list[0].isMounted).toBe(true);

      const statusResult: KbStatus = await caller.status({});
      expect(statusResult.mounted).not.toBeNull();
      expect(statusResult.mounted!.kbId).toBe(id);
    });

    it('注册表 kbId 与库内 manifest 一致（跨重启身份稳定）', async () => {
      const kbDir = makeEmptyDir('identity-kb');
      const id = regId(await caller.register({ name: '身份库', path: kbDir }));

      const read = await readWikiManifest(kbDir);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.manifest.kbId).toBe(id);
    });
  });

  // ─── 旧分类入口守卫（wiki 挂载） ──────────────────────────

  describe('旧分类入口守卫', () => {
    let wikiKbId: string;

    beforeEach(async () => {
      const kbDir = makeEmptyDir('guard-kb');
      wikiKbId = regId(await caller.register({ name: '守卫库', path: kbDir }));
      await caller.mount({ kbId: wikiKbId });
    });

    it('wiki 挂载时 upload 被明确拒绝（PRECONDITION_FAILED）', async () => {
      await expect(
        caller.upload({ filePaths: [join(tmpDir, 'whatever.docx')] }),
      ).rejects.toThrow('新布局');
    });

    it('wiki 挂载时 documents / categories 查询被拒绝', async () => {
      await expect(caller.documents({})).rejects.toThrow('新布局');
      await expect(caller.categories({})).rejects.toThrow('新布局');
    });

    it('wiki 挂载时 index 读写被拒绝', async () => {
      await expect(caller.index({})).rejects.toThrow('新布局');
      await expect(caller.index({ content: '# x' })).rejects.toThrow('新布局');
    });

    it('wiki 挂载时 preview / delete / retry 被拒绝', async () => {
      await expect(caller.preview({ name: 'x' })).rejects.toThrow('新布局');
      await expect(caller.delete({ name: 'x' })).rejects.toThrow('新布局');
      await expect(caller.retry({ name: 'x' })).rejects.toThrow('新布局');
    });

    it('wiki 挂载时 moveCategory / renameCategory / reclassify / deepReindex 被拒绝', async () => {
      await expect(caller.moveCategory({ name: 'x', category: 'y' })).rejects.toThrow('新布局');
      await expect(caller.renameCategory({ oldName: 'a', newName: 'b' })).rejects.toThrow('新布局');
      await expect(caller.reclassify({ name: 'x' })).rejects.toThrow('新布局');
      await expect(caller.deepReindex({})).rejects.toThrow('新布局');
    });

    it('守卫错误码为 notAvailableForWikiLayout 语义（消息明确指向停用入口）', async () => {
      await expect(caller.documents({})).rejects.toThrow('旧分类');
    });

    it('未挂载时旧入口同样拒绝（未挂载提示）', async () => {
      await caller.unmount({ kbId: wikiKbId });
      await expect(caller.documents({})).rejects.toThrow('未挂载');
      await expect(caller.upload({ filePaths: [join(tmpDir, 'x.docx')] })).rejects.toThrow('未挂载');
    });

    it('输入校验先于守卫：upload 缺 filePaths 抛 BAD_REQUEST', async () => {
      await expect(caller.upload({} as { filePaths: string[] })).rejects.toThrow();
      await expect(caller.upload({ filePaths: [] })).rejects.toThrow();
    });
  });

  // ─── kb.pickFiles ─────────────────────────────────────────

  describe('kb.pickFiles', () => {
    it('对话框取消时返回 canceled', async () => {
      const result = await caller.pickFiles({});
      expect(result.canceled).toBe(true);
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

  // ─── kb vision 角色与图片能力验证（issue 12） ────────────────

  describe('kb vision 角色（issue 12）', () => {
    it('updateSettings 保存 vision 角色 → getSettings 回读（独立于 llm 角色）', async () => {
      const result = await caller.updateSettings({
        convertEngine: 'anydoc',
        llm: { providerId: 'relay-cred', model: 'glm-4.7' },
        vision: { providerId: 'zhipu-cred', model: 'glm-4.6v' },
      });
      expect(result.settings.vision).toEqual({ providerId: 'zhipu-cred', model: 'glm-4.6v' });

      kbSettingsManager.resetCache();
      const reread = await caller.getSettings({});
      expect(reread.settings.llm.providerId).toBe('relay-cred');
      expect(reread.settings.vision?.providerId).toBe('zhipu-cred');
    });

    it('updateSettings 不传 vision → 清除显式视觉配置（全量覆写语义）', async () => {
      await caller.updateSettings({
        convertEngine: 'anydoc',
        llm: {},
        vision: { providerId: 'zhipu-cred' },
      });
      const result = await caller.updateSettings({ convertEngine: 'anydoc', llm: {} });
      expect(result.settings.vision).toBeUndefined();
    });

    it('vision 字段类型错误抛出 BAD_REQUEST', async () => {
      await expect(
        caller.updateSettings({
          convertEngine: 'anydoc',
          llm: {},
          vision: { providerId: 42 },
        } as unknown as { convertEngine: string; llm: { providerId?: string; model?: string } }),
      ).rejects.toThrow();
    });

    it('verifyVisionModel 未配置 → notConfigured（不触网络）', async () => {
      const result = await caller.verifyVisionModel({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('notConfigured');
      }
    });

    it('verifyVisionModel 已配置 → 转发 vision 模块真实验证结果', async () => {
      // vision 配置指向存在且可用的凭证
      await caller.updateSettings({
        convertEngine: 'anydoc',
        llm: {},
        vision: { providerId: 'zhipu-cred', model: 'glm-4.6v' },
      });
      vi.mocked(credentialManager.get).mockResolvedValue({
        providerId: 'zhipu-cred',
        apiKey: 'sk-test',
        baseUrl: 'https://gw.test/v1',
        api: 'chat completions',
      } as never);

      vi.mocked(verifyVisionModel).mockResolvedValue({
        ok: true,
        model: 'glm-4.6v',
        sample: 'OK',
      });
      const ok = await caller.verifyVisionModel({});
      expect(ok).toEqual({ ok: true, model: 'glm-4.6v', sample: 'OK' });
      expect(verifyVisionModel).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://gw.test/v1', model: 'glm-4.6v', apiKey: 'sk-test' }),
      );

      // 图片被拒（400）→ 可操作类别透传
      vi.mocked(verifyVisionModel).mockResolvedValue({
        ok: false,
        error: { kind: 'imageRejected', message: '端点拒绝图片输入' },
      });
      const rejected = await caller.verifyVisionModel({});
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.kind).toBe('imageRejected');
      }

      vi.mocked(credentialManager.get).mockResolvedValue(null);
    });
  });

  // ─── kb.retryVisionAsset（issue 13） ─────────────────────────
  //
  // 失败单图独立重试：解析 vision 角色配置 → 定位当前修订资产清单中的
  // 单张 → 只重做该图。未配置 vision → visionNotConfigured（不触模型）；
  // 资产不在清单 → assetNotInManifest（不伪造记录）。

  describe('kb.retryVisionAsset（issue 13）', () => {
    afterEach(() => {
      vi.mocked(retryVisionAsset).mockReset();
      vi.mocked(createDefaultVisionLlmFactory).mockReset();
    });

    async function mountWiki(): Promise<string> {
      const kbDir = makeEmptyDir(`vision-retry-kb-${Math.random().toString(36).slice(2, 6)}`);
      const id = regId(await caller.register({ name: '视觉重试库', path: kbDir }));
      const mounted = await caller.mount({ kbId: id });
      if (!mounted.ok) throw new Error('mount failed');
      return kbDir;
    }

    it('未配置视觉模型 → visionNotConfigured（不触模型）', async () => {
      await mountWiki();
      const r = await caller.retryVisionAsset({ sourceId: 's'.repeat(64), assetId: 'a'.repeat(64) });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('visionNotConfigured');
      expect(retryVisionAsset).not.toHaveBeenCalled();
    });

    it('已配置 → 转发 vision 模块单图重试结果（携带 kbPath/sourceId/revision/llm）', async () => {
      const kbDir = await mountWiki();
      const fakeLlm = { model: 'vision-model', invoke: async () => 'ok' } as unknown as VisionLlm;
      vi.mocked(createDefaultVisionLlmFactory).mockImplementation(
        () => async () => fakeLlm,
      );
      const record = { assetId: 'a'.repeat(64), status: 'ok', imageType: '框图' } as WikiVisionInterpretation;
      vi.mocked(retryVisionAsset).mockResolvedValue(record);

      const r = await caller.retryVisionAsset({
        sourceId: 's'.repeat(64),
        assetId: 'a'.repeat(64),
        revision: 'r'.repeat(64),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.interpretation).toEqual(record);
      expect(retryVisionAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          kbPath: kbDir,
          sourceId: 's'.repeat(64),
          sourceRevision: 'r'.repeat(64),
          assetId: 'a'.repeat(64),
          llm: fakeLlm,
        }),
      );
    });

    it('资产不在当前修订清单 → assetNotInManifest（不伪造记录）', async () => {
      await mountWiki();
      const fakeLlm = { model: 'vision-model', invoke: async () => 'ok' } as unknown as VisionLlm;
      vi.mocked(createDefaultVisionLlmFactory).mockImplementation(
        () => async () => fakeLlm,
      );
      vi.mocked(retryVisionAsset).mockResolvedValue(null);

      const r = await caller.retryVisionAsset({ sourceId: 's'.repeat(64), assetId: 'a'.repeat(64) });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('assetNotInManifest');
    });

    it('缺 assetId 抛出 BAD_REQUEST', async () => {
      await expect(
        caller.retryVisionAsset({ sourceId: 's'.repeat(64) } as { sourceId: string; assetId: string }),
      ).rejects.toThrow();
    });
  });

  // ─── kb wiki 来源（issue 02） ───────────────────────────────
  //
  // router→主进程→列表/预览行为，全部用真文件 fixture 走通。

  describe('kb wiki 来源（issue 02）', () => {
    let kbDir: string;
    let kbId: string;
    let seq = 0;

    beforeEach(async () => {
      // 每个测试独立库目录（mkdirSync 不清空，必须用唯一名）
      kbDir = makeEmptyDir(`wiki-src-kb-${++seq}`);
      kbId = regId(await caller.register({ name: '来源库', path: kbDir }));
      await caller.mount({ kbId });
    });

    it('未挂载时 sources / importSources 拒绝（未挂载提示）', async () => {
      await caller.unmount({ kbId });
      await expect(caller.sources({})).rejects.toThrow('未挂载');
      await expect(
        caller.importSources({ items: [{ absolutePath: join(tmpDir, 'x.md') }] }),
      ).rejects.toThrow('未挂载');
    });

    it('importSources 单文档导入 → sources 列表 / sourceParsed 预览 / sourceOriginal 解析', async () => {
      const src = join(tmpDir, 'wiki-src-notes.md');
      writeFileSync(src, '# 路由导入笔记\n', 'utf-8');

      const { results } = await caller.importSources({ items: [{ absolutePath: src }] });
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(true);

      const list: WikiSourceSummary[] = await caller.sources({});
      expect(list).toHaveLength(1);
      // relPath 缺省 = basename
      expect(list[0].sourcePath).toBe('wiki-src-notes.md');
      expect(list[0].status).toBe('ready');
      expect(list[0].parsedStale).toBe(false);
      expect(list[0].revisionShort).toHaveLength(8);

      const sid = list[0].sourceId;
      const view = await caller.sourceParsed({ sourceId: sid });
      expect(view.isHistorical).toBe(false);
      expect(view.content).toContain('路由导入笔记');
      expect(view.parsedHash).toBe(list[0].parsedHash);

      const original = await caller.sourceOriginal({ sourceId: sid });
      expect(original.path).not.toBeNull();
      expect(readFileSync(original.path!, 'utf-8')).toContain('路由导入笔记');
    });

    it('importSources 批量：逐文件独立结果，部分失败不影响其余', async () => {
      const okFile = join(tmpDir, 'wiki-batch-a.md');
      const badFile = join(tmpDir, 'wiki-batch-b.html');
      writeFileSync(okFile, 'A', 'utf-8');
      writeFileSync(badFile, '<html>', 'utf-8');

      const { results } = await caller.importSources({
        items: [
          { absolutePath: okFile, relPath: 'docs/a.md' },
          { absolutePath: badFile, relPath: 'b.html' },
        ],
      });
      expect(results).toHaveLength(2);
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(false);
      if (!results[1].ok) expect(results[1].error.code).toBe('unsupportedFormat');

      const list: WikiSourceSummary[] = await caller.sources({});
      expect(list.map((s) => s.sourcePath)).toEqual(['docs/a.md']);
      expect(existsSync(join(kbDir, 'raw', 'sources', 'docs', 'a.md'))).toBe(true);
    });

    it('来源更新：sourceRevisions 核对 + sourceParsed 历史修订（被引用旧修订保留）', async () => {
      const v1 = join(tmpDir, 'wiki-rev-v1.md');
      writeFileSync(v1, 'bytes-v1', 'utf-8');
      const first = (await caller.importSources({ items: [{ absolutePath: v1 }] })).results[0]!;
      if (!first.ok) throw new Error('expected import success');
      const sid = first.source.sourceId;
      const oldRev = first.source.currentRevision;

      // 已发布页引用旧修订 → 更新时保留证据
      mkdirSync(join(kbDir, 'wiki', 'concepts'), { recursive: true });
      writeFileSync(
        join(kbDir, 'wiki', 'concepts', 'p.md'),
        ['---', 'sources:', `  - sourceId: "${sid}"`, `    sourceRevision: "${oldRev}"`, '---', '', '正文'].join('\n'),
        'utf-8',
      );

      const v2 = join(tmpDir, 'wiki-rev-v2.md');
      writeFileSync(v2, 'bytes-v2', 'utf-8');
      await caller.importSources({ items: [{ absolutePath: v2, relPath: 'wiki-rev-v1.md' }] });

      const revisions: WikiSourceRevisionInfo[] = await caller.sourceRevisions({ sourceId: sid });
      expect(revisions).toHaveLength(2);
      const hist = revisions.find((r) => !r.isCurrent)!;
      expect(hist.originalFile).toBe('wiki-rev-v1.md');

      const histView = await caller.sourceParsed({ sourceId: sid, revision: oldRev });
      expect(histView.isHistorical).toBe(true);
      expect(histView.content).toBe('bytes-v1');

      const original = await caller.sourceOriginal({ sourceId: sid, revision: oldRev });
      expect(original.path).not.toBeNull();
      expect(readFileSync(original.path!, 'utf-8')).toBe('bytes-v1');
    });

    it('sourceParsed 未知来源抛 NOT_FOUND', async () => {
      await expect(caller.sourceParsed({ sourceId: 'missing' })).rejects.toThrow();
    });

    it('convertSource 未知来源返回 sourceNotFound Result（不抛错）', async () => {
      const r = await caller.convertSource({ sourceId: 'missing' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('sourceNotFound');
    });

    it('importExtensions 不宣称引擎未支持的格式', async () => {
      const { extensions } = await caller.importExtensions({});
      expect(extensions).toContain('.md');
      expect(extensions).toContain('.pdf');
      expect(extensions).toContain('.docx');
      expect(extensions).not.toContain('.html');
    });

    it('importSources 缺 items / 空 items 抛 BAD_REQUEST', async () => {
      await expect(caller.importSources({} as { items: Array<{ absolutePath: string }> })).rejects.toThrow();
      await expect(caller.importSources({ items: [] })).rejects.toThrow();
      await expect(caller.importSources({ items: [{ absolutePath: '' }] })).rejects.toThrow();
    });
  });
});
