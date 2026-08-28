/**
 * case-cfg-router 端到端测试。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * mock requireProject / electron dialog。
 * 使用真实 tmpdir 文件系统验证 cfg 解析和持久化。
 *
 * 先例：tests/simulation/simulation-router.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SubsysInfo, UdtbDirInfo } from '../../src/main/case/case-cfg-manager';

// ─── Hoisted mock state ─────────────────────────────────────

const { mockRequireProject, mockDialog } = vi.hoisted(() => ({
  mockRequireProject: vi.fn(),
  mockDialog: {
    showOpenDialog: vi.fn(),
  },
}));

// ─── Mocks ──────────────────────────────────────────────────

vi.mock('electron', () => ({
  dialog: mockDialog,
}));

vi.mock('../../src/main/services/project-service', () => ({
  requireProject: mockRequireProject,
  ensurePluginsLoaded: vi.fn(),
}));

// ─── Imports (after mocks) ──────────────────────────────────

import { caseCfgRouter } from '../../src/main/ipc/routers/case-cfg-router';

// ─── Test fixtures ──────────────────────────────────────────

let tempProjectDir: string;
let tempProjEnv: string;
let cfgFilePath: string;

beforeEach(async () => {
  tempProjectDir = await mkdtemp(join(tmpdir(), 'socverify-proj-'));
  tempProjEnv = await mkdtemp(join(tmpdir(), 'socverify-env-'));

  // Create .socverify dir
  await mkdir(join(tempProjectDir, '.socverify'), { recursive: true });

  // Create subsystem with cfg file
  await mkdir(join(tempProjEnv, 'apcpu_sys', 'bin', 'case_cfg'), { recursive: true });
  cfgFilePath = join(tempProjEnv, 'apcpu_sys', 'bin', 'case_cfg', 'test_case.cfg');
  await writeFile(
    cfgFilePath,
    '[case root_case]\n[case child_case : root_case]\n[case standalone_case]\n',
  );

  // Wire mock
  mockRequireProject.mockReturnValue({
    id: 'test-project-id',
    rootPath: tempProjectDir,
    name: 'Test Project',
  });
  mockDialog.showOpenDialog.mockResolvedValue({
    canceled: false,
    filePaths: [cfgFilePath],
  });
});

afterEach(async () => {
  await rm(tempProjectDir, { recursive: true, force: true });
  await rm(tempProjEnv, { recursive: true, force: true });
  vi.clearAllMocks();
});

const caller = caseCfgRouter.createCaller({});

// ─── Tests ──────────────────────────────────────────────────

describe('case-cfg-router', () => {
  describe('scanEnv', () => {
    it('returns subsystems from PROJ_ENV', async () => {
      await mkdir(join(tempProjEnv, 'aon_sys'), { recursive: true });
      await mkdir(join(tempProjEnv, 'top'), { recursive: true });
      await mkdir(join(tempProjEnv, 'random_dir'), { recursive: true });

      const result: SubsysInfo[] = await caller.scanEnv({
        projectId: 'test-project-id',
        projEnv: tempProjEnv,
      });

      const names = result.map((s) => s.name).sort();
      expect(names).toEqual(['aon_sys', 'apcpu_sys', 'top']);
    });
  });

  describe('scanUdtbDirs', () => {
    it('returns udtb subdirectories with bin/ dirs', async () => {
      await mkdir(join(tempProjEnv, 'udtb', 'apcpu_sys', 'ip2soc_a', 'bin'), { recursive: true });
      await mkdir(join(tempProjEnv, 'udtb', 'apcpu_sys', 'ip2soc_b', 'bin'), { recursive: true });

      const result: UdtbDirInfo[] = await caller.scanUdtbDirs({
        projectId: 'test-project-id',
        projEnv: tempProjEnv,
        subsys: 'apcpu_sys',
      });

      const relPaths = result.map((d) => d.relPath).sort();
      expect(relPaths).toEqual(['ip2soc_a', 'ip2soc_b']);
    });

    it('returns empty array when udtb/{subsys} does not exist', async () => {
      const result = await caller.scanUdtbDirs({
        projectId: 'test-project-id',
        projEnv: tempProjEnv,
        subsys: 'nonexistent_sys',
      });

      expect(result).toEqual([]);
    });
  });

  describe('loadFromEnv', () => {
    it('discovers and parses cfg files for selected subsystems', async () => {
      const result = await caller.loadFromEnv({
        projectId: 'test-project-id',
        projEnv: tempProjEnv,
        subsystems: ['apcpu_sys'],
        udtbDirs: [],
      });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('test_case.cfg');
      expect(result.files[0].fullPath).toBe(cfgFilePath);
      expect(result.files[0].nodes).toContain('root_case');
      expect(result.files[0].nodes).toContain('standalone_case');
      expect(result.files[0].childCases).toContainEqual({
        case: 'child_case',
        base: 'root_case',
      });
    });

    it('persists file list to .socverify/case-cfg-files.json', async () => {
      await caller.loadFromEnv({
        projectId: 'test-project-id',
        projEnv: tempProjEnv,
        subsystems: ['apcpu_sys'],
        udtbDirs: [],
      });

      const persistPath = join(tempProjectDir, '.socverify', 'case-cfg-files.json');
      expect(existsSync(persistPath)).toBe(true);
      const content = JSON.parse(await readFile(persistPath, 'utf-8'));
      expect(content.files).toContain(cfgFilePath);
    });

    it('discovers cfg files from udtb dirs and merges with standard files', async () => {
      // Create a UDTB cfg file
      const udtbDir = join(tempProjEnv, 'udtb', 'apcpu_sys', 'ip2soc_a');
      await mkdir(join(udtbDir, 'bin'), { recursive: true });
      const udtbCfgPath = join(udtbDir, 'bin', 'udtb_test.cfg');
      await writeFile(udtbCfgPath, '[case udtb_case]\n');

      const result = await caller.loadFromEnv({
        projectId: 'test-project-id',
        projEnv: tempProjEnv,
        subsystems: ['apcpu_sys'],
        udtbDirs: [udtbDir],
      });

      // Should have both standard and UDTB cfg files
      const fileNames = result.files.map((f: { name: string }) => f.name).sort();
      expect(fileNames).toEqual(['test_case.cfg', 'udtb_test.cfg']);
    });
  });

  describe('loadFiles', () => {
    it('parses user-selected files and persists them', async () => {
      const result = await caller.loadFiles({
        projectId: 'test-project-id',
        filePaths: [cfgFilePath],
      });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('test_case.cfg');
      expect(result.files[0].nodes).toContain('root_case');
    });
  });

  describe('getLoadedFiles', () => {
    it('returns persisted files with parsed case tree', async () => {
      await caller.loadFiles({
        projectId: 'test-project-id',
        filePaths: [cfgFilePath],
      });

      const result = await caller.getLoadedFiles({
        projectId: 'test-project-id',
      });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].fullPath).toBe(cfgFilePath);
      expect(result.files[0].nodes).toContain('root_case');
    });

    it('returns empty list when no files loaded', async () => {
      const result = await caller.getLoadedFiles({
        projectId: 'test-project-id',
      });

      expect(result.files).toEqual([]);
    });
  });

  describe('removeFile', () => {
    it('removes a file from the persisted list', async () => {
      await caller.loadFiles({
        projectId: 'test-project-id',
        filePaths: [cfgFilePath],
      });

      await caller.removeFile({
        projectId: 'test-project-id',
        filePath: cfgFilePath,
      });

      const result = await caller.getLoadedFiles({
        projectId: 'test-project-id',
      });
      expect(result.files).toEqual([]);
    });
  });

  describe('refresh', () => {
    it('re-parses all persisted files', async () => {
      await caller.loadFiles({
        projectId: 'test-project-id',
        filePaths: [cfgFilePath],
      });

      await writeFile(
        cfgFilePath,
        '[case new_case]\n[case new_child : new_case]\n',
      );

      const result = await caller.refresh({
        projectId: 'test-project-id',
      });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].nodes).toContain('new_case');
      expect(result.files[0].childCases).toContainEqual({
        case: 'new_child',
        base: 'new_case',
      });
      expect(result.files[0].nodes).not.toContain('root_case');
    });

    it('removes non-existent files during refresh', async () => {
      await caller.loadFiles({
        projectId: 'test-project-id',
        filePaths: [cfgFilePath],
      });

      await rm(cfgFilePath, { force: true });

      const result = await caller.refresh({
        projectId: 'test-project-id',
      });

      expect(result.files).toEqual([]);
    });
  });
});
