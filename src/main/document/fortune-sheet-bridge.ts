/**
 * Fortune-sheet 数据模型 ↔ exceljs 工作簿双向转换桥接。
 *
 *  - excelToFortune(workbook)：exceljs Workbook → Fortune-sheet WorkbookData
 *  - fortuneToExcel(data)：Fortune-sheet WorkbookData → exceljs Workbook
 *
 * 处理：单元格值（字符串/数字/布尔/日期/公式/富文本）、样式（字体/填充/对齐）、
 * 合并单元格、列宽/行高、sheet 名。
 *
 * officecli 创建的 xlsx 可能包含图表等高级特性，exceljs 读取时图表会丢失，
 * 此桥接只保留 exceljs 支持的单元格级数据。
 */

import ExcelJS from 'exceljs';
import type { Sheet, Cell, CellWithRowAndCol, SheetConfig } from '@fortune-sheet/core';

/** Fortune-sheet 工作簿数据格式（跨 IPC 传递的序列化载体） */
export type WorkbookData = {
  name: string;
  sheets: Sheet[];
};

// ─── 颜色转换 ──────────────────────────────────────────────────

/** exceljs ARGB ('FFRRGGBB') → Fortune-sheet hex ('#RRGGBB') */
function argbToHex(argb: string | undefined): string | undefined {
  if (!argb) return undefined;
  // ARGB 通常是 8 位（FF + 6 位 RGB），取后 6 位
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  return `#${hex.toUpperCase()}`;
}

/** Fortune-sheet hex ('#RRGGBB') → exceljs ARGB ('FFRRGGBB') */
function hexToArgb(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  return `FF${clean.toUpperCase()}`;
}

// ─── 地址解析 ──────────────────────────────────────────────────

/** 将 exceljs 列字母（如 'A', 'B', 'AA'）转为 0 基列号 */
function colLetterToIndex(letters: string): number {
  let result = 0;
  for (let i = 0; i < letters.length; i++) {
    result = result * 26 + (letters.charCodeAt(i) - 64);
  }
  return result - 1;
}

/** 解析 exceljs 合并范围字符串（如 'A1:B2'）为 0 基行列号 */
function parseRange(range: string): { top: number; left: number; bottom: number; right: number } {
  const [tl, br] = range.split(':');
  const tlMatch = tl.match(/([A-Z]+)(\d+)/);
  const brMatch = br.match(/([A-Z]+)(\d+)/);
  if (!tlMatch || !brMatch) throw new Error(`Invalid range: ${range}`);
  return {
    top: parseInt(tlMatch[2], 10) - 1,
    left: colLetterToIndex(tlMatch[1]),
    bottom: parseInt(brMatch[2], 10) - 1,
    right: colLetterToIndex(brMatch[1]),
  };
}

// ─── excelToFortune ────────────────────────────────────────────

/** exceljs 对齐方式 → Fortune-sheet ht（水平：0=center, 1=left, 2=right） */
function horizontalToHt(h: string | undefined): number | undefined {
  if (h === 'left') return 1;
  if (h === 'center' || h === 'centerContinuous') return 0;
  if (h === 'right') return 2;
  return undefined;
}

/** exceljs 对齐方式 → Fortune-sheet vt（垂直：0=middle, 1=top, 2=bottom） */
function verticalToVt(v: string | undefined): number | undefined {
  if (v === 'top') return 1;
  if (v === 'middle') return 0;
  if (v === 'bottom') return 2;
  return undefined;
}

/**
 * 将 exceljs 公式结果转为 Fortune-sheet Cell.v 接受的类型。
 * 处理 Date（转 ISO 字符串）和 CellErrorValue（取 error 字符串）。
 */
function formulaResultToCellValue(
  result: ExcelJS.CellFormulaValue['result'],
): string | number | boolean {
  if (result === undefined || result === null) return '';
  if (result instanceof Date) return result.toISOString();
  if (typeof result === 'object' && 'error' in result) return result.error;
  return result;
}

