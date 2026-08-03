import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLogFile, parseLogStream } from '../../src/main/timing-violation/parser/vio-parser';
import { convertTimeToFs, convertTimeToNs, formatTimeDisplay } from '../../src/main/timing-violation/parser/time-utils';
import {
  parseCornerFromDirName,
  parseSeedFromDirName,
  parseCaseInfoFromPath,
} from '../../src/main/timing-violation/parser/case-info-parser';

// ─── 时间转换 ──────────────────────────────────────────────────

describe('Time Utils', () => {
  describe('convertTimeToFs', () => {
    it('converts FS to femtoseconds (identity)', () => {
      expect(convertTimeToFs('1523423 FS')).toBe(1523423);
    });

    it('converts PS to femtoseconds (×1000)', () => {
      expect(convertTimeToFs('100 PS')).toBe(100000);
    });

    it('converts NS to femtoseconds (×1000000)', () => {
      expect(convertTimeToFs('1 NS')).toBe(1000000);
    });

    it('handles missing unit (assumes femtoseconds)', () => {
      expect(convertTimeToFs('500')).toBe(500);
    });

    it('handles lowercase units', () => {
      expect(convertTimeToFs('100 ps')).toBe(100000);
      expect(convertTimeToFs('1 ns')).toBe(1000000);
    });

    it('handles decimal values', () => {
      expect(convertTimeToFs('1.5 PS')).toBe(1500);
    });

    it('returns 0 for unparseable strings', () => {
      expect(convertTimeToFs('invalid')).toBe(0);
    });
  });

  describe('convertTimeToNs', () => {
    it('converts FS to nanoseconds', () => {
      expect(convertTimeToNs('1523423 FS')).toBeCloseTo(1.523423, 6);
    });

    it('converts PS to nanoseconds', () => {
      expect(convertTimeToNs('100 PS')).toBeCloseTo(0.1, 6);
    });

    it('converts NS to nanoseconds (identity)', () => {
      expect(convertTimeToNs('1 NS')).toBe(1.0);
    });
  });

  describe('formatTimeDisplay', () => {
    it('formats as ns when >= 1000000 fs', () => {
      expect(formatTimeDisplay(1523423)).toBe('1.523 ns');
    });

    it('formats as ps when >= 1000 fs and < 1000000 fs', () => {
      expect(formatTimeDisplay(1500)).toBe('1.500 ps');
    });

    it('formats as fs when < 1000 fs', () => {
      expect(formatTimeDisplay(500)).toBe('500 fs');
    });
  });
});

// ─── 用例信息解析 ──────────────────────────────────────────────

