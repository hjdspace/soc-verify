/**
 * xlsx 细粒度编辑工具。
 *
 * 基于 exceljs 实现追加行、更新单元格操作，供 AI HostTools 调用。
 * 每次操作读取文件 → 修改 → 写回，保证不丢失其他进程的修改。
 *
 * 与 fortune-sheet-bridge 的区别：bridge 是 Fortune-sheet 数据模型 ↔ exceljs
 * Workbook 的整体转换；xlsx-editor 是 exceljs 上的细粒度就地编辑。
 */

import ExcelJS from 'exceljs';
import { readXlsxWorkbook } from './xlsx-reader';

/** 单元格值类型（与 exceljs 兼容） */
export type CellValue = string | number | boolean | Date | null;

/** 追加行结果 */
export type AppendRowsResult = {
  path: string;
  sheet: string;
  appendedRows: number;
  startRow: number;
};

/** 更新单元格结果 */
export type UpdateCellResult = {
  path: string;
  sheet: string;
  row: number;
  col: number;
  previousValue: CellValue;
  newValue: CellValue;
};

/**
 * 将列号（1-based）转为 exceljs 列字母（A, B, ..., AA, AB, ...）。
 * exceljs 的 getCell 接受 'A1' 这种地址。
 */
function colIndexToLetter(col: number): string {
  let letters = '';
  let n = col;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * 追加行到指定 sheet。
 *
 * @param filePath xlsx 文件绝对路径
 * @param sheetName sheet 名称（若不存在则创建）
 * @param rows 二维数组，每个内层数组是一行的单元格值
 * @returns 追加结果（追加行数、起始行号）
 */
export async function appendRows(
  filePath: string,
  sheetName: string,
  rows: CellValue[][],
): Promise<AppendRowsResult> {
  const workbook = await readXlsxWorkbook(filePath);

  let worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) {
    worksheet = workbook.addWorksheet(sheetName);
  }

  const startRow = worksheet.rowCount + 1;
  let appended = 0;
  for (const row of rows) {
    const rowObj = worksheet.addRow(row as ExcelJS.CellValue[]);
    // exceljs 的 addRow 已在 rowCount 末尾追加；显式保留行号以便调试
    void rowObj;
    appended++;
  }

  await workbook.xlsx.writeFile(filePath);
  return {
    path: filePath,
    sheet: sheetName,
    appendedRows: appended,
    startRow,
  };
}

/**
 * 更新指定单元格的值。
 *
 * @param filePath xlsx 文件绝对路径
 * @param sheetName sheet 名称
 * @param row 行号（1-based）
 * @param col 列号（1-based）
 * @param value 新值
 * @returns 更新结果（旧值、新值）
 */
export async function updateCell(
  filePath: string,
  sheetName: string,
  row: number,
  col: number,
  value: CellValue,
): Promise<UpdateCellResult> {
  if (row < 1 || col < 1) {
    throw new Error(`row and col must be 1-based positive integers (got row=${row}, col=${col})`);
  }

  const workbook = await readXlsxWorkbook(filePath);

  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${sheetName}" not found in ${filePath}`);
  }

  const cell = worksheet.getCell(row, col);
  const previousValue = (cell.value as CellValue) ?? null;
  cell.value = value as ExcelJS.CellValue;

  await workbook.xlsx.writeFile(filePath);
  return {
    path: filePath,
    sheet: sheetName,
    row,
    col,
    previousValue,
    newValue: value,
  };
}

export { colIndexToLetter };