/** 将 exceljs 单元格值 + 样式转为 Fortune-sheet Cell */
function convertExcelCell(cell: ExcelJS.Cell): Cell | null {
  const value = cell.value;
  if (value === null || value === undefined) return null;

  // exceljs ValueType: 0=Null, 1=Merge, 2=Number, 3=String, 4=Date, 5=Hyperlink, 6=Formula, 7=SharedString, 8=RichText, 9=Boolean, 10=Error
  const type = cell.type;
  if (type === 0 || type === 1) return null; // Null / Merge 从属单元格

  const style = cell.style;
  const result: Cell = {};

  // 值转换
  if (type === 6) {
    // Formula
    const formulaValue = value as ExcelJS.CellFormulaValue;
    result.f = formulaValue.formula;
    result.v = formulaResultToCellValue(formulaValue.result);
    result.m = String(formulaResultToCellValue(formulaValue.result));
  } else if (type === 4) {
    // Date
    const date = value as Date;
    result.v = date.toISOString();
    result.m = date.toISOString().slice(0, 10);
    result.ct = { fa: style.numFmt || 'yyyy-mm-dd', t: 'd' };
  } else if (type === 9) {
    // Boolean
    result.v = value as boolean;
    result.m = value ? 'TRUE' : 'FALSE';
  } else if (type === 8) {
    // RichText — 合并为纯文本
    const rich = value as ExcelJS.CellRichTextValue;
    const text = rich.richText.map((rt) => rt.text).join('');
    result.v = text;
    result.m = text;
  } else if (type === 5) {
    // Hyperlink
    const link = value as ExcelJS.CellHyperlinkValue;
    result.v = link.text;
    result.m = link.text;
  } else if (type === 10) {
    // Error
    const err = value as ExcelJS.CellErrorValue;
    result.v = err.error;
    result.m = err.error;
  } else if (type === 2) {
    // Number
    result.v = value as number;
    result.m = String(value);
  } else if (type === 3 || type === 7) {
    // String / SharedString
    result.v = value as string;
    result.m = value as string;
  } else {
    result.v = String(value);
    result.m = String(value);
  }

  // 数字格式（非 Date 类型也保留 numFmt）
  if (type !== 4 && style.numFmt && style.numFmt !== 'General') {
    result.ct = { fa: style.numFmt, t: type === 2 ? 'n' : 's' };
  }

  // 字体样式
  const font = style.font;
  if (font) {
    if (font.bold) result.bl = 1;
    if (font.italic) result.it = 1;
    if (font.size) result.fs = font.size;
    if (font.name) result.ff = font.name;
    if (font.color?.argb) result.fc = argbToHex(font.color.argb);
  }

  // 填充色
  const fill = style.fill;
  if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
    const color = fill.fgColor?.argb || fill.bgColor?.argb;
    if (color) result.bg = argbToHex(color);
  }

  // 对齐
  const alignment = style.alignment;
  if (alignment) {
    const ht = horizontalToHt(alignment.horizontal);
    const vt = verticalToVt(alignment.vertical);
    if (ht !== undefined) result.ht = ht;
    if (vt !== undefined) result.vt = vt;
  }

  return result;
}

/** 将 exceljs Worksheet 转为 Fortune-sheet Sheet */
function convertWorksheet(ws: ExcelJS.Worksheet, order: number): Sheet {
  const celldata: CellWithRowAndCol[] = [];

  ws.eachRow((row, rowNum) => {
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      const fortuneCell = convertExcelCell(cell);
      if (fortuneCell !== null) {
        celldata.push({
          r: rowNum - 1,
          c: colNum - 1,
          v: fortuneCell,
        });
      }
    });
  });

  const config: SheetConfig = {};

  // 合并单元格
  const merges = ws.model.merges ?? [];
  if (merges.length > 0) {
    const mergeMap: Record<string, { r: number; c: number; rs: number; cs: number }> = {};
    for (const range of merges) {
      const { top, left, bottom, right } = parseRange(range);
      mergeMap[`${top}_${left}`] = {
        r: top,
        c: left,
        rs: bottom - top + 1,
        cs: right - left + 1,
      };
    }
    config.merge = mergeMap;
  }

  // 列宽
  const columnlen: Record<string, number> = {};
  for (let i = 1; i <= ws.columnCount; i++) {
    const col = ws.getColumn(i);
    if (col.width !== undefined) {
      columnlen[String(i - 1)] = col.width;
    }
  }
  if (Object.keys(columnlen).length > 0) {
    config.columnlen = columnlen;
  }

  // 行高
  const rowlen: Record<string, number> = {};
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (row.height !== undefined) {
      rowlen[String(rowNum - 1)] = row.height;
    }
  });
  if (Object.keys(rowlen).length > 0) {
    config.rowlen = rowlen;
  }

  const sheet: Sheet = {
    name: ws.name,
    celldata,
    order,
  };

  if (Object.keys(config).length > 0) {
    sheet.config = config;
  }

  return sheet;
}

/** exceljs Workbook → Fortune-sheet WorkbookData */
export function excelToFortune(workbook: ExcelJS.Workbook): WorkbookData {
  const sheets: Sheet[] = [];
  workbook.eachSheet((ws, id) => {
    sheets.push(convertWorksheet(ws, id - 1));
  });

  return {
    name: 'Workbook',
    sheets,
  };
}

// ─── fortuneToExcel ────────────────────────────────────────────

type ExcelHorizontalAlignment = ExcelJS.Alignment['horizontal'];
type ExcelVerticalAlignment = ExcelJS.Alignment['vertical'];

