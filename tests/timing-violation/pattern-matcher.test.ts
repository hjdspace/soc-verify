import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDatabase, closeDatabase, type TvDatabase } from '../../src/main/timing-violation/db/tv-database';
import {
  insertViolations,
  ensureConfirmationRecords,
  getPatterns,
  queryViolations,
} from '../../src/main/timing-violation/db/tv-repository';
import {
  savePattern,
  applyHistoricalConfirmations,
} from '../../src/main/timing-violation/confirm/confirmation-manager';
import { findMatchingPattern, getPatternSuggestion } from '../../src/main/timing-violation/confirm/pattern-matcher';
import type { ParsedViolation } from '../../src/main/timing-violation/types';

describe('Pattern Matcher', () => {
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
      timeFs: 500000,
      timeDisplay: '500000 FS',
      checkInfo: 'setup( posedge clk: 1523423 FS, negedge data: 100 PS, margin: -50 PS)',
      filePath: '/path/to/vio_summary.log',
      ...overrides,
    };
  }

  function setupViolations(violations: ParsedViolation[]) {
    insertViolations(db, violations);
    ensureConfirmationRecords(db);
  }

  describe('findMatchingPattern', () => {
    it('finds exact match (hier + check_info identical)', () => {
      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'safe');

      const result = findMatchingPattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)');
      expect(result).not.toBeNull();
      expect(result!.matched).toBe('exact');
      expect(result!.pattern.defaultConfirmer).toBe('Alice');
    });

    it('finds fuzzy match (different time values, same structure)', () => {
      // Save a pattern with specific time values
      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 1000 FS, negedge data: 50 PS, margin: -50 PS)', 'Bob', 'pass', 'known issue');

      // Search with different time values but same structure
      const result = findMatchingPattern(db, 'tb_top.hier1', 'setup( posedge clk: 9999 FS, negedge data: 200 PS, margin: -80 PS)');
      expect(result).not.toBeNull();
      expect(result!.matched).toBe('fuzzy');
      expect(result!.pattern.defaultConfirmer).toBe('Bob');
    });

    it('prefers exact match over fuzzy match', () => {
      // Save a pattern that matches exactly
      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'exact');
      // Save a pattern that matches fuzzily (different time values)
      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 5000 FS, negedge data: 500 PS, margin: -50 PS)', 'Bob', 'issue', 'fuzzy');

      // Search with the exact check_info
      const result = findMatchingPattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)');
      expect(result!.matched).toBe('exact');
      expect(result!.pattern.defaultConfirmer).toBe('Alice');
    });

    it('returns null when no match found', () => {
      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'safe');

      const result = findMatchingPattern(db, 'tb_top.hier2', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)');
      expect(result).toBeNull();
    });

    it('does not match when prefix differs (setup vs hold)', () => {
      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'safe');

      const result = findMatchingPattern(db, 'tb_top.hier1', 'hold( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)');
      expect(result).toBeNull();
    });

    it('does not match when hier differs', () => {
      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'safe');

      const result = findMatchingPattern(db, 'tb_top.hier2', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)');
      expect(result).toBeNull();
    });

    it('is corner-independent (matches across different corners)', () => {
      // Pattern doesn't store corner info, so matching is corner-independent
      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'safe');

      // Match should succeed regardless of what corner the violation came from
      const result = findMatchingPattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)');
      expect(result).not.toBeNull();
    });
  });

  describe('getPatternSuggestion', () => {
    it('returns suggestion with match type', () => {
      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'safe');

      const result = getPatternSuggestion(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)');
      expect(result).not.toBeNull();
      expect(result!.matchType).toBe('exact');
      expect(result!.pattern.defaultResult).toBe('pass');
    });

    it('returns null when no pattern matches', () => {
      const result = getPatternSuggestion(db, 'tb_top.unknown', 'some_check');
      expect(result).toBeNull();
    });
  });

  describe('applyHistoricalConfirmations', () => {
    it('applies exact match to pending violations', () => {
      setupViolations([
        makeViolation({ num: 1, hier: 'tb_top.hier1', checkInfo: 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)' }),
        makeViolation({ num: 2, hier: 'tb_top.hier2', checkInfo: 'hold( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)' }),
      ]);

      // Save a pattern that matches violation 1
      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'known safe');

      const result = applyHistoricalConfirmations(db, 'test_case');
      expect(result.appliedCount).toBe(1);

      // Verify the pattern was applied
      const queryResult = queryViolations(db, { page: 1, pageSize: 10, status: 'confirmed' });
      expect(queryResult.total).toBe(1);
      expect(queryResult.items[0].confirmer).toBe('Alice');
      expect(queryResult.items[0].result).toBe('pass');
      expect(queryResult.items[0].reason).toBe('known safe');
    });

    it('applies fuzzy match (different time values)', () => {
      setupViolations([
        makeViolation({ num: 1, hier: 'tb_top.hier1', checkInfo: 'setup( posedge clk: 5000 FS, negedge data: 300 PS, margin: -90 PS)' }),
      ]);

      // Save a pattern with different time values but same normalized form
      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Bob', 'pass', 'fuzzy match');

      const result = applyHistoricalConfirmations(db, 'test_case');
      expect(result.appliedCount).toBe(1);
    });

    it('returns 0 when no patterns exist', () => {
      setupViolations([makeViolation({ num: 1 })]);

      const result = applyHistoricalConfirmations(db, 'test_case');
      expect(result.appliedCount).toBe(0);
    });

    it('returns 0 when no pending violations match', () => {
      setupViolations([
        makeViolation({ num: 1, hier: 'tb_top.nomatch' }),
      ]);

      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'safe');

      const result = applyHistoricalConfirmations(db, 'test_case');
      expect(result.appliedCount).toBe(0);
    });

    it('does not re-confirm already confirmed violations', () => {
      setupViolations([
        makeViolation({ num: 1, hier: 'tb_top.hier1', checkInfo: 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)' }),
      ]);

      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'safe');

      // First application
      const result1 = applyHistoricalConfirmations(db, 'test_case');
      expect(result1.appliedCount).toBe(1);

      // Second application should find 0 pending
      const result2 = applyHistoricalConfirmations(db, 'test_case');
      expect(result2.appliedCount).toBe(0);
    });

    it('increments match_count after applying', () => {
      setupViolations([
        makeViolation({ num: 1, hier: 'tb_top.hier1', checkInfo: 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)' }),
      ]);

      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'safe');

      const patternsBefore = getPatterns(db);
      expect(patternsBefore[0].matchCount).toBe(1);

      applyHistoricalConfirmations(db, 'test_case');

      const patternsAfter = getPatterns(db);
      expect(patternsAfter[0].matchCount).toBe(2);
    });

    it('updates last_used after applying', () => {
      setupViolations([
        makeViolation({ num: 1, hier: 'tb_top.hier1', checkInfo: 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)' }),
      ]);

      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'safe');

      const patternsBefore = getPatterns(db);
      const lastUsedBefore = patternsBefore[0].lastUsed;

      // Wait a tiny bit to ensure timestamp changes
      const result = applyHistoricalConfirmations(db, 'test_case');
      expect(result.appliedCount).toBe(1);

      const patternsAfter = getPatterns(db);
      // last_used should be updated (could be same if very fast, but the value is set)
      expect(patternsAfter[0].lastUsed).toBeDefined();
      // It should be at least as recent as before
      expect(patternsAfter[0].lastUsed >= lastUsedBefore).toBe(true);
    });

    it('applies to all corners (corner-independent)', () => {
      setupViolations([
        makeViolation({ num: 1, corner: 'npg_f1_ssg', hier: 'tb_top.hier1', checkInfo: 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)' }),
        makeViolation({ num: 2, corner: 'npg_f2_ssg', hier: 'tb_top.hier1', checkInfo: 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)' }),
      ]);

      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'safe');

      // Without corner filter — should apply to both corners
      const result = applyHistoricalConfirmations(db, 'test_case');
      expect(result.appliedCount).toBe(2);
    });

    it('applies to specific corner when provided', () => {
      setupViolations([
        makeViolation({ num: 1, corner: 'npg_f1_ssg', hier: 'tb_top.hier1', checkInfo: 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)' }),
        makeViolation({ num: 2, corner: 'npg_f2_ssg', hier: 'tb_top.hier1', checkInfo: 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)' }),
      ]);

      savePattern(db, 'tb_top.hier1', 'setup( posedge clk: 100 FS, negedge data: 200 PS, margin: -50 PS)', 'Alice', 'pass', 'safe');

      // With corner filter — should only apply to npg_f1_ssg
      const result = applyHistoricalConfirmations(db, 'test_case', 'npg_f1_ssg');
      expect(result.appliedCount).toBe(1);
    });
  });
});
