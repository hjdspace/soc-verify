import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDatabase, closeDatabase, type TvDatabase } from '../../src/main/timing-violation/db/tv-database';
import {
  insertViolations,
  ensureConfirmationRecords,
  queryViolations,
  getPatterns,
} from '../../src/main/timing-violation/db/tv-repository';
import {
  autoConfirmByResetTime,
  autoConfirmByInterval,
  updateConfirmation,
  batchUpdateConfirmations,
  savePattern,
  applyHistoricalConfirmations,
} from '../../src/main/timing-violation/confirm/confirmation-manager';
import type { ParsedViolation } from '../../src/main/timing-violation/types';

describe('Confirmation Manager', () => {
  let db: TvDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function makeViolation(overrides: Partial<ParsedViolation> = {}): ParsedViolation {
    return {
      caseName: 'test_case',
      corner: 'npg_f1_ssg',
      seed: '1',
      subsys: 'dsp_sys',
      num: 1,
      hier: 'tb_top.dut.reg',
      timeFs: 500000, // 0.5 ns
      timeDisplay: '500000 FS',
      checkInfo: 'setup( posedge clk, negedge data, margin: -50 PS)',
      filePath: '/path/to/vio_summary.log',
      ...overrides,
    };
  }

  function setupViolations(violations: ParsedViolation[]) {
    insertViolations(db, violations);
    ensureConfirmationRecords(db);
  }

  // ─── autoConfirmByResetTime ───────────────────────────────

  describe('autoConfirmByResetTime', () => {
    beforeEach(() => {
      setupViolations([
        makeViolation({ num: 1, timeFs: 500000 }),   // 0.5 ns — ≤ 1 ns
        makeViolation({ num: 2, timeFs: 2000000, hier: 'tb_top.b' }),  // 2 ns — > 1 ns
        makeViolation({ num: 3, timeFs: 1000000, hier: 'tb_top.c' }),  // 1 ns — ≤ 1 ns
      ]);
    });

    it('confirms violations with time_fs <= reset_time_ns * 1000000', () => {
      const result = autoConfirmByResetTime(db, 'test_case', 1);
      expect(result.confirmedCount).toBe(2);
    });

    it('marks confirmed violations as "系统自动"', () => {
      autoConfirmByResetTime(db, 'test_case', 1);
      const queryResult = queryViolations(db, { page: 1, pageSize: 10, status: 'confirmed' });
      const autoConfirmed = queryResult.items.filter((v) => v.confirmer === '系统自动');
      expect(autoConfirmed.length).toBe(2);
    });

    it('sets reason with time condition', () => {
      autoConfirmByResetTime(db, 'test_case', 1);
      const queryResult = queryViolations(db, { page: 1, pageSize: 10, status: 'confirmed' });
      expect(queryResult.items[0].reason).toContain('复位期间时序违例');
      expect(queryResult.items[0].reason).toContain('<= 1ns');
    });

    it('sets result to pass', () => {
      autoConfirmByResetTime(db, 'test_case', 1);
      const queryResult = queryViolations(db, { page: 1, pageSize: 10, status: 'confirmed' });
      expect(queryResult.items.every((v) => v.result === 'pass')).toBe(true);
    });

    it('sets isAutoConfirmed to true', () => {
      autoConfirmByResetTime(db, 'test_case', 1);
      const queryResult = queryViolations(db, { page: 1, pageSize: 10, status: 'confirmed' });
      expect(queryResult.items.every((v) => v.isAutoConfirmed)).toBe(true);
    });

    it('does not confirm already confirmed violations', () => {
      // First confirm all ≤ 1ns
      autoConfirmByResetTime(db, 'test_case', 1);
      // Run again — should find 0 pending
      const result = autoConfirmByResetTime(db, 'test_case', 1);
      expect(result.confirmedCount).toBe(0);
    });

    it('confirms violations across all corners (no corner filter)', () => {
      setupViolations([
        makeViolation({ num: 10, corner: 'default', timeFs: 500000, hier: 'tb_top.default1' }),
        makeViolation({ num: 11, corner: 'ffg_cloud', timeFs: 800000, hier: 'tb_top.ffg1' }),
      ]);
      // All pending violations with time ≤ 1ns across all corners should be confirmed
      const result = autoConfirmByResetTime(db, 'test_case', 1);
      // num 1 (0.5ns, npg_f1_ssg), num 3 (1ns, npg_f1_ssg), num 10 (0.5ns, default), num 11 (0.8ns, ffg_cloud)
      expect(result.confirmedCount).toBe(4);
    });

    it('confirms violations for all cases when caseName is undefined', () => {
      setupViolations([
        makeViolation({ num: 10, caseName: 'other_case', timeFs: 500000, hier: 'tb_top.other1' }),
        makeViolation({ num: 11, caseName: 'third_case', timeFs: 800000, hier: 'tb_top.third1' }),
      ]);
      // Global auto-confirm: all cases, all corners
      const result = autoConfirmByResetTime(db, undefined, 1);
      // num 1 (0.5ns, test_case), num 3 (1ns, test_case), num 10 (0.5ns, other_case), num 11 (0.8ns, third_case)
      expect(result.confirmedCount).toBe(4);
    });

    it('returns 0 when no matching violations found', () => {
      const result = autoConfirmByResetTime(db, 'nonexistent_case', 1000);
      expect(result.confirmedCount).toBe(0);
    });

    it('returns 0 when reset time is 0 and no violations at time 0', () => {
      const result = autoConfirmByResetTime(db, 'test_case', 0);
      // No violations with time_fs <= 0
      expect(result.confirmedCount).toBe(0);
    });
  });

  // ─── autoConfirmByInterval ────────────────────────────────

  describe('autoConfirmByInterval', () => {
    beforeEach(() => {
      setupViolations([
        makeViolation({ num: 1, timeFs: 500000 }),   // 0.5 ns
        makeViolation({ num: 2, timeFs: 2000000, hier: 'tb_top.b' }),  // 2 ns
        makeViolation({ num: 3, timeFs: 3000000, hier: 'tb_top.c' }),  // 3 ns
        makeViolation({ num: 4, timeFs: 5000000, hier: 'tb_top.d' }),  // 5 ns
      ]);
    });

    it('confirms violations in interval only', () => {
      const result = autoConfirmByInterval(db, 'test_case', undefined, 2, 3);
      // 2ns and 3ns violations
      expect(result.confirmedCount).toBe(2);
    });

    it('confirms violations by reset time only', () => {
      const result = autoConfirmByInterval(db, 'test_case', 1, undefined, undefined);
      // Only 0.5ns
      expect(result.confirmedCount).toBe(1);
    });

    it('confirms with OR relationship (reset time OR interval)', () => {
      const result = autoConfirmByInterval(db, 'test_case', 1, 4, 5);
      // ≤1ns (0.5ns) OR 4~5ns (5ns)
      expect(result.confirmedCount).toBe(2);
    });

    it('returns 0 when no conditions provided', () => {
      const result = autoConfirmByInterval(db, 'test_case', undefined, undefined, undefined);
      expect(result.confirmedCount).toBe(0);
    });

    it('confirms across all corners (no corner filter)', () => {
      setupViolations([
        makeViolation({ num: 10, corner: 'default', timeFs: 500000, hier: 'tb_top.default1' }),
        makeViolation({ num: 11, corner: 'ffg_cloud', timeFs: 800000, hier: 'tb_top.ffg1' }),
      ]);
      const result = autoConfirmByInterval(db, 'test_case', 1, undefined, undefined);
      // All ≤ 1ns: num 1 (0.5ns), num 10 (0.5ns), num 11 (0.8ns)
      expect(result.confirmedCount).toBe(3);
    });

    it('confirms for all cases when caseName is undefined', () => {
      setupViolations([
        makeViolation({ num: 10, caseName: 'other_case', timeFs: 500000, hier: 'tb_top.other1' }),
        makeViolation({ num: 11, caseName: 'third_case', timeFs: 800000, hier: 'tb_top.third1' }),
      ]);
      const result = autoConfirmByInterval(db, undefined, 1, undefined, undefined);
      // All ≤ 1ns: num 1 (0.5ns, test_case), num 10 (0.5ns, other_case), num 11 (0.8ns, third_case)
      expect(result.confirmedCount).toBe(3);
    });

    it('includes both conditions in reason', () => {
      autoConfirmByInterval(db, 'test_case', 1, 2, 3);
      const queryResult = queryViolations(db, { page: 1, pageSize: 10, status: 'confirmed' });
      const reasons = queryResult.items.map((v) => v.reason);
      // At least one reason should mention both conditions
      expect(reasons.some((r) => r && r.includes('复位期间') && r.includes('复位区间'))).toBe(true);
    });
  });

  // ─── updateConfirmation (manual) ──────────────────────────

  describe('updateConfirmation', () => {
    beforeEach(() => {
      setupViolations([
        makeViolation({ num: 1 }),
        makeViolation({ num: 2, hier: 'tb_top.b' }),
      ]);
    });

    it('updates confirmation status, confirmer, result, and reason', () => {
      const result = updateConfirmation(db, 1, 'confirmed', 'Alice', 'pass', 'This is safe');
      expect(result.success).toBe(true);

      const queryResult = queryViolations(db, { page: 1, pageSize: 10 });
      const v = queryResult.items.find((item) => item.id === 1);
      expect(v?.status).toBe('confirmed');
      expect(v?.confirmer).toBe('Alice');
      expect(v?.result).toBe('pass');
      expect(v?.reason).toBe('This is safe');
      expect(v?.isAutoConfirmed).toBe(false);
    });

    it('can mark violation as ignored', () => {
      updateConfirmation(db, 1, 'ignored', 'Bob', 'issue', 'Will fix later');
      const queryResult = queryViolations(db, { page: 1, pageSize: 10 });
      const v = queryResult.items.find((item) => item.id === 1);
      expect(v?.status).toBe('ignored');
    });

    it('saves Pattern after confirmation', () => {
      updateConfirmation(db, 1, 'confirmed', 'Alice', 'pass', 'Safe');

      // Pattern should be saved
      const patterns = getPatterns(db);
      expect(patterns.length).toBe(1);
      expect(patterns[0].hierPattern).toBe('tb_top.dut.reg');
      expect(patterns[0].defaultConfirmer).toBe('Alice');
      expect(patterns[0].defaultResult).toBe('pass');
      expect(patterns[0].matchCount).toBe(1);
    });

    it('can edit existing confirmation', () => {
      // First confirm
      updateConfirmation(db, 1, 'confirmed', 'Alice', 'pass', 'Safe');
      // Then edit
      updateConfirmation(db, 1, 'confirmed', 'Bob', 'issue', 'Actually has issue');

      const queryResult = queryViolations(db, { page: 1, pageSize: 10 });
      const v = queryResult.items.find((item) => item.id === 1);
      expect(v?.confirmer).toBe('Bob');
      expect(v?.result).toBe('issue');
      expect(v?.reason).toBe('Actually has issue');
    });
  });

  // ─── batchUpdateConfirmations ─────────────────────────────

  describe('batchUpdateConfirmations', () => {
    beforeEach(() => {
      setupViolations([
        makeViolation({ num: 1, hier: 'tb_top.a' }),
        makeViolation({ num: 2, hier: 'tb_top.b' }),
        makeViolation({ num: 3, hier: 'tb_top.c' }),
      ]);
    });

    it('updates multiple violations at once', () => {
      const result = batchUpdateConfirmations(db, [1, 2, 3], 'confirmed', 'Charlie', 'pass', 'All safe');
      expect(result.updatedCount).toBe(3);

      const queryResult = queryViolations(db, { page: 1, pageSize: 10 });
      expect(queryResult.items.every((v) => v.confirmer === 'Charlie')).toBe(true);
      expect(queryResult.items.every((v) => v.result === 'pass')).toBe(true);
    });

    it('returns 0 for empty array', () => {
      const result = batchUpdateConfirmations(db, [], 'confirmed', 'Charlie', 'pass', 'test');
      expect(result.updatedCount).toBe(0);
    });

    it('saves Pattern for each violation', () => {
      batchUpdateConfirmations(db, [1, 2, 3], 'confirmed', 'Charlie', 'pass', 'All safe');

      const patterns = getPatterns(db);
      expect(patterns.length).toBe(3);
    });

    it('can batch mark as ignored', () => {
      batchUpdateConfirmations(db, [1, 2], 'ignored', 'Charlie', 'issue', 'Will fix');
      const queryResult = queryViolations(db, { page: 1, pageSize: 10, status: 'ignored' });
      expect(queryResult.total).toBe(2);
    });

    it('increments match_count when same pattern saved again', () => {
      // Save pattern once
      savePattern(db, 'tb_top.a', 'check_a', 'Alice', 'pass', 'safe');
      // Save same pattern again
      savePattern(db, 'tb_top.a', 'check_a', 'Bob', 'issue', 'has issue');

      const patterns = getPatterns(db);
      expect(patterns.length).toBe(1);
      expect(patterns[0].matchCount).toBe(2);
      // Latest confirmer/result/reason should be used
      expect(patterns[0].defaultConfirmer).toBe('Bob');
      expect(patterns[0].defaultResult).toBe('issue');
    });
  });

  // ─── savePattern ──────────────────────────────────────────

  describe('savePattern', () => {
    it('inserts new pattern', () => {
      savePattern(db, 'tb_top.hier1', 'check1', 'Alice', 'pass', 'safe');
      const patterns = getPatterns(db);
      expect(patterns.length).toBe(1);
      expect(patterns[0].hierPattern).toBe('tb_top.hier1');
      expect(patterns[0].checkPattern).toBe('check1');
      expect(patterns[0].matchCount).toBe(1);
    });

    it('increments match_count for existing pattern', () => {
      savePattern(db, 'tb_top.hier1', 'check1', 'Alice', 'pass', 'safe');
      savePattern(db, 'tb_top.hier1', 'check1', 'Alice', 'pass', 'safe');
      savePattern(db, 'tb_top.hier1', 'check1', 'Alice', 'pass', 'safe');
      const patterns = getPatterns(db);
      expect(patterns.length).toBe(1);
      expect(patterns[0].matchCount).toBe(3);
    });
  });

  // ─── applyHistoricalConfirmations ─────────────────────────

  describe('applyHistoricalConfirmations', () => {
    it('returns 0 when no patterns exist', () => {
      setupViolations([makeViolation({ num: 1 })]);
      const result = applyHistoricalConfirmations(db, 'test_case');
      expect(result.appliedCount).toBe(0);
    });

    it('applies exact match patterns for a specific case', () => {
      setupViolations([
        makeViolation({ num: 1, hier: 'tb_top.match1', checkInfo: 'setup(clk, data, margin: -50 PS)' }),
        makeViolation({ num: 2, hier: 'tb_top.no_match', checkInfo: 'hold(clk, data, margin: -20 PS)' }),
      ]);
      // Save a pattern matching violation 1
      savePattern(db, 'tb_top.match1', 'setup(clk, data, margin: -50 PS)', 'Alice', 'pass', 'safe');

      const result = applyHistoricalConfirmations(db, 'test_case');
      expect(result.appliedCount).toBe(1);

      // Verify the violation was confirmed
      const queryResult = queryViolations(db, { page: 1, pageSize: 10, status: 'confirmed' });
      expect(queryResult.total).toBe(1);
      expect(queryResult.items[0].hier).toBe('tb_top.match1');
      expect(queryResult.items[0].confirmer).toBe('Alice');
    });

    it('applies patterns to ALL pending violations when caseName is undefined', () => {
      setupViolations([
        makeViolation({ num: 1, caseName: 'case_a', hier: 'tb_top.hier_a', checkInfo: 'setup(clk, data, margin: -50 PS)' }),
        makeViolation({ num: 2, caseName: 'case_b', hier: 'tb_top.hier_b', checkInfo: 'hold(clk, data, margin: -20 PS)' }),
        makeViolation({ num: 3, caseName: 'case_c', hier: 'tb_top.hier_a', checkInfo: 'setup(clk, data, margin: -50 PS)' }),
      ]);
      // Save patterns matching violations 1 and 3 (same hier+check)
      savePattern(db, 'tb_top.hier_a', 'setup(clk, data, margin: -50 PS)', 'Bob', 'pass', 'known safe');
      savePattern(db, 'tb_top.hier_b', 'hold(clk, data, margin: -20 PS)', 'Charlie', 'issue', 'needs fix');

      // Global apply — no caseName filter
      const result = applyHistoricalConfirmations(db);
      expect(result.appliedCount).toBe(3);

      // All should be confirmed
      const queryResult = queryViolations(db, { page: 1, pageSize: 10, status: 'confirmed' });
      expect(queryResult.total).toBe(3);
    });

    it('does not re-confirm already confirmed violations', () => {
      setupViolations([
        makeViolation({ num: 1, hier: 'tb_top.hier_a', checkInfo: 'setup(clk, data, margin: -50 PS)' }),
      ]);
      savePattern(db, 'tb_top.hier_a', 'setup(clk, data, margin: -50 PS)', 'Alice', 'pass', 'safe');

      // First application
      const result1 = applyHistoricalConfirmations(db);
      expect(result1.appliedCount).toBe(1);

      // Second application — no more pending
      const result2 = applyHistoricalConfirmations(db);
      expect(result2.appliedCount).toBe(0);
    });

    it('applies fuzzy match patterns', () => {
      setupViolations([
        // Violation has different time in check_info but same structure
        makeViolation({ num: 1, hier: 'tb_top.fuzzy', checkInfo: 'setup(posedge clk, negedge data, margin: -100 PS)' }),
      ]);
      // Pattern has different time value but same structure after normalization
      savePattern(db, 'tb_top.fuzzy', 'setup(posedge clk, negedge data, margin: -50 PS)', 'Alice', 'pass', 'fuzzy match');

      const result = applyHistoricalConfirmations(db, 'test_case');
      expect(result.appliedCount).toBe(1);

      const queryResult = queryViolations(db, { page: 1, pageSize: 10, status: 'confirmed' });
      expect(queryResult.items[0].confirmer).toBe('Alice');
    });

    it('increments match_count after applying', () => {
      setupViolations([
        makeViolation({ num: 1, hier: 'tb_top.hier_a', checkInfo: 'setup(clk, data, margin: -50 PS)' }),
        makeViolation({ num: 2, caseName: 'other_case', hier: 'tb_top.hier_a', checkInfo: 'setup(clk, data, margin: -50 PS)' }),
      ]);
      savePattern(db, 'tb_top.hier_a', 'setup(clk, data, margin: -50 PS)', 'Alice', 'pass', 'safe');

      // Global apply — should match both violations
      const result = applyHistoricalConfirmations(db);
      expect(result.appliedCount).toBe(2);

      // Pattern's match_count should have been incremented twice
      const patterns = getPatterns(db);
      expect(patterns[0].matchCount).toBe(3); // 1 initial + 2 applied
    });
  });

  // ─── 大规模自动确认（验证 "too many SQL variables" 修复） ──

  describe('large-scale auto-confirm (exceeds SQLite variable limit)', () => {
    it('autoConfirmByResetTime handles >999 violations without "too many SQL variables"', () => {
      // 创建 1200 条违例（超过 SQLite 默认变量上限 999）
      const violations: ParsedViolation[] = [];
      for (let i = 1; i <= 1200; i++) {
        violations.push(
          makeViolation({
            num: i,
            timeFs: 500000, // 0.5ns — all within 1ns reset time
            hier: `tb_top.hier_${i}`,
          }),
        );
      }
      setupViolations(violations);

      // 自动确认 200ns 以内的所有违例（应匹配全部 1200 条）
      // 修复前会报 "too many SQL variables" 错误
      const result = autoConfirmByResetTime(db, 'test_case', 200);
      expect(result.confirmedCount).toBe(1200);

      // 验证所有违例都已确认
      const queryResult = queryViolations(db, { page: 1, pageSize: 2000, status: 'confirmed' });
      expect(queryResult.total).toBe(1200);
      expect(queryResult.items.every((v) => v.isAutoConfirmed)).toBe(true);
    });

    it('autoConfirmByInterval handles >999 violations without error', () => {
      const violations: ParsedViolation[] = [];
      for (let i = 1; i <= 1200; i++) {
        violations.push(
          makeViolation({
            num: i,
            timeFs: 500000,
            hier: `tb_top.hier_${i}`,
          }),
        );
      }
      setupViolations(violations);

      const result = autoConfirmByInterval(db, 'test_case', 200, undefined, undefined);
      expect(result.confirmedCount).toBe(1200);
    });

    it('batchUpdateConfirmations handles >999 violations without error', () => {
      const violations: ParsedViolation[] = [];
      for (let i = 1; i <= 1200; i++) {
        violations.push(
          makeViolation({
            num: i,
            hier: `tb_top.hier_${i}`,
          }),
        );
      }
      setupViolations(violations);

      // 获取所有违例 ID
      const queryResult = queryViolations(db, { page: 1, pageSize: 2000 });
      const allIds = queryResult.items.map((v) => v.id);

      const result = batchUpdateConfirmations(db, allIds, 'confirmed', 'Charlie', 'pass', 'All safe');
      expect(result.updatedCount).toBe(1200);
    });
  });
});