describe('Case Info Parser', () => {
  describe('parseCornerFromDirName', () => {
    it('extracts corner from {case}_{corner} format', () => {
      const result = parseCornerFromDirName('test_case_npg_f1_ssg');
      expect(result.caseName).toBe('test_case');
      expect(result.corner).toBe('npg_f1_ssg');
    });

    it('extracts corner from {case}_{corner}_suffix format', () => {
      const result = parseCornerFromDirName('test_case_npg_f1_ffg_cloud');
      expect(result.caseName).toBe('test_case');
      expect(result.corner).toBe('npg_f1_ffg');
    });

    it('returns null corner when no match', () => {
      const result = parseCornerFromDirName('plain_case_name');
      expect(result.caseName).toBe('plain_case_name');
      expect(result.corner).toBeNull();
    });

    it('prefers longer corner names to avoid partial matches', () => {
      // npg_f1_ssg should match, not npg_f1_ss or similar
      const result = parseCornerFromDirName('case_npg_f1_ssg');
      expect(result.corner).toBe('npg_f1_ssg');
    });
  });

  describe('parseSeedFromDirName', () => {
    it('extracts numeric seed from {case}_{seed} format', () => {
      const result = parseSeedFromDirName('test_case_1');
      expect(result.caseName).toBe('test_case');
      expect(result.seed).toBe('1');
    });

    it('extracts multi-digit seed', () => {
      const result = parseSeedFromDirName('test_case_123');
      expect(result.caseName).toBe('test_case');
      expect(result.seed).toBe('123');
    });

    it('returns null seed when no trailing number', () => {
      const result = parseSeedFromDirName('test_case');
      expect(result.caseName).toBe('test_case');
      expect(result.seed).toBeNull();
    });
  });

  describe('parseCaseInfoFromPath', () => {
    it('extracts case_name, corner, seed from standard regression path', () => {
      const path = '/regression/dsp_sys/test_case_npg_f1_ssg/test_case_1/log/vio_summary.log';
      const info = parseCaseInfoFromPath(path);
      expect(info.caseName).toBe('test_case');
      expect(info.corner).toBe('npg_f1_ssg');
      expect(info.seed).toBe('1');
      expect(info.subsys).toBe('dsp_sys');
    });

    it('extracts case_name and corner when path uses top subsys', () => {
      const path = '/regression/top/my_case_npg_f2_tt/my_case_42/log/vio_summary.log';
      const info = parseCaseInfoFromPath(path);
      expect(info.caseName).toBe('my_case');
      expect(info.corner).toBe('npg_f2_tt');
      expect(info.seed).toBe('42');
      expect(info.subsys).toBe('top');
    });

    it('uses explicit caseName/corner when provided', () => {
      const path = '/some/random/path/log/vio_summary.log';
      const info = parseCaseInfoFromPath(path, { caseName: 'explicit_case', corner: 'explicit_corner' });
      expect(info.caseName).toBe('explicit_case');
      expect(info.corner).toBe('explicit_corner');
    });

    it('handles Windows-style paths', () => {
      const path = 'D:\\regression\\dsp_sys\\test_case_npg_f1_ssg\\test_case_1\\log\\vio_summary.log';
      const info = parseCaseInfoFromPath(path);
      expect(info.caseName).toBe('test_case');
      expect(info.corner).toBe('npg_f1_ssg');
      expect(info.seed).toBe('1');
    });

    it('falls back to seed dir name when corner dir does not match any corner', () => {
      // Path: D:\...\work\page_test_027_test\log\vio_summary.log
      // corner dir = 'work' (no corner match) → should fall back to seed dir
      const path = 'D:\\doc\\python\\runsim_r3p0\\work\\page_test_027_test\\log\\vio_summary.log';
      const info = parseCaseInfoFromPath(path);
      expect(info.caseName).toBe('page_test_027_test');
      expect(info.corner).toBeNull();
      expect(info.seed).toBeNull();
    });
  });
});

// ─── 日志解析器 ────────────────────────────────────────────────

