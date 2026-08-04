/**
 * TV Exporter — 违例数据和 Pattern 的 Excel/CSV 导出
 *
 * 参考 Python models.py 中 export_patterns_to_excel / export_patterns_to_csv
 * 参考 docs/timing-violation-handoff.md §4.4 (tRPC API 设计)
 *
 * Excel 导出使用 exceljs（已在 package.json dependencies 中）。
 * CSV 导出使用纯 Node.js fs 写入。
 */

import type Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import type { ViolationWithConfirmation, ViolationPattern } from '../types';

// ─── 违例数据导出 ─────────────────────────────────────────────

/**
 * 查询所有违例（含确认信息），用于导出。
 * 支持按 caseName/corner 筛选。
 */
export function queryViolationsForExport(
  db: Database.Database,
  filter?: { caseName?: string; corner?: string },
): ViolationWithConfirmation[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter?.caseName) {
    conditions.push('v.case_name = @caseName');
    params.caseName = filter.caseName;
  }
  if (filter?.corner) {
    conditions.push('v.corner = @corner');
    params.corner = filter.corner;
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const rows = db.prepare(`
    SELECT
      v.id, v.case_name, v.corner, v.seed, v.subsys, v.num,
      v.hier, v.time_fs, v.time_display, v.check_info, v.file_path,
      v.created_at,
      COALESCE(c.status, 'pending') as status,
      c.confirmer, c.result, c.reason,
      COALESCE(c.is_auto_confirmed, 0) as is_auto_confirmed,
      c.confirmed_at
    FROM timing_violations v
    LEFT JOIN confirmation_records c ON v.id = c.violation_id
    ${whereClause}
    ORDER BY v.case_name, v.corner, v.num
  `).all(params) as Record<string, unknown>[];

  return rows.map(rowToViolationWithConfirmation);
}

/**
 * 导出违例数据为 Excel 文件。
 */
export async function exportViolationsToExcel(
  db: Database.Database,
  filePath: string,
  filter?: { caseName?: string; corner?: string },
): Promise<{ success: boolean; count: number }> {
  const violations = queryViolationsForExport(db, filter);

  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Violations');

  // 表头
  sheet.columns = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Case', key: 'caseName', width: 30 },
    { header: 'Corner', key: 'corner', width: 15 },
    { header: 'Seed', key: 'seed', width: 10 },
    { header: 'Subsystem', key: 'subsys', width: 15 },
    { header: 'NUM', key: 'num', width: 8 },
    { header: 'Hierarchy', key: 'hier', width: 60 },
    { header: 'Time (fs)', key: 'timeFs', width: 15 },
    { header: 'Time (display)', key: 'timeDisplay', width: 18 },
    { header: 'Check Info', key: 'checkInfo', width: 60 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Confirmer', key: 'confirmer', width: 15 },
    { header: 'Result', key: 'result', width: 10 },
    { header: 'Reason', key: 'reason', width: 40 },
    { header: 'Auto', key: 'isAutoConfirmed', width: 8 },
    { header: 'Confirmed At', key: 'confirmedAt', width: 20 },
    { header: 'File Path', key: 'filePath', width: 60 },
    { header: 'Created At', key: 'createdAt', width: 20 },
  ];

  // 表头样式
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4472C4' },
  };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  // 数据行
  for (const v of violations) {
    sheet.addRow({
      id: v.id,
      caseName: v.caseName,
      corner: v.corner ?? '',
      seed: v.seed ?? '',
      subsys: v.subsys ?? '',
      num: v.num,
      hier: v.hier,
      timeFs: v.timeFs,
      timeDisplay: v.timeDisplay,
      checkInfo: v.checkInfo,
      status: v.status,
      confirmer: v.confirmer ?? '',
      result: v.result ?? '',
      reason: v.reason ?? '',
      isAutoConfirmed: v.isAutoConfirmed ? 'Yes' : 'No',
      confirmedAt: v.confirmedAt ?? '',
      filePath: v.filePath,
      createdAt: v.createdAt,
    });
  }

  await workbook.xlsx.writeFile(filePath);
  return { success: true, count: violations.length };
}

/**
 * 导出违例数据为 CSV 文件。
 */
export function exportViolationsToCsv(
  db: Database.Database,
  filePath: string,
  filter?: { caseName?: string; corner?: string },
): { success: boolean; count: number } {
  const violations = queryViolationsForExport(db, filter);

  const headers = [
    'ID', 'Case', 'Corner', 'Seed', 'Subsystem', 'NUM',
    'Hierarchy', 'Time(fs)', 'Time(display)', 'Check Info',
    'Status', 'Confirmer', 'Result', 'Reason', 'Auto', 'Confirmed At',
    'File Path', 'Created At',
  ];

  const lines = [headers.join(',')];

  for (const v of violations) {
    const row = [
      String(v.id),
      csvEscape(v.caseName),
      csvEscape(v.corner ?? ''),
      csvEscape(v.seed ?? ''),
      csvEscape(v.subsys ?? ''),
      String(v.num),
      csvEscape(v.hier),
      String(v.timeFs),
      csvEscape(v.timeDisplay),
      csvEscape(v.checkInfo),
      v.status,
      csvEscape(v.confirmer ?? ''),
      csvEscape(v.result ?? ''),
      csvEscape(v.reason ?? ''),
      v.isAutoConfirmed ? 'Yes' : 'No',
      csvEscape(v.confirmedAt ?? ''),
      csvEscape(v.filePath),
      csvEscape(v.createdAt),
    ];
    lines.push(row.join(','));
  }

  // BOM for Excel UTF-8 compatibility
  writeFileSync(filePath, '\ufeff' + lines.join('\n'), 'utf-8');
  return { success: true, count: violations.length };
}

