/**
 * EL 文件生成测试（ADR 0026 决策 3 / 工单 07）。
 *
 * 覆盖：
 * - generateElFile：路径（.socverify/coverage/exclusions/<sessionId>.el）、
 *   只含 approved 条目、file/line 与 bin 两种指令语法、
 *   文件头（soc-verify 生成 + 审批信息注释）、无 approved 时删除文件返回 null
 * - existingElfile：存在/不存在
 * - Coverage Preprocessing 的 urg 命令附加 -elfile（CoverageReportGenerator + mock runner）：
 *   EL 存在时命令含 -elfile <path>，不存在时不附加
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateElFile,
  elfilePath,
  existingElfile,
} from '../../src/main/coverage/exclusion-el';
import { CoverageReportGenerator } from '../../src/main/coverage/coverage-report-generator';
import type { CommandResult } from '../../src/main/coverage/coverage-report-generator';
import type { CoverageExclusion, EdaToolConfig } from '@shared/types';

// ─── 测试数据 ────────────────────────────────────────────────────

function makeExclusion(
  overrides: Partial<CoverageExclusion> & Pick<CoverageExclusion, 'id' | 'status'>,
): CoverageExclusion {
  return {
    sessionId: 'merge_test',
    nodePath: 'cpu_core',
    metric: 'line',
    reason: 'dead code — power-down gated',
    requestedBy: 'ai-triage',
    requestedAt: 1000,
    ...overrides,
  };
}

/** generateElFile 返回值收窄辅助（有 approved 条目时应返回路径而非 null） */
function expectPath(path: string | null): string {
  if (path === null) throw new Error('generateElFile 应返回路径');
  return path;
}

// ─── generateElFile ──────────────────────────────────────────────

describe('generateElFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'elfile-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('写入 .socverify/coverage/exclusions/<sessionId>.el，文件头注明 soc-verify 生成', async () => {
    const exclusions = [
      makeExclusion({
        id: 'excl_1',
        status: 'approved',
        file: 'rtl/cpu_core.sv',
        line: 142,
        approvedBy: 'user',
        approvedAt: 2000,
      }),
    ];
    const path = expectPath(await generateElFile(tmpDir, 'merge_test', exclusions));
    expect(path).toBe(elfilePath(tmpDir, 'merge_test'));
    expect(path).toBe(join(tmpDir, '.socverify', 'coverage', 'exclusions', 'merge_test.el'));
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('soc-verify');
    expect(content).toContain('merge_test');
  });

  it('file/line 形态输出 `file: <path> line: <n>` 指令', async () => {
    const exclusions = [
      makeExclusion({
        id: 'excl_1',
        status: 'approved',
        file: 'rtl/cpu_core.sv',
        line: 142,
        approvedBy: 'user',
      }),
    ];
    const path = expectPath(await generateElFile(tmpDir, 'merge_test', exclusions));
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('file: rtl/cpu_core.sv line: 142');
  });

  it('bin 形态输出 instance/bin 指令', async () => {
    const exclusions = [
      makeExclusion({
        id: 'excl_2',
        status: 'approved',
        metric: 'functional',
        nodePath: 'memory_ctrl',
        bin: 'err_inject.bin_backdoor',
        approvedBy: 'user',
      }),
    ];
    const path = expectPath(await generateElFile(tmpDir, 'merge_test', exclusions));
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('instance: memory_ctrl bin: err_inject.bin_backdoor');
  });

  it('只含 approved 条目：pending / rejected 不写入指令', async () => {
    const exclusions = [
      makeExclusion({
        id: 'excl_pending',
        status: 'pending',
        file: 'rtl/pending.sv',
        line: 1,
      }),
      makeExclusion({
        id: 'excl_rejected',
        status: 'rejected',
        file: 'rtl/rejected.sv',
        line: 2,
        rejectionReason: 'no evidence',
      }),
      makeExclusion({
        id: 'excl_approved',
        status: 'approved',
        file: 'rtl/approved.sv',
        line: 3,
        approvedBy: 'user',
      }),
    ];
    const path = expectPath(await generateElFile(tmpDir, 'merge_test', exclusions));
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('file: rtl/approved.sv line: 3');
    expect(content).not.toContain('rtl/pending.sv line');
    expect(content).not.toContain('rtl/rejected.sv line');
  });

  it('每条 approved 条目带一行注释，含审批信息（id / approved-by / reason）', async () => {
    const exclusions = [
      makeExclusion({
        id: 'excl_audit',
        status: 'approved',
        file: 'rtl/a.sv',
        line: 10,
        approvedBy: 'lead1',
      }),
    ];
    const path = expectPath(await generateElFile(tmpDir, 'merge_test', exclusions));
    const content = readFileSync(path, 'utf-8');
    const commentLine = content.split('\n').find((l) => l.includes('# Entry: excl_audit'));
    expect(commentLine).toBeDefined();
    expect(commentLine).toContain('approved-by=lead1');
    expect(commentLine).toContain('reason=dead code — power-down gated');
    expect(commentLine).toContain('module=cpu_core');
  });

  it('无 approved 条目时删除既有 EL 文件并返回 null', async () => {
    // 先生成一个含 approved 的 EL 文件
    const path = await generateElFile(tmpDir, 'merge_test', [
      makeExclusion({ id: 'excl_1', status: 'approved', file: 'a.sv', line: 1 }),
    ]);
    if (path === null) throw new Error('generateElFile 应返回路径');
    expect(existsSync(path)).toBe(true);

    // 全部条目非 approved（如又被驳回的旁路场景）→ 文件移除
    const result = await generateElFile(tmpDir, 'merge_test', [
      makeExclusion({ id: 'excl_1', status: 'rejected', file: 'a.sv', line: 1 }),
    ]);
    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('空 exclusions 且无既有文件时返回 null（不抛错）', async () => {
    const result = await generateElFile(tmpDir, 'merge_none', []);
    expect(result).toBeNull();
  });
});

// ─── existingElfile ──────────────────────────────────────────────

describe('existingElfile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'elfile-exist-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('文件不存在时返回 null', async () => {
    expect(await existingElfile(tmpDir, 'merge_test')).toBeNull();
  });

  it('文件存在时返回完整路径', async () => {
    const path = elfilePath(tmpDir, 'merge_test');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '# test', 'utf-8');
    expect(await existingElfile(tmpDir, 'merge_test')).toBe(path);
  });
});

