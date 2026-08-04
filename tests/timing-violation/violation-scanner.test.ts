import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseStandardStructure,
  parseFlexibleStructure,
} from '../../src/main/timing-violation/scanner/path-parser';
import { scanRegressionDirectory } from '../../src/main/timing-violation/scanner/violation-scanner';

describe('Violation Scanner', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tv-scan-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Helper: create a directory structure and write vio_summary.log
  function createLogFile(pathParts: string[], content = '----\nNUM : 1\nHier : tb.test\nTime : 100 FS\nCheck : setup( a: 1, b: 2, c: 3)\n----\n') {
    const dir = join(tempDir, ...pathParts.slice(0, -1));
    mkdirSync(dir, { recursive: true });
    const filePath = join(tempDir, ...pathParts);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  function createPassLog(pathParts: string[]) {
    const dir = join(tempDir, ...pathParts.slice(0, -1));
    const filePath = join(tempDir, ...pathParts);
    writeFileSync(filePath, '', 'utf-8');
    return filePath;
  }

  describe('parseStandardStructure', () => {
    it('parses standard structure correctly', () => {
      const filePath = createLogFile(['dsp_sys', 'test_case_npg_f1_ssg', 'test_case_1', 'log', 'vio_summary.log']);
      const result = parseStandardStructure(filePath, tempDir);
      expect(result).not.toBeNull();
      expect(result!.subsys).toBe('dsp_sys');
      expect(result!.cornerName).toBe('npg_f1_ssg');
      expect(result!.caseName).toBe('test_case');
      expect(result!.seed).toBe('1');
    });

    it('returns null for non-standard structure (missing log dir)', () => {
      const filePath = createLogFile(['dsp_sys', 'test_case_npg_f1_ssg', 'test_case_1', 'vio_summary.log']);
      const result = parseStandardStructure(filePath, tempDir);
      expect(result).toBeNull();
    });

    it('returns null for insufficient path depth', () => {
      const filePath = createLogFile(['test_case_1', 'log', 'vio_summary.log']);
      const result = parseStandardStructure(filePath, tempDir);
      expect(result).toBeNull();
    });

    it('returns null when case_name mismatch between corner and seed dirs', () => {
      const filePath = createLogFile(['dsp_sys', 'caseA_npg_f1_ssg', 'caseB_1', 'log', 'vio_summary.log']);
      const result = parseStandardStructure(filePath, tempDir);
      expect(result).toBeNull();
    });

    it('returns null when no corner found in dir name', () => {
      const filePath = createLogFile(['dsp_sys', 'test_case_no_corner', 'test_case_1', 'log', 'vio_summary.log']);
      const result = parseStandardStructure(filePath, tempDir);
      expect(result).toBeNull();
    });

    it('uses first directory as subsys when no pattern matches', () => {
      const filePath = createLogFile(['random_dir', 'test_case_npg_f1_ssg', 'test_case_1', 'log', 'vio_summary.log']);
      const result = parseStandardStructure(filePath, tempDir);
      expect(result).not.toBeNull();
      expect(result!.subsys).toBe('random_dir');
    });
  });

  describe('parseFlexibleStructure', () => {
    it('parses flexible structure correctly', () => {
      const filePath = createLogFile(['any_dir', 'test_case_1', 'log', 'vio_summary.log']);
      const result = parseFlexibleStructure(filePath, tempDir);
      expect(result).not.toBeNull();
      expect(result!.caseName).toBe('test_case');
      expect(result!.seed).toBe('1');
    });

    it('finds corner in flexible structure', () => {
      const filePath = createLogFile(['npg_f1_ssg', 'test_case_1', 'log', 'vio_summary.log']);
      const result = parseFlexibleStructure(filePath, tempDir);
      expect(result).not.toBeNull();
      expect(result!.cornerName).toBe('npg_f1_ssg');
    });

    it('sets corner to unknown when not found', () => {
      const filePath = createLogFile(['random', 'test_case_1', 'log', 'vio_summary.log']);
      const result = parseFlexibleStructure(filePath, tempDir);
      expect(result).not.toBeNull();
      expect(result!.cornerName).toBe('unknown');
    });

    it('finds subsys in flexible structure', () => {
      const filePath = createLogFile(['dsp_sys', 'test_case_1', 'log', 'vio_summary.log']);
      const result = parseFlexibleStructure(filePath, tempDir);
      expect(result).not.toBeNull();
      expect(result!.subsys).toBe('dsp_sys');
    });

    it('returns null for insufficient path depth', () => {
      const filePath = createLogFile(['log', 'vio_summary.log']);
      const result = parseFlexibleStructure(filePath, tempDir);
      expect(result).toBeNull();
    });

    it('returns null when seed not found', () => {
      const filePath = createLogFile(['dsp_sys', 'no_seed_here', 'log', 'vio_summary.log']);
      const result = parseFlexibleStructure(filePath, tempDir);
      expect(result).toBeNull();
    });
  });

  describe('scanRegressionDirectory', () => {
    it('finds all vio_summary.log files recursively', () => {
      createLogFile(['dsp_sys', 'test_case_npg_f1_ssg', 'test_case_1', 'log', 'vio_summary.log']);
      createLogFile(['gpu_sys', 'other_case_npg_f2_ssg', 'other_case_2', 'log', 'vio_summary.log']);

      const result = scanRegressionDirectory(tempDir, true);
      expect(result.totalFiles).toBe(2);
      expect(result.validFiles.length).toBe(2);
      expect(result.invalidPaths.length).toBe(0);
    });

    it('groups by subsys correctly', () => {
      createLogFile(['dsp_sys', 'test_case_npg_f1_ssg', 'test_case_1', 'log', 'vio_summary.log']);
      createLogFile(['gpu_sys', 'other_case_npg_f2_ssg', 'other_case_2', 'log', 'vio_summary.log']);
      createLogFile(['dsp_sys', 'test_case2_npg_f1_ssg', 'test_case2_1', 'log', 'vio_summary.log']);

      const result = scanRegressionDirectory(tempDir, true);
      expect(Object.keys(result.subsysGroups)).toContain('dsp_sys');
      expect(Object.keys(result.subsysGroups)).toContain('gpu_sys');
      expect(result.subsysGroups['dsp_sys'].length).toBe(2);
      expect(result.subsysGroups['gpu_sys'].length).toBe(1);
    });

    it('groups by corner correctly', () => {
      createLogFile(['dsp_sys', 'test_case_npg_f1_ssg', 'test_case_1', 'log', 'vio_summary.log']);
      createLogFile(['dsp_sys', 'test_case_npg_f2_ssg', 'test_case_1', 'log', 'vio_summary.log']);

      const result = scanRegressionDirectory(tempDir, true);
      expect(Object.keys(result.cornerGroups)).toContain('npg_f1_ssg');
      expect(Object.keys(result.cornerGroups)).toContain('npg_f2_ssg');
    });

    it('groups by case correctly', () => {
      createLogFile(['dsp_sys', 'test_case_npg_f1_ssg', 'test_case_1', 'log', 'vio_summary.log']);
      createLogFile(['dsp_sys', 'test_case_npg_f2_ssg', 'test_case_2', 'log', 'vio_summary.log']);
      createLogFile(['dsp_sys', 'other_case_npg_f2_ssg', 'other_case_1', 'log', 'vio_summary.log']);

      const result = scanRegressionDirectory(tempDir, true);
      expect(Object.keys(result.caseGroups)).toContain('test_case');
      expect(Object.keys(result.caseGroups)).toContain('other_case');
      expect(result.caseGroups['test_case'].length).toBe(2);
    });

    it('detects PASS status when sprd_log_pass.log exists', () => {
      const filePath = createLogFile(['dsp_sys', 'test_case_npg_f1_ssg', 'test_case_1', 'log', 'vio_summary.log']);
      // Create sprd_log_pass.log in the same log directory
      createPassLog(['dsp_sys', 'test_case_npg_f1_ssg', 'test_case_1', 'log', 'sprd_log_pass.log']);

      const result = scanRegressionDirectory(tempDir, true);
      expect(result.validFiles[0].caseStatus).toBe('PASS');
    });

    it('detects FAIL status when sprd_log_pass.log does not exist', () => {
      createLogFile(['dsp_sys', 'test_case_npg_f1_ssg', 'test_case_1', 'log', 'vio_summary.log']);

      const result = scanRegressionDirectory(tempDir, true);
      expect(result.validFiles[0].caseStatus).toBe('FAIL');
    });

    it('captures file size and modified time', () => {
      createLogFile(['dsp_sys', 'test_case_npg_f1_ssg', 'test_case_1', 'log', 'vio_summary.log']);

      const result = scanRegressionDirectory(tempDir, true);
      expect(result.validFiles[0].fileSize).toBeGreaterThan(0);
      expect(result.validFiles[0].modifiedTime).toBeTruthy();
    });

    it('returns empty result for directory with no vio_summary.log files', () => {
      mkdirSync(join(tempDir, 'empty_dir'), { recursive: true });

      const result = scanRegressionDirectory(tempDir, true);
      expect(result.totalFiles).toBe(0);
      expect(result.validFiles.length).toBe(0);
    });

    it('throws error when regression root does not exist', () => {
      expect(() => scanRegressionDirectory(join(tempDir, 'nonexistent'), true)).toThrow();
    });

    it('supports flexible mode scanning', () => {
      createLogFile(['any_dir', 'test_case_1', 'log', 'vio_summary.log']);
      createLogFile(['other_dir', 'other_case_2', 'log', 'vio_summary.log']);

      const result = scanRegressionDirectory(tempDir, false);
      expect(result.totalFiles).toBe(2);
      expect(result.validFiles.length).toBe(2);
    });

    it('groups by status (PASS/FAIL)', () => {
      createLogFile(['dsp_sys', 'pass_case_npg_f1_ssg', 'pass_case_1', 'log', 'vio_summary.log']);
      createPassLog(['dsp_sys', 'pass_case_npg_f1_ssg', 'pass_case_1', 'log', 'sprd_log_pass.log']);

      createLogFile(['dsp_sys', 'fail_case_npg_f1_ssg', 'fail_case_1', 'log', 'vio_summary.log']);

      const result = scanRegressionDirectory(tempDir, true);
      expect(Object.keys(result.statusGroups)).toContain('PASS');
      expect(Object.keys(result.statusGroups)).toContain('FAIL');
      expect(result.statusGroups['PASS'].length).toBe(1);
      expect(result.statusGroups['FAIL'].length).toBe(1);
    });
  });
});
