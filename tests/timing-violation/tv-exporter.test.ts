import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryDatabase, closeDatabase, type TvDatabase } from '../../src/main/timing-violation/db/tv-database';
import {
  insertViolations,
  ensureConfirmationRecords,
} from '../../src/main/timing-violation/db/tv-repository';
import {
  exportViolationsToCsv,
  exportPatternsToCsv,
  queryViolationsForExport,
  queryPatternsForExport,
} from '../../src/main/timing-violation/export/tv-exporter';
import {
  exportPatternsToDatabase,
  importPatternsFromDatabase,
  mergeDatabases,
  createEmptyDatabase,
} from '../../src/main/timing-violation/export/tv-db-transfer';
import type { ParsedViolation } from '../../src/main/timing-violation/types';

describe('TV Exporter', () => {
  let db: TvDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = createMemoryDatabase();
    tmpDir = tmpdir() + `/sv-tv-export-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

  describe('queryViolationsForExport', () => {
    it('returns all violations with confirmation info', () => {
      insertViolations(db, [
        makeViolation({ num: 1, hier: 'a' }),
        makeViolation({ num: 2, hier: 'b' }),
      ]);
      ensureConfirmationRecords(db);

      const result = queryViolationsForExport(db);
      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('pending');
    });

    it('filters by caseName', () => {
      insertViolations(db, [
        makeViolation({ num: 1, caseName: 'case1' }),
        makeViolation({ num: 2, caseName: 'case2' }),
      ]);
      ensureConfirmationRecords(db);

      const result = queryViolationsForExport(db, { caseName: 'case1' });
      expect(result).toHaveLength(1);
      expect(result[0].caseName).toBe('case1');
    });

    it('filters by corner', () => {
      insertViolations(db, [
        makeViolation({ num: 1, corner: 'c1' }),
        makeViolation({ num: 2, corner: 'c2' }),
      ]);
      ensureConfirmationRecords(db);

      const result = queryViolationsForExport(db, { corner: 'c1' });
      expect(result).toHaveLength(1);
      expect(result[0].corner).toBe('c1');
    });
  });

  describe('exportViolationsToCsv', () => {
    it('exports violations to CSV file', () => {
      insertViolations(db, [
        makeViolation({ num: 1, hier: 'tb_top.a' }),
        makeViolation({ num: 2, hier: 'tb_top.b' }),
      ]);
      ensureConfirmationRecords(db);

      const csvPath = join(tmpDir, 'violations.csv');
      const result = exportViolationsToCsv(db, csvPath);

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(existsSync(csvPath)).toBe(true);

      const content = readFileSync(csvPath, 'utf-8');
      expect(content).toContain('Case');
      expect(content).toContain('tb_top.a');
      expect(content).toContain('tb_top.b');
      // BOM
      expect(content.charCodeAt(0)).toBe(0xfeff);
    });

    it('exports filtered violations', () => {
      insertViolations(db, [
        makeViolation({ num: 1, caseName: 'case1' }),
        makeViolation({ num: 2, caseName: 'case2' }),
      ]);
      ensureConfirmationRecords(db);

      const csvPath = join(tmpDir, 'filtered.csv');
      const result = exportViolationsToCsv(db, csvPath, { caseName: 'case1' });

      expect(result.count).toBe(1);
      const content = readFileSync(csvPath, 'utf-8');
      expect(content).toContain('case1');
      expect(content).not.toContain('case2');
    });

    it('escapes commas and quotes in CSV', () => {
      insertViolations(db, [
        makeViolation({
          num: 1,
          hier: 'tb_top,comma',
          checkInfo: 'setup( "quoted" )',
        }),
      ]);
      ensureConfirmationRecords(db);

      const csvPath = join(tmpDir, 'escape.csv');
      exportViolationsToCsv(db, csvPath);

      const content = readFileSync(csvPath, 'utf-8');
      expect(content).toContain('"tb_top,comma"');
    });
  });

  describe('queryPatternsForExport', () => {
    it('returns all patterns', () => {
      db.prepare(`
        INSERT INTO violation_patterns (hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used)
        VALUES
          ('tb_top.a', 'check_a', 'Alice', 'pass', 'safe', 1, '2024-01-01 10:00:00'),
          ('tb_top.b', 'check_b', 'Bob', 'issue', 'has issue', 3, '2024-01-02 10:00:00')
      `).run();

      const result = queryPatternsForExport(db);
      expect(result).toHaveLength(2);
      expect(result[0].hierPattern).toBe('tb_top.b'); // ordered by last_used DESC
    });
  });

  describe('exportPatternsToCsv', () => {
    it('exports patterns to CSV file', () => {
      db.prepare(`
        INSERT INTO violation_patterns (hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used)
        VALUES
          ('tb_top.a', 'check_a', 'Alice', 'pass', 'safe', 5, '2024-01-01 10:00:00'),
          ('tb_top.b', 'check_b', 'Bob', 'issue', 'has issue', 3, '2024-01-02 10:00:00')
      `).run();

      const csvPath = join(tmpDir, 'patterns.csv');
      const result = exportPatternsToCsv(db, csvPath);

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(existsSync(csvPath)).toBe(true);

      const content = readFileSync(csvPath, 'utf-8');
      expect(content).toContain('Hierarchy Pattern');
      expect(content).toContain('tb_top.a');
      expect(content).toContain('Alice');
    });
  });
});

describe('TV DB Transfer', () => {
  let db: TvDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = createMemoryDatabase();
    tmpDir = tmpdir() + `/sv-tv-transfer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

  describe('exportPatternsToDatabase', () => {
    it('exports patterns to standalone DB file', () => {
      db.prepare(`
        INSERT INTO violation_patterns (hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used)
        VALUES
          ('tb_top.a', 'check_a', 'Alice', 'pass', 'safe', 5, '2024-01-01 10:00:00'),
          ('tb_top.b', 'check_b', 'Bob', 'issue', 'has issue', 3, '2024-01-02 10:00:00')
      `).run();

      const dbPath = join(tmpDir, 'patterns_export.db');
      const result = exportPatternsToDatabase(db, dbPath);

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(existsSync(dbPath)).toBe(true);

      // Verify the exported DB
      const Database = require('better-sqlite3');
      const exportedDb = new Database(dbPath, { readonly: true });
      const count = exportedDb.prepare('SELECT COUNT(*) as count FROM violation_patterns').get() as { count: number };
      expect(count.count).toBe(2);
      exportedDb.close();
    });
  });

  describe('importPatternsFromDatabase', () => {
    it('imports new patterns (no duplicates)', () => {
      // Create source DB with patterns
      const sourcePath = join(tmpDir, 'source.db');
      const sourceDb = createEmptyDatabase(sourcePath);
      sourceDb.prepare(`
        INSERT INTO violation_patterns (hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used)
        VALUES
          ('tb_top.a', 'check_a', 'Alice', 'pass', 'safe', 5, '2024-01-01 10:00:00'),
          ('tb_top.b', 'check_b', 'Bob', 'issue', 'has issue', 3, '2024-01-02 10:00:00')
      `).run();
      closeDatabase(sourceDb);

      // Import into target DB
      const result = importPatternsFromDatabase(db, sourcePath);
      expect(result.importedCount).toBe(2);
      expect(result.updatedCount).toBe(0);

      // Verify
      const patterns = db.prepare('SELECT * FROM violation_patterns').all();
      expect(patterns).toHaveLength(2);
    });

    it('merges duplicate patterns by adding match_count', () => {
      // Target DB has existing pattern
      db.prepare(`
        INSERT INTO violation_patterns (hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used)
        VALUES ('tb_top.a', 'check_a', 'Alice', 'pass', 'safe', 5, '2024-01-01 10:00:00')
      `).run();

      // Source DB has same pattern with match_count=3
      const sourcePath = join(tmpDir, 'source.db');
      const sourceDb = createEmptyDatabase(sourcePath);
      sourceDb.prepare(`
        INSERT INTO violation_patterns (hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used)
        VALUES ('tb_top.a', 'check_a', 'Bob', 'issue', 'has issue', 3, '2024-01-02 10:00:00')
      `).run();
      closeDatabase(sourceDb);

      const result = importPatternsFromDatabase(db, sourcePath);
      expect(result.importedCount).toBe(0);
      expect(result.updatedCount).toBe(1);

      // Verify match_count was added
      const row = db.prepare('SELECT match_count FROM violation_patterns WHERE hier_pattern = ? AND check_pattern = ?')
        .get('tb_top.a', 'check_a') as { match_count: number };
      expect(row.match_count).toBe(8); // 5 + 3
    });

    it('handles mix of new and existing patterns', () => {
      // Target DB has one existing
      db.prepare(`
        INSERT INTO violation_patterns (hier_pattern, check_pattern, match_count, last_used)
        VALUES ('tb_top.a', 'check_a', 2, '2024-01-01 10:00:00')
      `).run();

      // Source DB has 2 patterns: one existing + one new
      const sourcePath = join(tmpDir, 'source.db');
      const sourceDb = createEmptyDatabase(sourcePath);
      sourceDb.prepare(`
        INSERT INTO violation_patterns (hier_pattern, check_pattern, match_count, last_used)
        VALUES
          ('tb_top.a', 'check_a', 3, '2024-01-02 10:00:00'),
          ('tb_top.b', 'check_b', 1, '2024-01-03 10:00:00')
      `).run();
      closeDatabase(sourceDb);

      const result = importPatternsFromDatabase(db, sourcePath);
      expect(result.importedCount).toBe(1);
      expect(result.updatedCount).toBe(1);
    });
  });

  describe('mergeDatabases', () => {
    it('merges violations + confirmations + patterns from source DBs', () => {
      // Set up source DB
      const sourcePath = join(tmpDir, 'source.db');
      const sourceDb = createEmptyDatabase(sourcePath);
      insertViolations(sourceDb, [
        makeViolation({ num: 1, hier: 'tb_top.a', caseName: 'case1' }),
        makeViolation({ num: 2, hier: 'tb_top.b', caseName: 'case1' }),
      ]);
      ensureConfirmationRecords(sourceDb);
      // Confirm one violation
      sourceDb.prepare(`
        UPDATE confirmation_records SET status = 'confirmed', confirmer = 'Alice', result = 'pass', reason = 'ok'
        WHERE violation_id = (SELECT id FROM timing_violations WHERE hier = 'tb_top.a' LIMIT 1)
      `).run();
      // Add a pattern
      sourceDb.prepare(`
        INSERT INTO violation_patterns (hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used)
        VALUES ('tb_top.a', 'check_a', 'Alice', 'pass', 'safe', 1, '2024-01-01 10:00:00')
      `).run();
      closeDatabase(sourceDb);

      // Merge into target DB
      const result = mergeDatabases(db, [sourcePath]);

      expect(result.mergedViolations).toBe(2);
      expect(result.mergedPatterns).toBe(1);

      // Verify violations
      const vCount = db.prepare('SELECT COUNT(*) as count FROM timing_violations').get() as { count: number };
      expect(vCount.count).toBe(2);

      // Verify confirmations were merged (one should be confirmed)
      const confirmed = db.prepare(`
        SELECT c.status FROM confirmation_records c
        JOIN timing_violations v ON c.violation_id = v.id
        WHERE v.hier = 'tb_top.a'
      `).get() as { status: string };
      expect(confirmed.status).toBe('confirmed');
    });

    it('does not overwrite existing confirmations', () => {
      // Set up target with a confirmed violation
      insertViolations(db, [makeViolation({ num: 1, hier: 'tb_top.a' })]);
      ensureConfirmationRecords(db);
      db.prepare(`
        UPDATE confirmation_records SET status = 'ignored', confirmer = 'Bob'
        WHERE violation_id = (SELECT id FROM timing_violations WHERE hier = 'tb_top.a' LIMIT 1)
      `).run();

      // Source has the same violation but with different confirmation
      const sourcePath = join(tmpDir, 'source.db');
      const sourceDb = createEmptyDatabase(sourcePath);
      insertViolations(sourceDb, [makeViolation({ num: 1, hier: 'tb_top.a' })]);
      ensureConfirmationRecords(sourceDb);
      sourceDb.prepare(`
        UPDATE confirmation_records SET status = 'confirmed', confirmer = 'Alice'
        WHERE violation_id = (SELECT id FROM timing_violations WHERE hier = 'tb_top.a' LIMIT 1)
      `).run();
      closeDatabase(sourceDb);

      mergeDatabases(db, [sourcePath]);

      // Target should keep its own confirmation ('ignored')
      const row = db.prepare(`
        SELECT c.status, c.confirmer FROM confirmation_records c
        JOIN timing_violations v ON c.violation_id = v.id
        WHERE v.hier = 'tb_top.a'
      `).get() as { status: string; confirmer: string };
      expect(row.status).toBe('ignored');
      expect(row.confirmer).toBe('Bob');
    });

    it('handles non-existent source files gracefully', () => {
      const result = mergeDatabases(db, ['/nonexistent/path.db']);
      expect(result.mergedViolations).toBe(0);
      expect(result.mergedPatterns).toBe(0);
    });
  });

  describe('createEmptyDatabase', () => {
    it('creates a new database with full schema', () => {
      const dbPath = join(tmpDir, 'empty.db');
      const newDb = createEmptyDatabase(dbPath);
      try {
        const tables = newDb.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).all() as { name: string }[];
        const tableNames = tables.map(t => t.name);
        expect(tableNames).toContain('timing_violations');
        expect(tableNames).toContain('confirmation_records');
        expect(tableNames).toContain('violation_patterns');
      } finally {
        closeDatabase(newDb);
      }
    });
  });
});