describe('VioLogParser', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tmpdir() + `/sv-tv-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeLogPath(filename: string): string {
    return join(tmpDir, filename);
  }

  function makeFullLogPath(violations: Array<{ num: number; hier: string; time: string; check: string }>): string {
    const filePath = makeLogPath('vio_summary.log');
    const lines: string[] = [];
    for (const v of violations) {
      lines.push('------------------------------------------------------------');
      lines.push(`NUM    : ${v.num}`);
      lines.push(`Hier   : ${v.hier}`);
      lines.push(`Time   : ${v.time}`);
      lines.push(`Check  : ${v.check}`);
      lines.push('------------------------------------------------------------');
    }
    writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  }

  it('parses standard violation entries', async () => {
    const filePath = makeFullLogPath([
      { num: 1, hier: 'tb_top.dut.reg', time: '1523423 FS', check: 'setup( posedge clk, negedge data )' },
      { num: 2, hier: 'tb_top.dut.mem', time: '100 PS', check: 'hold( posedge clk, negedge data )' },
    ]);

    const result = await parseLogFile(filePath);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0].num).toBe(1);
    expect(result.violations[0].hier).toBe('tb_top.dut.reg');
    expect(result.violations[0].timeFs).toBe(1523423);
    expect(result.violations[0].timeDisplay).toBe('1523423 FS');
    expect(result.violations[0].checkInfo).toBe('setup( posedge clk, negedge data )');
    expect(result.violations[1].num).toBe(2);
    expect(result.violations[1].timeFs).toBe(100000); // 100 PS → 100000 FS
  });

  it('handles multi-line Check field', async () => {
    const filePath = makeLogPath('vio_summary.log');
    const content = [
      '------------------------------------------------------------',
      'NUM    : 1',
      'Hier   : tb_top.dut',
      'Time   : 100 FS',
      'Check  : setup( posedge clk,',
      'negedge data,',
      'margin: -50 PS )',
      '------------------------------------------------------------',
    ].join('\n');
    writeFileSync(filePath, content, 'utf-8');

    const result = await parseLogFile(filePath);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].checkInfo).toContain('setup( posedge clk,');
    expect(result.violations[0].checkInfo).toContain('negedge data,');
    expect(result.violations[0].checkInfo).toContain('margin: -50 PS )');
  });

  it('skips invalid entries missing required fields', async () => {
    const filePath = makeLogPath('vio_summary.log');
    const content = [
      '------------------------------------------------------------',
      'NUM    : 1',
      'Hier   : tb_top.dut',
      // Missing Time and Check
      '------------------------------------------------------------',
      '------------------------------------------------------------',
      'NUM    : 2',
      'Hier   : tb_top.dut2',
      'Time   : 100 FS',
      'Check  : hold( posedge clk )',
      '------------------------------------------------------------',
    ].join('\n');
    writeFileSync(filePath, content, 'utf-8');

    const result = await parseLogFile(filePath);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].num).toBe(2);
  });

  it('converts time units correctly (FS/PS/NS)', async () => {
    const filePath = makeFullLogPath([
      { num: 1, hier: 'a', time: '500 FS', check: 'check1' },
      { num: 2, hier: 'b', time: '100 PS', check: 'check2' },
      { num: 3, hier: 'c', time: '1 NS', check: 'check3' },
      { num: 4, hier: 'd', time: '2500', check: 'check4' }, // no unit = FS
    ]);

    const result = await parseLogFile(filePath);
    expect(result.violations[0].timeFs).toBe(500);
    expect(result.violations[1].timeFs).toBe(100000);
    expect(result.violations[2].timeFs).toBe(1000000);
    expect(result.violations[3].timeFs).toBe(2500);
  });

  it('returns empty array for empty file', async () => {
    const filePath = makeLogPath('empty.log');
    writeFileSync(filePath, '', 'utf-8');

    const result = await parseLogFile(filePath);
    expect(result.violations).toHaveLength(0);
  });

  it('handles entry without trailing separator', async () => {
    const filePath = makeLogPath('vio_summary.log');
    const content = [
      '------------------------------------------------------------',
      'NUM    : 1',
      'Hier   : tb_top.dut',
      'Time   : 100 FS',
      'Check  : setup( posedge clk )',
      // No trailing ---- separator
    ].join('\n');
    writeFileSync(filePath, content, 'utf-8');

    const result = await parseLogFile(filePath);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].num).toBe(1);
  });

  it('calls onViolation callback for streaming mode', async () => {
    const filePath = makeFullLogPath([
      { num: 1, hier: 'a', time: '100 FS', check: 'check1' },
      { num: 2, hier: 'b', time: '200 FS', check: 'check2' },
    ]);

    const collected: number[] = [];
    await parseLogStream(
      filePath,
      {},
      (v) => collected.push(v.num),
    );
    expect(collected).toEqual([1, 2]);
  });

  it('extracts case info from file path', async () => {
    // Create a path that matches the standard regression structure
    const caseDir = join(tmpDir, 'dsp_sys', 'test_case_npg_f1_ssg', 'test_case_1', 'log');
    mkdirSync(caseDir, { recursive: true });
    const filePath = join(caseDir, 'vio_summary.log');

    const content = [
      '------------------------------------------------------------',
      'NUM    : 1',
      'Hier   : tb_top.dut',
      'Time   : 100 FS',
      'Check  : setup( posedge clk )',
      '------------------------------------------------------------',
    ].join('\n');
    writeFileSync(filePath, content, 'utf-8');

    const result = await parseLogFile(filePath);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].caseName).toBe('test_case');
    expect(result.violations[0].corner).toBe('npg_f1_ssg');
    expect(result.violations[0].seed).toBe('1');
    expect(result.violations[0].subsys).toBe('dsp_sys');
  });
});
