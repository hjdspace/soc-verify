/**
 * Issue #7 — 时序违例模块集成：case→subsys 映射从 cases DB 查询
 *
 * 测试缝：tRPC 集成缝 — 验证 violation-router 的 enrichSubsysFromDiscovery /
 * enrichMetadataSubsysFromDiscovery / updateSubsysForCases 行为正确。
 *
 * 使用真实内存 SQLite（TV DB + Cases DB），不 mock DB，不 mock 插件。
 * 参考先例：tests/timing-violation/violation-router.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createMemoryDatabase as createTvMemoryDb,
  closeDatabase as closeTvDb,
} from '../../src/main/timing-violation/db/tv-database';
import {
  createMemoryDatabase as createCaseMemoryDb,
  closeDatabase as closeCaseDb,
} from '../../src/main/case/db/case-database';
import {
  insertViolations,
  ensureConfirmationRecords,
  getStatistics,
  getMetadata,
  updateSubsysForCases,
} from '../../src/main/timing-violation/db/tv-repository';
import {
  insertSubsystems,
  insertCases,
  getCaseNameToSubsysMap,
} from '../../src/main/case/db/case-repository';
import {
  enrichSubsysFromDiscovery,
  enrichMetadataSubsysFromDiscovery,
} from '../../src/main/ipc/routers/violation-router';
import type { ParsedViolation } from '../../src/main/timing-violation/types';
import type Database from 'better-sqlite3';

// ─── Fixtures ─────────────────────────────────────────────

let hierCounter = 0;

function makeViolation(overrides: Partial<ParsedViolation> = {}): ParsedViolation {
  hierCounter += 1;
  return {
    caseName: 'test_case',
    corner: 'npg_f1_ssg',
    seed: '1',
    subsys: 'dsp_sys',
    num: hierCounter,
    hier: `tb_top.dut.reg_${hierCounter}`,
    timeFs: 1523423 + hierCounter,
    timeDisplay: '1523423 FS',
    checkInfo: 'setup( posedge clk )',
    filePath: '/path/to/vio_summary.log',
    ...overrides,
  };
}

function seedCasesDb(db: Database.Database): void {
  insertSubsystems(db, [
    { name: 'cpu', path: '/proj/cpu' },
    { name: 'gpu', path: '/proj/gpu' },
  ]);
  insertCases(db, [
    { name: 'case_cpu_test', subsys: 'cpu', path: '/cases/cpu_test' },
    { name: 'case_gpu_test', subsys: 'gpu', path: '/cases/gpu_test' },
  ]);
}

// ─── Tests ────────────────────────────────────────────────

describe('Issue #7 — TV case→subsys integration with Cases DB', () => {
  let tvDb: Database.Database;
  let caseDb: Database.Database;

  beforeEach(() => {
    tvDb = createTvMemoryDb();
    caseDb = createCaseMemoryDb();
    hierCounter = 0;
  });

  afterEach(() => {
    closeTvDb(tvDb);
    closeCaseDb(caseDb);
  });

  // ─── enrichSubsysFromDiscovery ─────────────────────────

  describe('enrichSubsysFromDiscovery', () => {
    it('enriches unknown subsys using case→subsys map from cases DB', async () => {
      seedCasesDb(caseDb);

      // TV DB: violations with NULL subsys (will show as 'unknown')
      insertViolations(tvDb, [
        makeViolation({ num: 1, caseName: 'case_cpu_test', subsys: null }),
        makeViolation({ num: 2, caseName: 'case_gpu_test', subsys: null }),
      ]);
      ensureConfirmationRecords(tvDb);

      const stats = getStatistics(tvDb);
      expect(stats.bySubsys['unknown']).toBe(2);

      const caseToSubsysMap = getCaseNameToSubsysMap(caseDb);
      const enriched = await enrichSubsysFromDiscovery(tvDb, stats, caseToSubsysMap);

      expect(enriched.bySubsys['cpu']).toBe(1);
      expect(enriched.bySubsys['gpu']).toBe(1);
      expect(enriched.bySubsys['unknown']).toBeUndefined();
    });

    it('keeps subsys as unknown for case_name not in cases DB', async () => {
      // Cases DB has only 'known_case'
      insertSubsystems(caseDb, [{ name: 'cpu', path: '/proj/cpu' }]);
      insertCases(caseDb, [
        { name: 'known_case', subsys: 'cpu', path: '/cases/known' },
      ]);

      // TV DB: one known, one unknown case — all with NULL subsys
      insertViolations(tvDb, [
        makeViolation({ num: 1, caseName: 'known_case', subsys: null }),
        makeViolation({ num: 2, caseName: 'unknown_case', subsys: null }),
        makeViolation({ num: 3, caseName: 'unknown_case', subsys: null }),
      ]);
      ensureConfirmationRecords(tvDb);

      const stats = getStatistics(tvDb);
      expect(stats.bySubsys['unknown']).toBe(3);

      const caseToSubsysMap = getCaseNameToSubsysMap(caseDb);
      const enriched = await enrichSubsysFromDiscovery(tvDb, stats, caseToSubsysMap);

      // known_case → cpu
      expect(enriched.bySubsys['cpu']).toBe(1);
      // unknown_case not in cases DB → stays as unknown (2 violations)
      expect(enriched.bySubsys['unknown']).toBe(2);
    });

    it('does not error when cases DB is empty (no case→subsys mappings)', async () => {
      const caseToSubsysMap = getCaseNameToSubsysMap(caseDb);
      expect(caseToSubsysMap.size).toBe(0);

      insertViolations(tvDb, [
        makeViolation({ num: 1, caseName: 'any_case', subsys: null }),
      ]);
      ensureConfirmationRecords(tvDb);

      const stats = getStatistics(tvDb);

      // Should not throw — unknown stays as unknown
      const enriched = await enrichSubsysFromDiscovery(tvDb, stats, caseToSubsysMap);
      expect(enriched.bySubsys['unknown']).toBe(1);
    });

    it('preserves existing non-null subsys in stats', async () => {
      insertSubsystems(caseDb, [{ name: 'cpu', path: '/proj/cpu' }]);
      insertCases(caseDb, [
        { name: 'case_a', subsys: 'cpu', path: '/cases/a' },
      ]);

      // TV DB: case_a has NULL subsys, case_b already has 'gpu' subsys
      insertViolations(tvDb, [
        makeViolation({ num: 1, caseName: 'case_a', subsys: null }),
        makeViolation({ num: 2, caseName: 'case_b', subsys: 'gpu' }),
      ]);
      ensureConfirmationRecords(tvDb);

      const stats = getStatistics(tvDb);
      // stats should have { unknown: 1, gpu: 1 }
      expect(stats.bySubsys['unknown']).toBe(1);
      expect(stats.bySubsys['gpu']).toBe(1);

      const caseToSubsysMap = getCaseNameToSubsysMap(caseDb);
      const enriched = await enrichSubsysFromDiscovery(tvDb, stats, caseToSubsysMap);

      // case_a → cpu (enriched from cases DB)
      expect(enriched.bySubsys['cpu']).toBe(1);
      // case_b → gpu (already had subsys, not touched)
      expect(enriched.bySubsys['gpu']).toBe(1);
      expect(enriched.bySubsys['unknown']).toBeUndefined();
    });

    it('filters by caseName when enriching', async () => {
      seedCasesDb(caseDb);

      insertViolations(tvDb, [
        makeViolation({ num: 1, caseName: 'case_cpu_test', subsys: null }),
        makeViolation({ num: 2, caseName: 'case_gpu_test', subsys: null }),
      ]);
      ensureConfirmationRecords(tvDb);

      const stats = getStatistics(tvDb, { caseName: 'case_cpu_test' });
      expect(stats.bySubsys['unknown']).toBe(1);

      const caseToSubsysMap = getCaseNameToSubsysMap(caseDb);
      const enriched = await enrichSubsysFromDiscovery(
        tvDb,
        stats,
        caseToSubsysMap,
        'case_cpu_test',
      );

      expect(enriched.bySubsys['cpu']).toBe(1);
      expect(enriched.bySubsys['unknown']).toBeUndefined();
    });
  });

  // ─── enrichMetadataSubsysFromDiscovery ─────────────────

  describe('enrichMetadataSubsysFromDiscovery', () => {
    it('adds subsys from cases DB to metadata subsys list', async () => {
      insertSubsystems(caseDb, [{ name: 'cpu', path: '/proj/cpu' }]);
      insertCases(caseDb, [
        { name: 'case_a', subsys: 'cpu', path: '/cases/a' },
      ]);

      // TV DB: violation with NULL subsys
      insertViolations(tvDb, [
        makeViolation({ num: 1, caseName: 'case_a', subsys: null }),
      ]);
      ensureConfirmationRecords(tvDb);

      const metadata = getMetadata(tvDb);
      // No non-NULL subsys in TV DB → metadata.subsys is empty
      expect(metadata.subsys).toEqual([]);

      const caseToSubsysMap = getCaseNameToSubsysMap(caseDb);
      const enriched = await enrichMetadataSubsysFromDiscovery(tvDb, metadata, caseToSubsysMap);

      expect(enriched.subsys).toContain('cpu');
    });

    it('does not add subsys for unknown case_names', async () => {
      insertSubsystems(caseDb, [{ name: 'cpu', path: '/proj/cpu' }]);
      insertCases(caseDb, [
        { name: 'known_case', subsys: 'cpu', path: '/cases/known' },
      ]);

      insertViolations(tvDb, [
        makeViolation({ num: 1, caseName: 'unknown_case', subsys: null }),
      ]);
      ensureConfirmationRecords(tvDb);

      const metadata = getMetadata(tvDb);
      const caseToSubsysMap = getCaseNameToSubsysMap(caseDb);
      const enriched = await enrichMetadataSubsysFromDiscovery(tvDb, metadata, caseToSubsysMap);

      // unknown_case not in cases DB → no subsys added
      expect(enriched.subsys).not.toContain('cpu');
    });

    it('returns original metadata when no NULL subsys records exist', async () => {
      insertViolations(tvDb, [
        makeViolation({ num: 1, caseName: 'case_a', subsys: 'gpu' }),
      ]);
      ensureConfirmationRecords(tvDb);

      const metadata = getMetadata(tvDb);
      expect(metadata.subsys).toContain('gpu');

      const caseToSubsysMap = getCaseNameToSubsysMap(caseDb);
      const enriched = await enrichMetadataSubsysFromDiscovery(tvDb, metadata, caseToSubsysMap);

      // No NULL subsys → no enrichment needed
      expect(enriched.subsys).toEqual(metadata.subsys);
    });
  });

  // ─── updateSubsysForCases (refreshSubsys behavior) ─────

  describe('updateSubsysForCases — refreshSubsys behavior', () => {
    it('updates NULL subsys in TV DB from cases DB mapping', () => {
      insertSubsystems(caseDb, [{ name: 'cpu', path: '/proj/cpu' }]);
      insertCases(caseDb, [
        { name: 'case_a', subsys: 'cpu', path: '/cases/a' },
      ]);

      insertViolations(tvDb, [
        makeViolation({ caseName: 'case_a', subsys: null }),
        makeViolation({ caseName: 'case_a', subsys: null }),
        makeViolation({ caseName: 'case_b', subsys: null }),
      ]);
      ensureConfirmationRecords(tvDb);

      const caseToSubsysMap = getCaseNameToSubsysMap(caseDb);
      const result = updateSubsysForCases(tvDb, caseToSubsysMap);

      // case_a has 2 violations with NULL subsys → updated
      expect(result.updated).toBe(2);

      // Verify in DB
      const stats = getStatistics(tvDb);
      expect(stats.bySubsys['cpu']).toBe(2);
      // case_b not in cases DB → stays as unknown
      expect(stats.bySubsys['unknown']).toBe(1);
    });

    it('does not update non-NULL subsys records', () => {
      insertSubsystems(caseDb, [{ name: 'cpu', path: '/proj/cpu' }]);
      insertCases(caseDb, [
        { name: 'case_a', subsys: 'cpu', path: '/cases/a' },
      ]);

      insertViolations(tvDb, [
        makeViolation({ caseName: 'case_a', subsys: null }),
        makeViolation({ caseName: 'case_a', subsys: 'gpu' }),
      ]);
      ensureConfirmationRecords(tvDb);

      const caseToSubsysMap = getCaseNameToSubsysMap(caseDb);
      const result = updateSubsysForCases(tvDb, caseToSubsysMap);

      // Only the NULL subsys record is updated
      expect(result.updated).toBe(1);

      const stats = getStatistics(tvDb);
      expect(stats.bySubsys['cpu']).toBe(1);
      expect(stats.bySubsys['gpu']).toBe(1);
    });

    it('returns 0 when cases DB is empty', () => {
      insertViolations(tvDb, [
        makeViolation({ num: 1, caseName: 'case_a', subsys: null }),
      ]);
      ensureConfirmationRecords(tvDb);

      const caseToSubsysMap = getCaseNameToSubsysMap(caseDb);
      const result = updateSubsysForCases(tvDb, caseToSubsysMap);

      expect(result.updated).toBe(0);
    });
  });
});