// ─── Pattern 导出 ─────────────────────────────────────────────

/**
 * 查询所有 Pattern，用于导出。
 */
export function queryPatternsForExport(db: Database.Database): ViolationPattern[] {
  const rows = db.prepare(`
    SELECT id, hier_pattern, check_pattern,
           default_confirmer, default_result, default_reason,
           match_count, last_used
    FROM violation_patterns
    ORDER BY last_used DESC
  `).all() as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row['id'] as number,
    hierPattern: row['hier_pattern'] as string,
    checkPattern: row['check_pattern'] as string,
    defaultConfirmer: (row['default_confirmer'] as string | null) ?? null,
    defaultResult: (row['default_result'] as string | null) ?? null,
    defaultReason: (row['default_reason'] as string | null) ?? null,
    matchCount: row['match_count'] as number,
    lastUsed: row['last_used'] as string,
  }));
}

/**
 * 导出 Pattern 为 Excel 文件。
 */
export async function exportPatternsToExcel(
  db: Database.Database,
  filePath: string,
): Promise<{ success: boolean; count: number }> {
  const patterns = queryPatternsForExport(db);

  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Patterns');

  sheet.columns = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Hierarchy Pattern', key: 'hierPattern', width: 60 },
    { header: 'Check Pattern', key: 'checkPattern', width: 60 },
    { header: 'Default Confirmer', key: 'defaultConfirmer', width: 15 },
    { header: 'Default Result', key: 'defaultResult', width: 12 },
    { header: 'Default Reason', key: 'defaultReason', width: 40 },
    { header: 'Match Count', key: 'matchCount', width: 12 },
    { header: 'Last Used', key: 'lastUsed', width: 20 },
  ];

  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4472C4' },
  };

  for (const p of patterns) {
    sheet.addRow({
      id: p.id,
      hierPattern: p.hierPattern,
      checkPattern: p.checkPattern,
      defaultConfirmer: p.defaultConfirmer ?? '',
      defaultResult: p.defaultResult ?? '',
      defaultReason: p.defaultReason ?? '',
      matchCount: p.matchCount,
      lastUsed: p.lastUsed,
    });
  }

  await workbook.xlsx.writeFile(filePath);
  return { success: true, count: patterns.length };
}

/**
 * 导出 Pattern 为 CSV 文件。
 */
export function exportPatternsToCsv(
  db: Database.Database,
  filePath: string,
): { success: boolean; count: number } {
  const patterns = queryPatternsForExport(db);

  const headers = [
    'ID', 'Hierarchy Pattern', 'Check Pattern',
    'Default Confirmer', 'Default Result', 'Default Reason',
    'Match Count', 'Last Used',
  ];

  const lines = [headers.join(',')];

  for (const p of patterns) {
    const row = [
      String(p.id),
      csvEscape(p.hierPattern),
      csvEscape(p.checkPattern),
      csvEscape(p.defaultConfirmer ?? ''),
      csvEscape(p.defaultResult ?? ''),
      csvEscape(p.defaultReason ?? ''),
      String(p.matchCount),
      csvEscape(p.lastUsed),
    ];
    lines.push(row.join(','));
  }

  writeFileSync(filePath, '\ufeff' + lines.join('\n'), 'utf-8');
  return { success: true, count: patterns.length };
}

// ─── 工具函数 ─────────────────────────────────────────────────

/** CSV 字段转义：包含逗号、引号、换行时用双引号包裹 */
function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ─── 行映射 ───────────────────────────────────────────────────

function rowToViolationWithConfirmation(row: Record<string, unknown>): ViolationWithConfirmation {
  return {
    id: row['id'] as number,
    caseName: row['case_name'] as string,
    corner: (row['corner'] as string | null) ?? null,
    seed: (row['seed'] as string | null) ?? null,
    subsys: (row['subsys'] as string | null) ?? null,
    num: row['num'] as number,
    hier: row['hier'] as string,
    timeFs: row['time_fs'] as number,
    timeDisplay: row['time_display'] as string,
    checkInfo: row['check_info'] as string,
    filePath: row['file_path'] as string,
    createdAt: row['created_at'] as string,
    status: (row['status'] as 'pending' | 'confirmed' | 'ignored') ?? 'pending',
    confirmer: (row['confirmer'] as string | null) ?? null,
    result: (row['result'] as string | null) ?? null,
    reason: (row['reason'] as string | null) ?? null,
    isAutoConfirmed: Boolean(row['is_auto_confirmed']),
    confirmedAt: (row['confirmed_at'] as string | null) ?? null,
  };
}
