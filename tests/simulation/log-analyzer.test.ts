import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  logAnalyzer,
  processCompileLog,
  processSimLog,
  determineErrorType,
  getCompileLogPath,
  getSimulationLogPath,
  checkSimulationStatus,
  formatCompileErrorsForAI,
  formatSimErrorsForAI,
} from '../../src/main/simulation/log-analyzer';

describe('LogAnalyzer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = require('node:os').tmpdir() + `/sv-log-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getCompileLogPath', () => {
    it('returns existing compile log path', () => {
      const caseName = 'test_case';
      const logDir = join(tmpDir, caseName, 'log');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'irun_compile.log'), 'test content');

      const path = getCompileLogPath(caseName, tmpDir);
      expect(path).toBe(join(tmpDir, caseName, 'log', 'irun_compile.log'));
    });

    it('returns default path when no log exists', () => {
      const path = getCompileLogPath('nonexistent_case', tmpDir);
      expect(path).toBe(join(tmpDir, 'nonexistent_case', 'log', 'irun_compile.log'));
    });

    it('tries multiple common paths', () => {
      const caseName = 'test_case2';
      const logDir = join(tmpDir, caseName, 'log');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'compile.log'), 'compile content');

      const path = getCompileLogPath(caseName, tmpDir);
      expect(existsSync(path)).toBe(true);
      expect(path).toContain('compile.log');
    });
  });

  describe('getSimulationLogPath', () => {
    it('returns existing simulation log path', () => {
      const caseName = 'sim_case';
      const logDir = join(tmpDir, caseName, 'log');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'vcs_sim.log'), 'sim content');

      const path = getSimulationLogPath(caseName, tmpDir);
      expect(path).toBe(join(tmpDir, caseName, 'log', 'vcs_sim.log'));
    });

    it('returns default path when no log exists', () => {
      const path = getSimulationLogPath('nonexistent', tmpDir);
      expect(path).toBe(join(tmpDir, 'nonexistent', 'log', 'irun_sim.log'));
    });
  });

  describe('checkSimulationStatus', () => {
    it('returns PASS when sprd_log_pass.log exists', () => {
      const logDir = join(tmpDir, 'case_pass', 'log');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'sprd_log_pass.log'), '');
      const simLogPath = join(logDir, 'irun_sim.log');

      expect(checkSimulationStatus(simLogPath)).toBe('PASS');
    });

    it('returns FAIL when sprd_log_fail.log exists', () => {
      const logDir = join(tmpDir, 'case_fail', 'log');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'sprd_log_fail.log'), '');
      const simLogPath = join(logDir, 'irun_sim.log');

      expect(checkSimulationStatus(simLogPath)).toBe('FAIL');
    });

    it('returns On-Going when neither pass nor fail log exists', () => {
      const logDir = join(tmpDir, 'case_ongoing', 'log');
      mkdirSync(logDir, { recursive: true });
      const simLogPath = join(logDir, 'irun_sim.log');

      expect(checkSimulationStatus(simLogPath)).toBe('On-Going');
    });
  });

  describe('processCompileLog', () => {
    it('extracts Xcelium compile errors', () => {
      const logPath = join(tmpDir, 'compile_xcelium.log');
      const logContent = [
        'Starting compilation...',
        'xmelab: *E,EXTRA (test.sv,10|5): syntax error, unexpected token',
        'some other line',
        'xmelab: *F,FATAL (test2.sv,20): fatal error',
        'Compilation finished.',
      ].join('\n');
      writeFileSync(logPath, logContent);

      const result = processCompileLog(logPath, { contextLines: 2, maxErrors: 5 });

      expect(result.toolType).toBe('xcelium');
      expect(result.totalErrors).toBe(2);
      expect(result.errors).toHaveLength(2);
      const errors = result.errors as Array<{ tool: string; errorCode: string; errorType?: string }>;
      expect(errors[0].tool).toBe('Xcelium');
      expect(errors[0].errorCode).toBe('EXTRA');
      expect(errors[0].errorType).toBe('E');
    });

    it('extracts VCS compile errors', () => {
      const logPath = join(tmpDir, 'compile_vcs.log');
      const logContent = [
        'VCS compilation started',
        'Error-[SV-BC] syntax error in test.sv',
        'Error-[NRX-G] another error here',
        'Compilation completed with errors',
      ].join('\n');
      writeFileSync(logPath, logContent);

      const result = processCompileLog(logPath, { contextLines: 2, maxErrors: 5 });

      expect(result.toolType).toBe('vcs');
      expect(result.totalErrors).toBe(2);
      expect(result.errors).toHaveLength(2);
      const errors = result.errors as Array<{ tool: string; errorCode: string }>;
      expect(errors[0].tool).toBe('VCS');
      expect(errors[0].errorCode).toBe('SV-BC');
    });

    it('returns zero errors for clean log', () => {
      const logPath = join(tmpDir, 'compile_clean.log');
      writeFileSync(logPath, 'Compilation successful!\nNo errors found.\n');

      const result = processCompileLog(logPath);

      expect(result.totalErrors).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('handles missing file gracefully', () => {
      const result = processCompileLog('/nonexistent/path/to/log');

      expect(result.totalErrors).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('respects maxErrors limit', () => {
      const logPath = join(tmpDir, 'compile_many_errors.log');
      const lines = ['start'];
      for (let i = 0; i < 20; i++) {
        lines.push(`Error-[CODE${i}] error number ${i}`);
      }
      lines.push('end');
      writeFileSync(logPath, lines.join('\n'));

      const result = processCompileLog(logPath, { maxErrors: 3 });

      expect(result.errors).toHaveLength(3);
      expect(result.totalErrors).toBe(20);
      expect(result.truncated).toBe(true);
    });
  });

  describe('processSimLog', () => {
    it('extracts UVM errors', () => {
      const logPath = join(tmpDir, 'sim_uvm.log');
      const logContent = [
        'Simulation started',
        'UVM_ERROR @ 100ns: test message at time 100',
        'UVM_FATAL @ 200ns: fatal issue found',
        'Simulation finished',
      ].join('\n');
      writeFileSync(logPath, logContent);

      const result = processSimLog(logPath, { contextLines: 2, maxErrors: 5 });

      expect(result.totalErrors).toBe(2);
      expect(result.errors).toHaveLength(2);
      const errors = result.errors as Array<{ tool: string; severity?: string }>;
      expect(errors[0].tool).toBe('UVM');
      expect(errors[0].severity).toBe('ERROR');
    });

    it('skips UVM summary lines with count 0', () => {
      const logPath = join(tmpDir, 'sim_uvm_summary.log');
      const logContent = [
        'UVM_ERROR @ 100ns: actual error message',
        'UVM_ERROR reports : 0',
        'Simulation done',
      ].join('\n');
      writeFileSync(logPath, logContent);

      const result = processSimLog(logPath, { maxErrors: 5 });

      const errors = result.errors as Array<{ tool: string; message: string }>;
      expect(errors.length).toBe(1);
      expect(errors[0].message).toBe('actual error message');
    });

    it('extracts SPRD errors', () => {
      const logPath = join(tmpDir, 'sim_sprd.log');
      const logContent = [
        'SPRD_ERROR @ 150ns: [TEST_CASE] sprd error found',
        'SPRD_FATAL @ 300ns: [TEST_CASE] sprd fatal error',
        'Simulation PASSED on',
      ].join('\n');
      writeFileSync(logPath, logContent);

      const result = processSimLog(logPath, { maxErrors: 5 });

      expect(result.totalErrors).toBeGreaterThanOrEqual(1);
      const errors = result.errors as Array<{ tool: string; severity?: string }>;
      expect(errors.some((e) => e.tool === 'SPRD')).toBe(true);
    });

    it('extracts VCS *E errors', () => {
      const logPath = join(tmpDir, 'sim_vcs.log');
      const logContent = [
        'Simulation started',
        '*E, some vcs error message, test.sv',
        'Simulation done',
      ].join('\n');
      writeFileSync(logPath, logContent);

      const result = processSimLog(logPath, { maxErrors: 5 });

      const errors = result.errors as Array<{ tool: string; errorType?: string }>;
      expect(errors.some((e) => e.tool === 'VCS' && e.errorType === '*E')).toBe(true);
    });

    it('returns zero errors for clean simulation log', () => {
      const logPath = join(tmpDir, 'sim_clean.log');
      writeFileSync(logPath, 'Simulation passed!\nAll tests OK.\n');

      const result = processSimLog(logPath);

      expect(result.totalErrors).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('determineErrorType', () => {
    it('returns compile_error when compile log has errors', () => {
      const caseName = 'error_case';
      const logDir = join(tmpDir, caseName, 'log');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(
        join(logDir, 'irun_compile.log'),
        'xmelab: *E,ERR (test.sv,5): compile error\n',
      );

      expect(determineErrorType(caseName, tmpDir)).toBe('compile_error');
    });

    it('returns sim_error when compile log has no errors', () => {
      const caseName = 'sim_error_case';
      const logDir = join(tmpDir, caseName, 'log');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'irun_compile.log'), 'Compilation successful!\n');

      expect(determineErrorType(caseName, tmpDir)).toBe('sim_error');
    });

    it('returns sim_error when compile log does not exist', () => {
      expect(determineErrorType('nonexistent_case', tmpDir)).toBe('sim_error');
    });
  });

  describe('formatCompileErrorsForAI', () => {
    it('formats compile errors for AI consumption', () => {
      const logPath = join(tmpDir, 'compile_format.log');
      writeFileSync(logPath, 'xmelab: *E,ERR (test.sv,5): test error\n');
      const result = processCompileLog(logPath);
      const formatted = formatCompileErrorsForAI(result);

      expect(formatted).toContain('=== EDA 编译 LOG 预处理结果 ===');
      expect(formatted).toContain('Xcelium');
      expect(formatted).toContain('ERR');
      expect(formatted).toContain('test error');
    });
  });

  describe('formatSimErrorsForAI', () => {
    it('formats simulation errors for AI consumption', () => {
      const logPath = join(tmpDir, 'sim_format.log');
      writeFileSync(logPath, 'UVM_ERROR @ 100ns: test error\n');
      const result = processSimLog(logPath);
      const formatted = formatSimErrorsForAI(result);

      expect(formatted).toContain('=== EDA 仿真 LOG 预处理结果 ===');
      expect(formatted).toContain('UVM');
      expect(formatted).toContain('test error');
    });
  });

  describe('logAnalyzer.analyzeErrors', () => {
    it('returns compile error type and context for compile failures', () => {
      const caseName = 'analyze_compile';
      const logDir = join(tmpDir, caseName, 'log');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(
        join(logDir, 'irun_compile.log'),
        'xmelab: *E,ERR (test.sv,5): compile error\n',
      );

      const result = logAnalyzer.analyzeErrors(caseName, tmpDir);

      expect(result.errorType).toBe('compile_error');
      expect(result.errorContext).toContain('编译');
      expect(result.errorContext).toContain('ERR');
    });

    it('returns sim error type and context for simulation failures', () => {
      const caseName = 'analyze_sim';
      const logDir = join(tmpDir, caseName, 'log');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'irun_compile.log'), 'Compilation successful!\n');
      writeFileSync(join(logDir, 'irun_sim.log'), 'UVM_ERROR @ 100ns: sim error\n');

      const result = logAnalyzer.analyzeErrors(caseName, tmpDir);

      expect(result.errorType).toBe('sim_error');
      expect(result.errorContext).toContain('仿真');
      expect(result.errorContext).toContain('sim error');
    });
  });
});