/** Fortune-sheet ht → exceljs horizontal 对齐 */
function htToHorizontal(ht: number | undefined): ExcelHorizontalAlignment | undefined {
  if (ht === 1) return 'left';
  if (ht === 0) return 'center';
  if (ht === 2) return 'right';
  return undefined;
}

/** Fortune-sheet vt → exceljs vertical 对齐 */
function vtToVertical(vt: number | undefined): ExcelVerticalAlignment | undefined {
  if (vt === 1) return 'top';
  if (vt === 0) return 'middle';
  if (vt === 2) return 'bottom';
  return undefined;
}

/** 从 Fortune-sheet Sheet 的 celldata 或 data 矩阵中提取所有非空单元格 */
function extractCells(sheet: Sheet): CellWithRowAndCol[] {
  if (sheet.celldata && sheet.celldata.length > 0) {
    return sheet.celldata;
  }
  // 从 data (CellMatrix) 转换
  const result: CellWithRowAndCol[] = [];
  if (sheet.data) {
    for (let r = 0; r < sheet.data.length; r++) {
      const row = sheet.data[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (cell !== null && cell !== undefined) {
          result.push({ r, c, v: cell });
        }
      }
    }
  }
  return result;
}

/** 将 Fortune-sheet Cell 的值设到 exceljs Cell 上 */
function setExcelCellValue(excelCell: ExcelJS.Cell, cell: Cell): void {
  const ct = cell.ct;
  const isDate = ct?.t === 'd';

  if (cell.f !== undefined) {
    // 公式单元格
    const result = isDate && typeof cell.v === 'string' ? new Date(cell.v) : cell.v;
    excelCell.value = { formula: cell.f, result: result ?? 0 };
  } else if (isDate && typeof cell.v === 'string') {
    // 日期单元格
    excelCell.value = new Date(cell.v);
  } else {
    // 普通值
    excelCell.value = cell.v ?? null;
  }
}

/** 将 Fortune-sheet Cell 的样式设到 exceljs Cell 上 */
function setExcelCellStyle(excelCell: ExcelJS.Cell, cell: Cell): void {
  const style: Partial<ExcelJS.Style> = {};

  // 字体
  const font: Partial<ExcelJS.Font> = {};
  if (cell.bl === 1) font.bold = true;
  if (cell.it === 1) font.italic = true;
  if (cell.fs !== undefined) font.size = cell.fs;
  if (cell.ff !== undefined) font.name = String(cell.ff);
  if (cell.fc) font.color = { argb: hexToArgb(cell.fc) };
  if (Object.keys(font).length > 0) style.font = font;

  // 填充
  if (cell.bg) {
    style.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: hexToArgb(cell.bg) },
    };
  }

  // 对齐
  const alignment: Partial<ExcelJS.Alignment> = {};
  const h = htToHorizontal(cell.ht);
  const v = vtToVertical(cell.vt);
  if (h !== undefined) alignment.horizontal = h;
  if (v !== undefined) alignment.vertical = v;
  if (Object.keys(alignment).length > 0) style.alignment = alignment;

  // 数字格式
  if (cell.ct?.fa && cell.ct.fa !== 'General') {
    style.numFmt = cell.ct.fa;
  }

  if (Object.keys(style).length > 0) {
    excelCell.style = style;
  }
}

/** Fortune-sheet WorkbookData → exceljs Workbook */
export async function fortuneToExcel(data: WorkbookData): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();

  for (const sheet of data.sheets) {
    const ws = workbook.addWorksheet(sheet.name);

    // 写入单元格值和样式
    const cells = extractCells(sheet);
    for (const { r, c, v } of cells) {
      if (v === null) continue;
      const excelCell = ws.getCell(r + 1, c + 1);
      setExcelCellValue(excelCell, v);
      setExcelCellStyle(excelCell, v);
    }

    // 合并单元格
    const merges = sheet.config?.merge ?? {};
    for (const key of Object.keys(merges)) {
      const { r, c, rs, cs } = merges[key];
      const top = r + 1;
      const left = c + 1;
      const bottom = r + rs;
      const right = c + cs;
      ws.mergeCells(top, left, bottom, right);
    }

    // 列宽
    const columnlen = sheet.config?.columnlen ?? {};
    for (const key of Object.keys(columnlen)) {
      const colIndex = parseInt(key, 10);
      ws.getColumn(colIndex + 1).width = columnlen[key];
    }

    // 行高
    const rowlen = sheet.config?.rowlen ?? {};
    for (const key of Object.keys(rowlen)) {
      const rowIndex = parseInt(key, 10);
      ws.getRow(rowIndex + 1).height = rowlen[key];
    }
  }

  return workbook;
}

// 重导出常用类型供外部使用
export type { Sheet, Cell, CellWithRowAndCol };
