/**
 * kb-router 端到端测试。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * mock electron（app.getPath 返回临时目录）和 project-service（requireProject 返回临时项目路径）。
 * 参照 dashboard-router 测试模式。
 *
 * 覆盖场景：
 *  - kb.register：空目录初始化标准结构、已有目录兼容校验、重复注册拒绝、路径校验
 *  - kb.unregister：成功注销、未注册拒绝、已挂载拒绝
 *  - kb.list：返回注册列表 + 统计 + 挂载标记
 *  - kb.mount：成功挂载、超限拒绝、未注册拒绝、重复挂载拒绝
 *  - kb.unmount：成功卸载、未挂载拒绝
 *  - kb.status：当前挂载库 + 结构健康检查
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
}));

vi.mock('../src/main/services/project-service', () => ({
  requireProject: vi.fn(() => ({
    id: 'test-project-id',
    rootPath: projectDir,
    name: 'Test Project',
  })),
}));

// ─── Imports (after mocks) ──────────────────────────────────

import { kbRouter } from '../src/main/ipc/routers/kb-router';
import type { KbListEntry, KbStatus } from '../src/main/kb/types';

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

    it('挂载库被注销后 status 不报错（mounted 为 null）', async () => {
      const kbDir = makeEmptyKbDir('gone-kb');
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
});
