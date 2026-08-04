import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryDatabase, closeDatabase, type TvDatabase } from '../../src/main/timing-violation/db/tv-database';
import {
  insertViolations,
  ensureConfirmationRecords,
  queryViolations,
  getStatistics,
  getMetadata,
  getDatabaseStats,
  clearCaseData,
  getPatterns,
  clearAllPatterns,
  updateCorner,
} from '../../src/main/timing-violation/db/tv-repository';
import type { ParsedViolation } from '../../src/main/timing-violation/types';

describe('Timing Violation Database', () => {
  let db: TvDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = createMemoryDatabase();
    tmpDir = tmpdir() + `/sv-tv-db-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeViolation(overrides: Partial<ParsedViolation> = {}): ParsedViolation {
    return {
      caseName: 'test_case',
      corner: 'npg_f1_ssg',
      seed: '1',
      subsys: 'dsp_sys',
      num: 1,
      hier: 'tb_top.dut.reg',
      timeFs: 1523423,
      timeDisplay: '1523423 FS',
      checkInfo: 'setup( posedge clk )',
      filePath: '/path/to/vio_summary.log',
      ...overrides,
    };
  }

  describe('insertViolations', () => {
    it('inserts violations and returns counts', () => {
      const violations = [
        makeViolation({ num: 1 }),
        makeViolation({ num: 2, hier: 'tb_top.dut.mem' }),
      ];
      const result = insertViolations(db, violations);
      expect(result.inserted).toBe(2);
      expect(result.skipped).toBe(0);
    });

    it('skips duplicates (INSERT OR IGNORE)', () => {
      const v1 = makeViolation({ num: 1 });
      insertViolations(db, [v1]);
      const result = insertViolations(db, [v1]);
      expect(result.inserted).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('handles empty array', () => {
      const result = insertViolations(db, []);
      expect(result.inserted).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  describe('ensureConfirmationRecords', () => {
    it('creates pending confirmation for violations without one', () => {
      insertViolations(db, [makeViolation({ num: 1 }), makeViolation({ num: 2, hier: 'tb_top.dut.mem' })]);
      const created = ensureConfirmationRecords(db);
      expect(created).toBe(2);
    });

    it('does not create duplicate confirmations', () => {
      insertViolations(db, [makeViolation({ num: 1 })]);
      ensureConfirmationRecords(db);
      const created = ensureConfirmationRecords(db);
      expect(created).toBe(0);
    });
  });

  describe('queryViolations', () => {
    beforeEach(() => {
      const violations = [
        makeViolation({ num: 1, timeFs: 100, hier: 'tb_top.a', caseName: 'case1', corner: 'c1', subsys: 'sys1' }),
        makeViolation({ num: 2, timeFs: 200, hier: 'tb_top.b', caseName: 'case1', corner: 'c2', subsys: 'sys1' }),
        makeViolation({ num: 3, timeFs: 300, hier: 'tb_top.c', caseName: 'case2', corner: 'c1', subsys: 'sys2' }),
      ];
      insertViolations(db, violations);
      ensureConfirmationRecords(db);
    });

    it('returns all violations with pagination', () => {
      const result = queryViolations(db, { page: 1, pageSize: 10 });
      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(3);
    });

    it('paginates correctly', () => {
      const page1 = queryViolations(db, { page: 1, pageSize: 2 });
      expect(page1.items).toHaveLength(2);
      const page2 = queryViolations(db, { page: 2, pageSize: 2 });
      expect(page2.items).toHaveLength(1);
    });

    it('filters by caseName', () => {
      const result = queryViolations(db, { page: 1, pageSize: 10, caseName: 'case1' });
      expect(result.total).toBe(2);
      expect(result.items.every((v) => v.caseName === 'case1')).toBe(true);
    });

    it('filters by corner', () => {
      const result = queryViolations(db, { page: 1, pageSize: 10, corner: 'c1' });
      expect(result.total).toBe(2);
    });

    it('filters by subsys', () => {
      const result = queryViolations(db, { page: 1, pageSize: 10, subsys: 'sys2' });
      expect(result.total).toBe(1);
    });

    it('filters by status (pending)', () => {
      const result = queryViolations(db, { page: 1, pageSize: 10, status: 'pending' });
      expect(result.total).toBe(3);
    });

    it('searches hier and check_info', () => {
      const result = queryViolations(db, { page: 1, pageSize: 10, searchText: 'tb_top.a' });
      expect(result.total).toBe(1);
      expect(result.items[0].hier).toBe('tb_top.a');
    });

    it('sorts by time_fs ascending', () => {
      const result = queryViolations(db, { page: 1, pageSize: 10, sortField: 'time_fs', sortOrder: 'asc' });
      expect(result.items[0].timeFs).toBe(100);
      expect(result.items[2].timeFs).toBe(300);
    });

    it('sorts by time_fs descending', () => {
      const result = queryViolations(db, { page: 1, pageSize: 10, sortField: 'time_fs', sortOrder: 'desc' });
      expect(result.items[0].timeFs).toBe(300);
      expect(result.items[2].timeFs).toBe(100);
    });

    it('returns confirmation status in results', () => {
      const result = queryViolations(db, { page: 1, pageSize: 10 });
      expect(result.items[0].status).toBe('pending');
    });
  });

  describe('getStatistics', () => {
    beforeEach(() => {
      insertViolations(db, [
        makeViolation({ num: 1, caseName: 'case1', corner: 'c1', subsys: 'sys1' }),
        makeViolation({ num: 2, caseName: 'case1', corner: 'c2', subsys: 'sys1' }),
        makeViolation({ num: 3, caseName: 'case2', corner: 'c1', subsys: 'sys2' }),
      ]);
      ensureConfirmationRecords(db);
    });

    it('returns correct totals', () => {
      const stats = getStatistics(db);
      expect(stats.total).toBe(3);
      expect(stats.pending).toBe(3);
      expect(stats.confirmed).toBe(0);
      expect(stats.ignored).toBe(0);
    });

    it('returns bySubsys distribution', () => {
      const stats = getStatistics(db);
      expect(stats.bySubsys['sys1']).toBe(2);
      expect(stats.bySubsys['sys2']).toBe(1);
    });

    it('returns byCorner distribution', () => {
      const stats = getStatistics(db);
      expect(stats.byCorner['c1']).toBe(2);
      expect(stats.byCorner['c2']).toBe(1);
    });

    it('returns byCase distribution', () => {
      const stats = getStatistics(db);
      expect(stats.byCase['case1']).toBe(2);
      expect(stats.byCase['case2']).toBe(1);
    });

    it('filters statistics by caseName', () => {
      const stats = getStatistics(db, { caseName: 'case1' });
      expect(stats.total).toBe(2);
    });
  });

  describe('getMetadata', () => {
    beforeEach(() => {
      insertViolations(db, [
        makeViolation({ num: 1, caseName: 'case1', corner: 'c1', subsys: 'sys1' }),
        makeViolation({ num: 2, caseName: 'case2', corner: 'c2', subsys: 'sys2' }),
      ]);
      ensureConfirmationRecords(db);
    });

    it('returns distinct corners', () => {
      const meta = getMetadata(db);
      expect(meta.corners).toContain('c1');
      expect(meta.corners).toContain('c2');
    });

    it('returns distinct cases', () => {
      const meta = getMetadata(db);
      expect(meta.cases).toContain('case1');
      expect(meta.cases).toContain('case2');
    });

    it('returns distinct subsys', () => {
      const meta = getMetadata(db);
      expect(meta.subsys).toContain('sys1');
      expect(meta.subsys).toContain('sys2');
    });
  });

  describe('getDatabaseStats', () => {
    it('returns database-level statistics', () => {
      insertViolations(db, [makeViolation({ num: 1 })]);
      ensureConfirmationRecords(db);
      const stats = getDatabaseStats(db);
      expect(stats.totalViolations).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.caseCount).toBe(1);
    });
  });

  describe('clearCaseData', () => {
    beforeEach(() => {
      insertViolations(db, [
        makeViolation({ num: 1, caseName: 'case1', corner: 'c1' }),
        makeViolation({ num: 2, caseName: 'case1', corner: 'c2' }),
        makeViolation({ num: 3, caseName: 'case2', corner: 'c1' }),
      ]);
      ensureConfirmationRecords(db);
    });

    it('clears all data for a case', () => {
      const result = clearCaseData(db, 'case1');
      expect(result.deleted).toBe(2);
      const stats = getDatabaseStats(db);
      expect(stats.totalViolations).toBe(1);
    });

    it('clears data for a case + specific corner', () => {
      const result = clearCaseData(db, 'case1', 'c1');
      expect(result.deleted).toBe(1);
      const stats = getDatabaseStats(db);
      expect(stats.totalViolations).toBe(2);
    });
  });

  describe('Full integration: parse → insert → query', () => {
    it('parses log file and stores in database', async () => {
      const { parseLogFile } = await import('../../src/main/timing-violation/parser/vio-parser');

      // Create a temp log file with proper regression directory structure
      // (needed for seed extraction so UNIQUE constraint deduplication works)
      const caseDir = join(tmpDir, 'test_case_npg_f1_ssg', 'test_case_1', 'log');
      mkdirSync(caseDir, { recursive: true });
      const logPath = join(caseDir, 'vio_summary.log');
      const content = [
        '------------------------------------------------------------',
        'NUM    : 1',
        'Hier   : tb_top.dut.reg',
        'Time   : 1523423 FS',
        'Check  : setup( posedge clk, negedge data )',
        '------------------------------------------------------------',
        '------------------------------------------------------------',
        'NUM    : 2',
        'Hier   : tb_top.dut.mem',
        'Time   : 100 PS',
        'Check  : hold( posedge clk )',
        '------------------------------------------------------------',
      ].join('\n');
      writeFileSync(logPath, content, 'utf-8');

      // Parse
      const parseResult = await parseLogFile(logPath, { caseName: 'test_case', corner: 'npg_f1_ssg' });
      expect(parseResult.violations).toHaveLength(2);

      // Insert
      const insertResult = insertViolations(db, parseResult.violations);
      expect(insertResult.inserted).toBe(2);

      // Ensure confirmations
      ensureConfirmationRecords(db);

      // Query (default sort is time_fs ascending: 100000 < 1523423)
      const queryResult = queryViolations(db, { page: 1, pageSize: 10 });
      expect(queryResult.total).toBe(2);
      expect(queryResult.items[0].hier).toBe('tb_top.dut.mem'); // 100 PS = 100000 fs (smaller)
      expect(queryResult.items[0].status).toBe('pending');

      // Parse same file again → should be deduplicated
      const parseResult2 = await parseLogFile(logPath, { caseName: 'test_case', corner: 'npg_f1_ssg' });
      const insertResult2 = insertViolations(db, parseResult2.violations);
      expect(insertResult2.inserted).toBe(0);
      expect(insertResult2.skipped).toBe(2);
    });
  });

  // ─── Pattern 管理测试 ──────────────────────────────────────

  describe('getPatterns', () => {
    it('returns empty array when no patterns exist', () => {
      const patterns = getPatterns(db);
      expect(patterns).toHaveLength(0);
    });

    it('returns all patterns ordered by last_used DESC', () => {
      db.prepare(`
        INSERT INTO violation_patterns (hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used)
        VALUES
          ('tb_top.a', 'check_a', 'Alice', 'pass', 'safe', 1, '2024-01-01 10:00:00'),
          ('tb_top.b', 'check_b', 'Bob', 'issue', 'has issue', 3, '2024-01-02 10:00:00')
      `).run();

      const patterns = getPatterns(db);
      expect(patterns).toHaveLength(2);
      // Ordered by last_used DESC — Bob's pattern is more recent
      expect(patterns[0].hierPattern).toBe('tb_top.b');
      expect(patterns[1].hierPattern).toBe('tb_top.a');
    });
  });

  describe('clearAllPatterns', () => {
    it('deletes all patterns', () => {
      db.prepare(`
        INSERT INTO violation_patterns (hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used)
        VALUES
          ('tb_top.a', 'check_a', 'Alice', 'pass', 'safe', 1, '2024-01-01 10:00:00'),
          ('tb_top.b', 'check_b', 'Bob', 'issue', 'has issue', 3, '2024-01-02 10:00:00')
      `).run();

      const result = clearAllPatterns(db);
      expect(result.deleted).toBe(2);

      const patterns = getPatterns(db);
      expect(patterns).toHaveLength(0);
    });
  });

  // ─── updateCorner 测试 ──────────────────────────────────────

  describe('updateCorner', () => {
    beforeEach(() => {
      insertViolations(db, [
        makeViolation({ num: 1, caseName: 'case1', corner: 'c1', hier: 'tb_top.a' }),
        makeViolation({ num: 2, caseName: 'case1', corner: 'c2', hier: 'tb_top.b' }),
        makeViolation({ num: 3, caseName: 'case2', corner: 'c1', hier: 'tb_top.c' }),
      ]);
      ensureConfirmationRecords(db);
    });

    it('updates corner for all violations of a case', () => {
      const result = updateCorner(db, 'case1', 'new_corner');
      expect(result.updated).toBe(2);
      const meta = getMetadata(db);
      expect(meta.corners).toContain('new_corner');
      expect(meta.corners).toContain('c1'); // case2 still has c1
      expect(meta.corners).not.toContain('c2'); // only case1 had c2
    });

    it('updates corner for specific old corner only', () => {
      const result = updateCorner(db, 'case1', 'new_corner', 'c1');
      expect(result.updated).toBe(1);
      const meta = getMetadata(db);
      expect(meta.corners).toContain('new_corner');
      expect(meta.corners).toContain('c2'); // c2 should still exist
      expect(meta.corners).toContain('c1'); // case2 still has c1
    });

    it('does not affect other cases', () => {
      updateCorner(db, 'case1', 'new_corner');
      const result = queryViolations(db, { page: 1, pageSize: 10, caseName: 'case2' });
      expect(result.total).toBe(1);
      expect(result.items[0].corner).toBe('c1');
    });

    it('returns 0 for non-existent case', () => {
      const result = updateCorner(db, 'non_existent', 'new_corner');
      expect(result.updated).toBe(0);
    });

    it('returns 0 for non-existent old corner', () => {
      const result = updateCorner(db, 'case1', 'new_corner', 'non_existent');
      expect(result.updated).toBe(0);
    });
  });
});
