/**
 * Design Database — 提炼模型持久化（对齐 Case Database 模式，ADR 0032 决策 6）。
 *
 * 文件：<projectRoot>/.socverify/design.db
 * 表：meta（元数据/错误）/ defs（模块定义表）/ insts（实例树）/ edges（per-def 连线表）。
 * raw write_json 不持久化（体积大、可再生）。
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  DesignDefRow,
  DesignEdgeRow,
  DesignInstRow,
  ExtractedDesign,
  ExtractedEdge,
  PortAnalysis,
  SlangDiagnostic,
  ElaborationError,
} from './types';

export type DesignDatabase = Database.Database;

const DEFAULT_DATA_DIR = '.socverify';
export const DESIGN_DB_FILE = 'design.db';

/**
 * schema 版本（PRAGMA user_version）。DB 是可再生缓存：版本低于当前值时
 * 直接重建（issue 03 为 insts 增加 inst_count 列 → version 2；
 * issue 04 为 defs 增加 bundles 列 → version 3）。
 */
const SCHEMA_VERSION = 3;

/** 空 bundle 分析（打标失败/无端口的兜底值，design-service 复用） */
export const EMPTY_ANALYSIS: PortAnalysis = { bundles: [], leftovers: [] };

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS defs (
  name TEXT PRIMARY KEY,
  src TEXT,
  param_defaults TEXT NOT NULL DEFAULT '{}',
  ports TEXT NOT NULL DEFAULT '[]',
  bundles TEXT NOT NULL DEFAULT '{"bundles":[],"leftovers":[]}'
);
CREATE TABLE IF NOT EXISTS insts (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  module TEXT NOT NULL,
  parent TEXT,
  depth INTEGER NOT NULL,
  src TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  inst_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_insts_parent ON insts(parent, name);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL,
  net TEXT,
  kind TEXT NOT NULL,
  width INTEGER NOT NULL,
  cells TEXT NOT NULL DEFAULT '[]',
  top_ports TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_edges_module ON edges(module);
`;

// ─── 提炼模型写入 / 查询 ────────────────────────────────────────────────

export function getDesignDbPath(projectRoot: string): string {
  return resolve(projectRoot, DEFAULT_DATA_DIR, DESIGN_DB_FILE);
}

export function initDesignDatabase(dbFullPath: string): DesignDatabase {
  const dir = dirname(dbFullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbFullPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);
  migrateIfNeeded(db);
  db.exec(SCHEMA_SQL);
  return db;
}

/** 旧版本 schema 直接重建（DB 为可再生缓存，无数据迁移价值） */
function migrateIfNeeded(db: DesignDatabase): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version >= SCHEMA_VERSION) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_insts_parent;
    DROP INDEX IF EXISTS idx_edges_module;
    DROP TABLE IF EXISTS edges;
    DROP TABLE IF EXISTS insts;
    DROP TABLE IF EXISTS defs;
    DROP TABLE IF EXISTS meta;
  `);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export function createMemoryDesignDatabase(): DesignDatabase {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function closeDesignDatabase(db: DesignDatabase): void {
  if (db.open) {
    db.close();
  }
}

// ─── meta ──────────────────────────────────────────────────

export function setMeta(db: DesignDatabase, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getMeta(db: DesignDatabase, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function getAllMeta(db: DesignDatabase): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** 结构化错误持久化（elaboration 失败呈现给用户：文件+行号诊断） */
export function setLastError(db: DesignDatabase, error: ElaborationError | null): void {
  if (error === null) {
    db.prepare('DELETE FROM meta WHERE key = ?').run('lastError');
    return;
  }
  setMeta(db, 'lastError', JSON.stringify(error));
}

export function getLastError(db: DesignDatabase): ElaborationError | null {
  const raw = getMeta(db, 'lastError');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { message: string; diagnostics: SlangDiagnostic[]; logTail: string };
    return { message: parsed.message, diagnostics: parsed.diagnostics ?? [], logTail: parsed.logTail ?? '' };
  } catch {
    return null;
  }
}

// ─── 提炼模型写入 / 查询 ────────────────────────────────────

/** 全量替换提炼数据 + 元数据（事务原子写，对齐 case-scanner 的 transaction 模式） */
export function replaceAll(db: DesignDatabase, design: ExtractedDesign, meta: Record<string, string>): void {
  const insertDef = db.prepare(
    'INSERT OR REPLACE INTO defs (name, src, param_defaults, ports, bundles) VALUES (?, ?, ?, ?, ?)',
  );
  const insertInst = db.prepare(
    'INSERT OR REPLACE INTO insts (path, name, module, parent, depth, src, params, inst_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertEdge = db.prepare(
    'INSERT OR REPLACE INTO edges (module, net, kind, width, cells, top_ports) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const tx = db.transaction(() => {
    db.exec('DELETE FROM edges');
    db.exec('DELETE FROM insts');
    db.exec('DELETE FROM defs');
    db.exec('DELETE FROM meta');

    for (const def of design.defs) {
      insertDef.run(def.name, def.src, JSON.stringify(def.paramDefaults), JSON.stringify(def.ports), JSON.stringify(def.bundles ?? EMPTY_ANALYSIS));
    }
    for (const inst of design.insts) {
      insertInst.run(inst.path, inst.name, inst.module, inst.parent, inst.depth, inst.src, JSON.stringify(inst.params), inst.instCount);
    }
    for (const edge of design.edges) {
      insertEdge.run(edge.module, edge.net, edge.kind, edge.width, JSON.stringify(edge.cells), JSON.stringify(edge.topPorts));
    }
    for (const [key, value] of Object.entries(meta)) {
      setMeta(db, key, value);
    }
  });
  tx();
}

export function countInsts(db: DesignDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM insts').get() as { c: number };
  return row.c;
}

export function hasDesignData(db: DesignDatabase): boolean {
  return countInsts(db) > 0;
}

function toInstRow(r: Record<string, unknown>): DesignInstRow {
  return {
    path: r.path as string,
    name: r.name as string,
    module: r.module as string,
    parent: (r.parent as string | null) ?? null,
    depth: r.depth as number,
    src: (r.src as string | null) ?? null,
    params: JSON.parse((r.params as string) ?? '{}') as Record<string, unknown>,
    instCount: (r.inst_count as number) ?? 0,
  };
}

export function getRootInstance(db: DesignDatabase): DesignInstRow | null {
  const row = db.prepare('SELECT * FROM insts WHERE parent IS NULL LIMIT 1').get() as
    | Record<string, unknown>
    | undefined;
  return row ? toInstRow(row) : null;
}

/** 子树懒加载：按父路径取直接子实例（tRPC 子树查询的基元） */
export function getChildrenInstances(db: DesignDatabase, parentPath: string): DesignInstRow[] {
  const rows = db.prepare('SELECT * FROM insts WHERE parent = ? ORDER BY name').all(parentPath) as Record<
    string,
    unknown
  >[];
  return rows.map(toInstRow);
}

export function getInstance(db: DesignDatabase, path: string): DesignInstRow | null {
  const row = db.prepare('SELECT * FROM insts WHERE path = ?').get(path) as Record<string, unknown> | undefined;
  return row ? toInstRow(row) : null;
}

function toDefRow(r: Record<string, unknown>): DesignDefRow {
  return {
    name: r.name as string,
    src: (r.src as string | null) ?? null,
    paramDefaults: JSON.parse((r.param_defaults as string) ?? '{}') as Record<string, unknown>,
    ports: JSON.parse((r.ports as string) ?? '[]') as DesignDefRow['ports'],
    bundles: JSON.parse((r.bundles as string) ?? JSON.stringify(EMPTY_ANALYSIS)) as PortAnalysis,
  };
}

export function getDef(db: DesignDatabase, name: string): DesignDefRow | null {
  const row = db.prepare('SELECT * FROM defs WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  return row ? toDefRow(row) : null;
}

export function listDefs(db: DesignDatabase): DesignDefRow[] {
  const rows = db.prepare('SELECT * FROM defs ORDER BY name').all() as Record<string, unknown>[];
  return rows.map(toDefRow);
}

export function getDefEdges(db: DesignDatabase, moduleName: string): DesignEdgeRow[] {
  const rows = db.prepare('SELECT * FROM edges WHERE module = ?').all(moduleName) as Record<string, unknown>[];
  return rows.map((r) => ({
    module: r.module as string,
    net: (r.net as string | null) ?? null,
    kind: r.kind as ExtractedEdge['kind'],
    width: r.width as number,
    cells: JSON.parse((r.cells as string) ?? '[]') as { inst: string; port: string }[],
    topPorts: JSON.parse((r.top_ports as string) ?? '[]') as string[],
  }));
}