// ─── Coverage Preprocessing 命令附加 -elfile（mock runner） ─────

describe('Coverage Preprocessing urg 命令附加 -elfile', () => {
  let tmpDir: string;
  /** 捕获所有传给 mock runner 的命令 */
  let capturedCommands: string[];

  const URG_CONFIG: EdaToolConfig = {
    tool: 'vcs-urg',
    covMergeDir: 'cov_merge',
    summaryCommand: 'urg -full64 -dir {covMergeDir} -xml_verbose -format text -show summary -report {reportDir}',
    detailCommand: 'urg -full64 -dir {covMergeDir} -format text -detail -report {reportDir}/detail',
    execBackend: 'direct',
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'elfile-preprocess-'));
    capturedCommands = [];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeGenerator = (): CoverageReportGenerator =>
    new CoverageReportGenerator({
      projectRoot: tmpDir,
      runner: vi.fn(async (command: string): Promise<CommandResult> => {
        capturedCommands.push(command);
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });

  it('EL 文件存在时 urg 命令含 -elfile <path>', async () => {
    // 通过审批链路同款函数生成 EL 文件
    await generateElFile(tmpDir, 'merge_test', [
      makeExclusion({ id: 'excl_1', status: 'approved', file: 'a.sv', line: 1 }),
    ]);
    const gen = makeGenerator();
    await gen.generate(URG_CONFIG, 'cov_merge', 'merge_test');

    const expectedEl = elfilePath(tmpDir, 'merge_test');
    expect(capturedCommands.length).toBeGreaterThan(0);
    for (const cmd of capturedCommands) {
      expect(cmd).toContain(`-elfile "${expectedEl}"`);
    }
  });

  it('EL 文件不存在时命令不附加 -elfile', async () => {
    const gen = makeGenerator();
    await gen.generate(URG_CONFIG, 'cov_merge', 'merge_test');

    expect(capturedCommands.length).toBeGreaterThan(0);
    for (const cmd of capturedCommands) {
      expect(cmd).not.toContain('-elfile');
    }
  });

  it('自定义模板时 -elfile 追加在模板替换结果之后', async () => {
    await generateElFile(tmpDir, 'merge_test', [
      makeExclusion({ id: 'excl_1', status: 'approved', file: 'a.sv', line: 1 }),
    ]);
    const customConfig: EdaToolConfig = {
      ...URG_CONFIG,
      detailCommand: undefined,
      summaryCommand: 'urg -custom-flag -dir {covMergeDir} -report {reportDir}',
    };
    const gen = makeGenerator();
    await gen.generate(customConfig, 'cov_merge', 'merge_test');

    const expectedEl = elfilePath(tmpDir, 'merge_test');
    expect(capturedCommands[0]).toContain(`urg -custom-flag -dir`);
    // 模板替换结果之后追加 -elfile
    expect(capturedCommands[0].endsWith(`-elfile "${expectedEl}"`)).toBe(true);
  });
});
