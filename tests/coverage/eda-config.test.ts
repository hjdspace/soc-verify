import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEdaConfig, saveEdaConfig, normalizeConfig } from '../../src/main/coverage/eda-config';
import { DEFAULT_EDA_COMMANDS } from '@shared/types';

// ─── 工单 01 期望值（独立事实源，勿从实现反推） ──────────────────

/** 第一代旧默认 summary 模板（已发布版本落盘，无 -full64）。 */
const LEGACY_V1_SUMMARY_COMMAND = 'urg -dir {covMergeDir} -format text -report {reportDir}';
/** 第二代旧默认 summary 模板（ADR 0021 中间态，含 -full64）。 */
const LEGACY_V2_SUMMARY_COMMAND = 'urg -full64 -dir {covMergeDir} -format text -report {reportDir}';
/** vcs-urg 新默认 summary 模板：生成类型化 session.xml + summary 文本。 */
const NEW_SUMMARY_COMMAND =
  'urg -full64 -dir {covMergeDir} -xml_verbose -format text -show summary -report {reportDir}';
/** vcs-urg 新默认 detail 模板：全量 text 报告，供 uncovered 项导出。 */
const NEW_DETAIL_COMMAND = 'urg -full64 -dir {covMergeDir} -format text -report {reportDir}/detail';

/** 创建临时项目根目录。 */
function makeTmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'eda-cfg-'));
}

/** 直接向临时项目写入存储态 eda-config.json（模拟旧版本落盘数据）。 */
function writeStoredConfig(projectRoot: string, config: unknown): void {
  const dir = join(projectRoot, '.socverify', 'coverage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'eda-config.json'), JSON.stringify(config), 'utf-8');
}

// ─── DEFAULT_EDA_COMMANDS：vcs-urg 修正后的默认命令 ─────────────

describe('DEFAULT_EDA_COMMANDS vcs-urg', () => {
  it('covMergeDir 指向输入目录 cov_merge（非 urg 输出目录 urgReport）', () => {
    expect(DEFAULT_EDA_COMMANDS['vcs-urg'].covMergeDir).toBe('cov_merge');
  });

  it('summaryCommand 生成 session.xml + summary 文本（-xml_verbose -show summary）', () => {
    expect(DEFAULT_EDA_COMMANDS['vcs-urg'].summaryCommand).toBe(NEW_SUMMARY_COMMAND);
  });

  it('detailCommand 为全量 text 报告，输出到 {reportDir}/detail', () => {
    expect(DEFAULT_EDA_COMMANDS['vcs-urg'].detailCommand).toBe(NEW_DETAIL_COMMAND);
  });

  it('gradeCommand 保持不变，csv/bins 维持 undefined', () => {
    expect(DEFAULT_EDA_COMMANDS['vcs-urg'].gradeCommand).toBe(
      'urg -full64 -dir {covMergeDir} -grade testfile -format text -report {reportDir}/grade',
    );
    expect(DEFAULT_EDA_COMMANDS['vcs-urg'].csvCommand).toBeUndefined();
    expect(DEFAULT_EDA_COMMANDS['vcs-urg'].binsCommand).toBeUndefined();
  });
});

// ─── normalizeConfig：新字段默认值 ─────────────────────────────

describe('normalizeConfig 新字段默认值', () => {
  it('未提供新字段时填充 execBackend=direct、startupTimeoutSec=120、runTimeoutSec=600', () => {
    const normalized = normalizeConfig({ tool: 'imc', covMergeDir: '' });
    expect(normalized.execBackend).toBe('direct');
    expect(normalized.startupTimeoutSec).toBe(120);
    expect(normalized.runTimeoutSec).toBe(600);
    expect(normalized.lsfQueue).toBeUndefined();
    expect(normalized.lsfResource).toBeUndefined();
  });

  it('用户提供的新字段值保留不覆盖（lsf + 队列 + 资源串 + 自定义超时）', () => {
    const normalized = normalizeConfig({
      tool: 'vcs-urg',
      covMergeDir: 'my_merge',
      execBackend: 'lsf',
      lsfQueue: 'normal',
      lsfResource: 'rusage[mem=8192]',
      startupTimeoutSec: 30,
      runTimeoutSec: 1800,
    });
    expect(normalized.execBackend).toBe('lsf');
    expect(normalized.lsfQueue).toBe('normal');
    expect(normalized.lsfResource).toBe('rusage[mem=8192]');
    expect(normalized.startupTimeoutSec).toBe(30);
    expect(normalized.runTimeoutSec).toBe(1800);
    // 命令模板默认值仍照常填充
    expect(normalized.summaryCommand).toBe(NEW_SUMMARY_COMMAND);
    expect(normalized.detailCommand).toBe(NEW_DETAIL_COMMAND);
  });

  it('unknown 工具维持现状：不填充命令模板与新字段默认值', () => {
    const normalized = normalizeConfig({ tool: 'unknown', covMergeDir: 'x' });
    expect(normalized.summaryCommand).toBeUndefined();
    expect(normalized.execBackend).toBeUndefined();
    expect(normalized.startupTimeoutSec).toBeUndefined();
    expect(normalized.runTimeoutSec).toBeUndefined();
  });
});

// ─── saveEdaConfig：lsf 校验 ───────────────────────────────────

describe('saveEdaConfig 校验', () => {
  it('execBackend=lsf 且 lsfQueue 缺失时抛出中文错误', async () => {
    const tmpDir = makeTmpProject();
    await expect(
      saveEdaConfig(tmpDir, { tool: 'vcs-urg', covMergeDir: 'cov_merge', execBackend: 'lsf' }),
    ).rejects.toThrow(/lsfQueue/);
    rmSync(tmpDir, { recursive: true });
  });

  it('execBackend=lsf 且 lsfQueue 为空白字符串时抛出中文错误', async () => {
    const tmpDir = makeTmpProject();
    await expect(
      saveEdaConfig(tmpDir, { tool: 'vcs-urg', covMergeDir: 'cov_merge', execBackend: 'lsf', lsfQueue: '   ' }),
    ).rejects.toThrow(/lsfQueue/);
    rmSync(tmpDir, { recursive: true });
  });

  it('execBackend=lsf 且提供合法 lsfQueue 时保存成功并持久化', async () => {
    const tmpDir = makeTmpProject();
    const saved = await saveEdaConfig(tmpDir, {
      tool: 'vcs-urg',
      covMergeDir: 'cov_merge',
      execBackend: 'lsf',
      lsfQueue: 'normal',
      lsfResource: 'rusage[mem=4096]',
    });
    expect(saved.execBackend).toBe('lsf');
    expect(saved.lsfQueue).toBe('normal');
    // 持久化到 .socverify/coverage/eda-config.json
    const stored = JSON.parse(
      readFileSync(join(tmpDir, '.socverify', 'coverage', 'eda-config.json'), 'utf-8'),
    );
    expect(stored.execBackend).toBe('lsf');
    expect(stored.lsfQueue).toBe('normal');
    rmSync(tmpDir, { recursive: true });
  });

  it('direct 默认行为与现状一致：保存成功、回读一致', async () => {
    const tmpDir = makeTmpProject();
    const saved = await saveEdaConfig(tmpDir, {
      tool: 'imc',
      covMergeDir: '/abs/cov_merge',
      summaryCommand: 'imc custom',
    });
    expect(saved.execBackend).toBe('direct');
    expect(saved.summaryCommand).toBe('imc custom'); // 自定义模板不覆盖

    const loaded = await loadEdaConfig(tmpDir);
    expect(loaded).toEqual(saved);
    rmSync(tmpDir, { recursive: true });
  });
});

// ─── loadEdaConfig：旧配置迁移（ADR 0024） ─────────────────────

describe('loadEdaConfig 旧配置迁移', () => {
  it('第一代旧默认（已发布版本，无 -full64）全字段迁移为新默认并补全新 schema', async () => {
    const tmpDir = makeTmpProject();
    // 模拟已发布版本落盘的 vcs-urg 完整默认配置
    writeStoredConfig(tmpDir, {
      tool: 'vcs-urg',
      covMergeDir: 'urgReport',
      summaryCommand: LEGACY_V1_SUMMARY_COMMAND,
      detailCommand: 'urg -dir {covMergeDir} -format text -detail -report {reportDir}',
      metricsCommand: 'urg -dir {covMergeDir} -format text -metrics -report {reportDir}',
      csvCommand: 'urg -dir {covMergeDir} -format csv -report {reportDir}/csv',
      gradeCommand: 'urg -dir {covMergeDir} -grade testfile -report {reportDir}',
      binsCommand: undefined,
    });

    const loaded = await loadEdaConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.covMergeDir).toBe('cov_merge');
    expect(loaded!.summaryCommand).toBe(NEW_SUMMARY_COMMAND);
    expect(loaded!.detailCommand).toBe(NEW_DETAIL_COMMAND);
    // 旧 metrics/csv 独立命令在新方案中收敛为 undefined（由 summary/detail 产物覆盖）
    expect(loaded!.metricsCommand).toBeUndefined();
    expect(loaded!.csvCommand).toBeUndefined();
    expect(loaded!.gradeCommand).toBe(
      'urg -full64 -dir {covMergeDir} -grade testfile -format text -report {reportDir}/grade',
    );
    // 迁移后按新 schema 补默认字段
    expect(loaded!.execBackend).toBe('direct');
    expect(loaded!.startupTimeoutSec).toBe(120);
    expect(loaded!.runTimeoutSec).toBe(600);
    rmSync(tmpDir, { recursive: true });
  });

  it('第二代旧默认（ADR 0021 中间态，含 -full64）迁移为新默认', async () => {
    const tmpDir = makeTmpProject();
    writeStoredConfig(tmpDir, {
      tool: 'vcs-urg',
      covMergeDir: 'urgReport',
      summaryCommand: LEGACY_V2_SUMMARY_COMMAND,
      detailCommand: undefined,
      metricsCommand: undefined,
      csvCommand: undefined,
      gradeCommand:
        'urg -full64 -dir {covMergeDir} -grade testfile -format text -report {reportDir}/grade',
      binsCommand: undefined,
    });

    const loaded = await loadEdaConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.covMergeDir).toBe('cov_merge');
    expect(loaded!.summaryCommand).toBe(NEW_SUMMARY_COMMAND);
    expect(loaded!.detailCommand).toBe(NEW_DETAIL_COMMAND);
    rmSync(tmpDir, { recursive: true });
  });

  it('用户自定义过的 summaryCommand 不被迁移覆盖', async () => {
    const tmpDir = makeTmpProject();
    writeStoredConfig(tmpDir, {
      tool: 'vcs-urg',
      covMergeDir: 'urgReport',
      summaryCommand: 'urg -full64 -custom-flags -report {reportDir}',
    });

    const loaded = await loadEdaConfig(tmpDir);
    expect(loaded!.summaryCommand).toBe('urg -full64 -custom-flags -report {reportDir}');
    // covMergeDir 仍按旧默认迁移
    expect(loaded!.covMergeDir).toBe('cov_merge');
    rmSync(tmpDir, { recursive: true });
  });

  it('用户自定义的 covMergeDir（非 urgReport）保留不动', async () => {
    const tmpDir = makeTmpProject();
    writeStoredConfig(tmpDir, {
      tool: 'vcs-urg',
      covMergeDir: '/data/project/cov_merge',
      summaryCommand: LEGACY_V1_SUMMARY_COMMAND,
    });

    const loaded = await loadEdaConfig(tmpDir);
    expect(loaded!.covMergeDir).toBe('/data/project/cov_merge');
    // 命令模板与旧默认一致仍迁移
    expect(loaded!.summaryCommand).toBe(NEW_SUMMARY_COMMAND);
    rmSync(tmpDir, { recursive: true });
  });

  it('非 vcs-urg 工具不受迁移影响（urgReport 对其是自定义值）', async () => {
    const tmpDir = makeTmpProject();
    writeStoredConfig(tmpDir, {
      tool: 'imc',
      covMergeDir: 'urgReport',
      summaryCommand: 'imc -load {covMergeDir} -execcmd "custom"',
    });

    const loaded = await loadEdaConfig(tmpDir);
    expect(loaded!.covMergeDir).toBe('urgReport');
    expect(loaded!.summaryCommand).toContain('custom');
    rmSync(tmpDir, { recursive: true });
  });

  it('配置文件不存在时返回 null', async () => {
    const tmpDir = makeTmpProject();
    expect(await loadEdaConfig(tmpDir)).toBeNull();
    rmSync(tmpDir, { recursive: true });
  });
});
