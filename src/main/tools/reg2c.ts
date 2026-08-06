/**
 * Reg2C — Register table → C driver header file generator.
 *
 * Ported from the Python `reg2c` plugin (`parser_engine.py` + Jinja2 templates).
 * Features: parse Excel register tables (adaptive header detection),
 * generate C macros, struct, and access functions.
 *
 * Key fix: Uses SheetJS (xlsx) for .xls files (OLE/binary format) which ExcelJS
 * cannot read, and ExcelJS for .xlsx files (ZIP/OOXML format). File format is
 * detected by magic bytes, not extension, to handle mismatched extensions.
 */

import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';

// ── Types ──────────────────────────────────────────────────────────

export type RegField = {
  bit: string; // "30:0" or "0"
  bitStart: number; // high bit
  bitEnd: number; // low bit
  bitWidth: number;
  name: string;
  rw: string; // "RW" | "RO" | "WO"
  reset: string;
  desc: string;
};

export type RegRegister = {
  offset: number;
  name: string;
  width: number;
  shortDesc: string;
  fields: RegField[];
};

export type RegData = {
  moduleName: string;
  baseAddr: number;
  registers: RegRegister[];
};

// ── Unified worksheet interface ────────────────────────────────────

/**
 * Unified worksheet interface that abstracts the differences between
 * ExcelJS (used for .xlsx) and SheetJS (used for .xls).
 * Both use 1-indexed row/column numbers.
 */
interface UnifiedWorksheet {
  getCell(row: number, col: number): { value: unknown };
  rowCount: number;
  columnCount: number;
}

/** Wrap an ExcelJS worksheet to conform to the unified interface. */
class ExcelJsWorksheetWrapper implements UnifiedWorksheet {
  constructor(private ws: ExcelJS.Worksheet) {}

  getCell(row: number, col: number): { value: unknown } {
    return { value: this.ws.getCell(row, col).value };
  }

  get rowCount(): number {
    return this.ws.rowCount;
  }

  get columnCount(): number {
    return this.ws.columnCount;
  }
}

/** Wrap a SheetJS worksheet to conform to the unified interface. */
class SheetJsWorksheetWrapper implements UnifiedWorksheet {
  private range: XLSX.Range;

  constructor(private ws: XLSX.WorkSheet) {
    this.range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:A1');
  }

  getCell(row: number, col: number): { value: unknown } {
    // SheetJS uses 0-indexed addresses
    const addr = XLSX.utils.encode_cell({ r: row - 1, c: col - 1 });
    const cell = this.ws[addr];
    return { value: cell ? cell.v : null };
  }

  get rowCount(): number {
    return this.range.e.r + 1; // 0-indexed → count
  }

  get columnCount(): number {
    return this.range.e.c + 1;
  }
}

// ── Magic bytes file format detection ──────────────────────────────

/**
 * Detect whether a file is OLE2 format (binary .xls) by reading magic bytes.
 * OLE2 files start with: D0 CF 11 E0 A1 B1 1A E1
 * ZIP/OOXML files (.xlsx) start with: 50 4B 03 04
 */
function isOle2File(filePath: string): boolean {
  try {
    const buf = readFileSync(filePath, { encoding: null });
    if (buf.length < 8) return false;
    return (
      buf[0] === 0xd0 &&
      buf[1] === 0xcf &&
      buf[2] === 0x11 &&
      buf[3] === 0xe0 &&
      buf[4] === 0xa1 &&
      buf[5] === 0xb1 &&
      buf[6] === 0x1a &&
      buf[7] === 0xe1
    );
  } catch {
    return false;
  }
}

// ── Column name cleaning & mapping ─────────────────────────────────

/** Clean a column name: remove spaces, underscores, slashes, lowercase. */
function cleanColumnName(col: unknown): string {
  return String(col).replace(/[ _/]/g, '').toLowerCase();
}

/** Normalize RW value: "R/W" → "RW". */
function normalizeRw(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase().replace('/', '');
}

// ── Excel cell value helpers ────────────────────────────────────────

/**
 * Get cell value as string, handling null/undefined and ExcelJS formula objects.
 * This handles ExcelJS formula cells ({ formula, result }) and rich text.
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';

  // Handle ExcelJS formula objects
  if (typeof value === 'object' && value !== null) {
    // Formula cell: { formula: string, result: value }
    if ('result' in value && value.result !== undefined && value.result !== null) {
      return String(value.result).trim();
    }
    // Rich text: { richText: [{ text: string }] }
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText
        .map((rt: { text?: string }) => rt.text || '')
        .join('')
        .trim();
    }
    // Hyperlink: { text: string, hyperlink: string }
    if ('text' in value && typeof value.text === 'string') {
      return value.text.trim();
    }
  }

  return String(value).trim();
}

// ── Valid sheet selection ──────────────────────────────────────────

/** Find valid (visible, non-empty) sheet in ExcelJS workbook. */
function getValidSheetFromExcelJs(workbook: ExcelJS.Workbook): ExcelJS.Worksheet | null {
  for (const ws of workbook.worksheets) {
    // Skip hidden sheets
    if (ws.state !== 'visible') continue;
    // Skip empty sheets
    if (ws.rowCount <= 1 && ws.columnCount <= 1) {
      const cell = ws.getCell(1, 1).value;
      if (cell === null || cell === undefined) continue;
    }
    return ws;
  }
  return workbook.worksheets[0] ?? null;
}

/**
 * Find valid (visible, non-empty) sheet in SheetJS workbook.
 * Mirrors the Python `_get_valid_sheet_name()` logic using xlrd/openpyxl.
 */
function getValidSheetFromSheetJs(workbook: XLSX.WorkBook): XLSX.WorkSheet | null {
  for (let i = 0; i < workbook.SheetNames.length; i++) {
    const name = workbook.SheetNames[i];
    // Check if sheet is hidden (SheetJS stores visibility in Workbook.Sheets)
    const sheetProps = workbook.Workbook?.Sheets;
    if (sheetProps && sheetProps[i]?.Hidden && sheetProps[i].Hidden !== 0) {
      continue; // Skip hidden sheets (Hidden: 0=visible, 1=hidden, 2=very hidden)
    }

    const ws = workbook.Sheets[name];
    if (!ws) continue;

    // Skip empty sheets (no data range)
    const ref = ws['!ref'];
    if (!ref) continue;

    const range = XLSX.utils.decode_range(ref);
    // Check if single-cell range and that cell is empty
    if (range.e.r === 0 && range.e.c === 0) {
      const cellAddr = XLSX.utils.encode_cell({ r: 0, c: 0 });
      const cell = ws[cellAddr];
      if (!cell || cell.v === null || cell.v === undefined) continue;
    }

    return ws;
  }
  // Fallback to first sheet
  const firstName = workbook.SheetNames[0];
  return firstName ? workbook.Sheets[firstName] ?? null : null;
}

// ── Worksheet loading ──────────────────────────────────────────────

/**
 * Load a worksheet from a file, using the appropriate library based on
 * actual file format (detected by magic bytes, not extension).
 * - OLE2 (binary .xls): SheetJS
 * - ZIP (OOXML .xlsx): ExcelJS
 *
 * This fixes the "Can't find end of central directory: is this a zip file?"
 * error that occurs when ExcelJS tries to read an OLE2 file as ZIP.
 */
async function loadWorksheet(filePath: string): Promise<UnifiedWorksheet> {
  const isOle2 = isOle2File(filePath);

  if (isOle2) {
    // SheetJS for OLE2/.xls files — this fixes the "Can't find end of central directory" error
    const workbook = XLSX.readFile(filePath, { type: 'file' });
    const ws = getValidSheetFromSheetJs(workbook);
    if (!ws) {
      throw new Error('Excel 文件中没有有效工作表');
    }
    return new SheetJsWorksheetWrapper(ws);
  }

  // ExcelJS for ZIP/.xlsx files
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const ws = getValidSheetFromExcelJs(workbook);
  if (!ws) {
    throw new Error('Excel 文件中没有有效工作表');
  }
  return new ExcelJsWorksheetWrapper(ws);
}

// ── Excel parsing ───────────────────────────────────────────────────

/** Parse Excel register file with adaptive header detection. */
export async function parseRegisterFile(
  excelPath: string,
): Promise<RegData> {
  if (!existsSync(excelPath)) {
    throw new Error(`文件不存在: ${excelPath}`);
  }

  const ext = extname(excelPath).toLowerCase();
  if (ext !== '.xlsx' && ext !== '.xls') {
    throw new Error('不支持的文件格式，请使用 .xlsx 或 .xls');
  }

  // Load worksheet using the appropriate library (format detected by magic bytes)
  const ws = await loadWorksheet(excelPath);

  // Scan for Module Name and BASE ADDR (search first 20 rows, all columns)
  let moduleName = 'module';
  let baseAddr = 0;

  const maxScanRow = Math.min(ws.rowCount, 20);

  for (let row = 1; row <= maxScanRow; row++) {
    for (let col = 1; col <= ws.columnCount; col++) {
      const cellVal = cellToString(ws.getCell(row, col).value).toLowerCase();

      if (cellVal.includes('module name')) {
        // Next column has the value
        moduleName = cellToString(ws.getCell(row, col + 1).value) || moduleName;
      }

      if (cellVal.includes('base addr')) {
        const baseStr = cellToString(ws.getCell(row, col + 1).value);
        const cleaned = baseStr.replace(/[_ ]/g, '').toLowerCase();
        if (cleaned.startsWith('0x')) {
          baseAddr = parseInt(cleaned, 16) || 0;
        } else {
          baseAddr = parseInt(cleaned, 16) || 0;
        }
      }
    }
  }

  // Adaptive header row detection (matching Python: scan first 20 rows for keywords)
  const requiredKeywords = ['offset', 'regname', 'bit', 'fieldname', 'rw', 'resetvalue', 'description'];
  let headerRow = -1;

  for (let row = 1; row <= Math.min(20, ws.rowCount); row++) {
    const rowValues: string[] = [];
    for (let col = 1; col <= ws.columnCount; col++) {
      const val = ws.getCell(row, col).value;
      if (val !== null && val !== undefined) {
        rowValues.push(String(val).toLowerCase());
      }
    }
    const rowText = rowValues.join(' ');
    const keywordCount = requiredKeywords.filter((kw) => rowText.includes(kw)).length;
    if (keywordCount >= 4) {
      headerRow = row;
      break;
    }
  }

  // Default header row if not found (match Python fallback: module_row + 7, or offset row, or 9)
  if (headerRow === -1) {
    headerRow = 10; // Match Python default (skip 9 rows, header at row 10)
  }

  // Build column mapping from header row
  const columnMap: Record<string, number> = {};
  const headerCols: { cleaned: string; col: number }[] = [];

  // First pass: exact keyword matching (matching Python's clean_column_name + includes)
  for (let col = 1; col <= ws.columnCount; col++) {
    const headerVal = ws.getCell(headerRow, col).value;
    const cleanedCol = cleanColumnName(headerVal);
    headerCols.push({ cleaned: cleanedCol, col });
    for (const reqCol of requiredKeywords) {
      if (cleanedCol.includes(reqCol) && !(reqCol in columnMap)) {
        columnMap[reqCol] = col;
        break;
      }
    }
  }

  // Loose column name matching fallback (matching Python's fallback logic)
  // Python: if any(keyword in col.lower() for keyword in [req_col[:4], req_col[-4:]])
  const usedCols = new Set(Object.values(columnMap));
  for (const reqCol of requiredKeywords) {
    if (reqCol in columnMap) continue;
    const prefix = reqCol.slice(0, 4);
    const suffix = reqCol.slice(-4);
    for (const { cleaned, col } of headerCols) {
      if (usedCols.has(col)) continue;
      if (cleaned.includes(prefix) || cleaned.includes(suffix)) {
        columnMap[reqCol] = col;
        usedCols.add(col);
        break;
      }
    }
  }

  // Check for width column (not in requiredKeywords, but needed)
  if (!('width' in columnMap)) {
    for (const { cleaned, col } of headerCols) {
      if (cleaned.includes('width') && !usedCols.has(col)) {
        columnMap.width = col;
        usedCols.add(col);
        break;
      }
    }
  }

  // Also check for shortdescription column
  if (!('shortdescription' in columnMap)) {
    for (const { cleaned, col } of headerCols) {
      if (cleaned.includes('shortdesc') && !usedCols.has(col)) {
        columnMap.shortdescription = col;
        usedCols.add(col);
        break;
      }
    }
  }

  // Check for missing required columns
  const missingCols = requiredKeywords.filter((kw) => !(kw in columnMap));
  if (missingCols.length > 0) {
    throw new Error(`缺失必要列: ${missingCols.join(', ')}，请检查 Excel 表格格式`);
  }

  // Ensure width has a default if not found
  if (!('width' in columnMap)) {
    // No width column — will default to 32 for all registers
  }

  // Parse data rows
  const dataStartRow = headerRow + 1;
  const registers: RegRegister[] = [];
  let currentReg: RegRegister | null = null;
  let prevOffset: number | null = null;

  // Forward fill tracking for merged cells (matching Python's ffill behavior)
  let lastRegName = '';
  let lastOffset = '';
  let lastWidth = 32;
  let lastDesc = '';
  const hasWidthCol = 'width' in columnMap;

  for (let row = dataStartRow; row <= ws.rowCount; row++) {
    // Get values using column mapping
    const getVal = (key: string): string => {
      const col = columnMap[key];
      if (!col) return '';
      const v = ws.getCell(row, col).value;
      return cellToString(v);
    };

    let regName = getVal('regname');
    let offsetStr = getVal('offset');
    let widthStr = hasWidthCol ? getVal('width') : '';
    const bitStr = getVal('bit');
    const fieldName = getVal('fieldname');
    const rwStr = getVal('rw');
    const resetStr = getVal('resetvalue');
    let descStr = getVal('description') || getVal('shortdescription');
    const shortDescStr = getVal('shortdescription') || '';

    // Forward fill for merged cells (matching Python's ffill)
    if (regName) lastRegName = regName;
    else regName = lastRegName;

    if (offsetStr) lastOffset = offsetStr;
    else offsetStr = lastOffset;

    // Width: if column exists, fillna(0) then ffill (matching Python)
    // If column doesn't exist, default to 32
    if (hasWidthCol) {
      if (widthStr) {
        const parsedW = parseInt(widthStr, 10);
        if (!isNaN(parsedW)) lastWidth = parsedW;
      }
      // Forward fill: use lastWidth if current is blank
      widthStr = String(lastWidth);
    } else {
      widthStr = '32';
    }

    if (descStr) lastDesc = descStr;
    else descStr = lastDesc;

    // Validate offset — skip rows with invalid offset
    if (!offsetStr) continue;
    let currentOffset: number;
    const cleanedOffset = offsetStr.replace(/_/g, '').toLowerCase();
    if (cleanedOffset.startsWith('0x')) {
      currentOffset = parseInt(cleanedOffset, 16);
      if (isNaN(currentOffset)) continue;
    } else {
      currentOffset = parseInt(cleanedOffset, 10);
      if (isNaN(currentOffset)) continue;
    }

    // New register boundary (offset changed) — matching Python's logic
    if (currentOffset !== prevOffset) {
      if (currentReg) {
        registers.push(currentReg);
      }

      currentReg = {
        offset: currentOffset,
        name: regName || `REG_${currentOffset}`,
        width: parseInt(widthStr, 10) || 32,
        shortDesc: shortDescStr,
        fields: [],
      };
      prevOffset = currentOffset;
    }

    // Parse field
    if (bitStr && fieldName && rwStr) {
      // Skip reserved fields (matching Python: 'reserved' in fieldname.lower())
      if (fieldName.toLowerCase().includes('reserved')) continue;

      // Parse bit range (matching Python's regex: \[(\d+)(?::(\d+))?\])
      let bitStart: number;
      let bitEnd: number;
      let bitWidth: number;

      const bracketMatch = bitStr.match(/\[(\d+)(?::(\d+))?\]/);
      if (bracketMatch) {
        bitStart = parseInt(bracketMatch[1], 10);
        bitEnd = bracketMatch[2] ? parseInt(bracketMatch[2], 10) : bitStart;
        // Ensure bitStart is always the high bit (matching Python's swap logic)
        if (bitStart < bitEnd) {
          [bitStart, bitEnd] = [bitEnd, bitStart];
        }
        bitWidth = bitStart - bitEnd + 1;
      } else {
        bitStart = parseInt(bitStr, 10);
        if (isNaN(bitStart)) continue;
        bitEnd = bitStart;
        bitWidth = 1;
      }

      // Clean field name: remove non-alphanumeric chars except underscore
      // Matching Python: ''.join(c if c.isalnum() or c == '_' else '' for c in str(fieldname))
      const cleanedFieldName = fieldName.replace(/[^a-zA-Z0-9_]/g, '');

      currentReg?.fields.push({
        bit: bitStart === bitEnd ? String(bitStart) : `${bitStart}:${bitEnd}`,
        bitStart,
        bitEnd,
        bitWidth,
        name: cleanedFieldName,
        rw: normalizeRw(rwStr),
        reset: resetStr,
        desc: descStr,
      });
    }
  }

  if (currentReg) {
    registers.push(currentReg);
  }

  return {
    moduleName,
    baseAddr,
    registers,
  };
}

// ── C code generation ──────────────────────────────────────────────

/** Generate C macros section. */
function generateMacros(regData: RegData): string {
  const lines: string[] = [];
  const modUpper = regData.moduleName.toUpperCase();

  lines.push(`#ifndef ${modUpper}_H`);
  lines.push(`#define ${modUpper}_H`);
  lines.push('');
  lines.push('#include <stdint.h>');
  lines.push('');
  lines.push(`#define ${modUpper}_BASE_ADDR 0x${regData.baseAddr.toString(16).toUpperCase().padStart(8, '0')}`);
  lines.push('');
  lines.push('// Register offset macro definitions');

  for (const reg of regData.registers) {
    lines.push(`#define ${reg.name.toUpperCase()}_OFFSET 0x${reg.offset.toString(16).toUpperCase().padStart(4, '0')}`);
  }
  lines.push('');

  // Register and field definitions
  for (const reg of regData.registers) {
    lines.push(`/* ${reg.name} - ${reg.shortDesc} */`);
    lines.push('typedef union {');
    lines.push('    struct {');
    // Reverse fields for bit ordering
    for (let i = reg.fields.length - 1; i >= 0; i--) {
      const field = reg.fields[i];
      lines.push(`        uint32_t ${field.name} : ${field.bitWidth};  // ${field.bit} ${field.rw}`);
    }
    lines.push('    } bits;');
    lines.push('    uint32_t value;');
    lines.push(`} ${reg.name}_t;`);

    for (const field of reg.fields) {
      lines.push(`#define ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_WIDTH ${field.bitWidth}`);
      lines.push(`#define ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_MASK ((1UL << ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_WIDTH) - 1UL)`);
      lines.push(`#define ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_POS  ${field.bitEnd}`);
    }
    lines.push('');
  }

  // Bit field operation macros
  for (const reg of regData.registers) {
    lines.push(`/* ${reg.name} access macros */`);
    lines.push(`#define ${reg.name.toUpperCase()}_READ() \\`);
    lines.push(`    (*((volatile uint32_t*)(${modUpper}_BASE_ADDR + ${reg.offset})))`);
    lines.push(`#define ${reg.name.toUpperCase()}_WRITE(value) \\`);
    lines.push(`    (*((volatile uint32_t*)(${modUpper}_BASE_ADDR + ${reg.offset})) = (value))`);

    for (const field of reg.fields) {
      lines.push(`/* ${field.name} bit field operations */`);
      lines.push(`#define ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_GET() \\`);
      lines.push(`    ((${reg.name.toUpperCase()}_READ() >> ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_POS) & ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_MASK)`);

      if (field.rw === 'RW') {
        lines.push(`#define ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_SET(value) \\`);
        lines.push(`    ${reg.name.toUpperCase()}_WRITE( \\`);
        lines.push(`        (${reg.name.toUpperCase()}_READ() & ~(${reg.name.toUpperCase()}_${field.name.toUpperCase()}_MASK << ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_POS) \\`);
        lines.push(`        | ((value) << ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_POS) \\`);
        lines.push(`    )`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Generate C struct section. */
function generateStruct(regData: RegData): string {
  const lines: string[] = [];
  const sorted = [...regData.registers].sort((a, b) => a.offset - b.offset);

  lines.push('// Register structure definition');
  lines.push('typedef struct {');

  let prevOffset = 0;
  for (const reg of sorted) {
    if (reg.offset > prevOffset) {
      const padCount = Math.floor((reg.offset - prevOffset) / 4);
      if (padCount > 0) {
        lines.push(`    uint32_t PAD_0x${prevOffset.toString(16).toUpperCase().padStart(4, '0')}[${padCount}]; // 0x${prevOffset.toString(16).toUpperCase().padStart(4, '0')} - 0x${(reg.offset - 1).toString(16).toUpperCase().padStart(4, '0')}`);
      }
    }
    lines.push(`    volatile uint32_t ${reg.name}; // 0x${reg.offset.toString(16).toUpperCase().padStart(4, '0')}`);
    prevOffset = reg.offset + 4;
  }

  lines.push(`} ${regData.moduleName}_t;`);

  return lines.join('\n');
}

/** Generate C functions section. */
function generateFunctions(regData: RegData): string {
  const lines: string[] = [];
  const modUpper = regData.moduleName.toUpperCase();

  lines.push('// Register access functions');

  for (const reg of regData.registers) {
    for (const field of reg.fields) {
      if (field.rw === 'RW') {
        lines.push(`static inline void ${reg.name}_${field.name}_set(uint32_t value) {`);
        lines.push(`    ${regData.moduleName}_t *regs = (${regData.moduleName}_t *)${modUpper}_BASE_ADDR;`);
        lines.push(`    regs->${reg.name} = (regs->${reg.name} & ~(${reg.name.toUpperCase()}_${field.name.toUpperCase()}_MASK << ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_POS)) | ((value & ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_MASK) << ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_POS);`);
        lines.push('}');
        lines.push('');
      }

      lines.push(`static inline uint32_t ${reg.name}_${field.name}_get() {`);
      lines.push(`    ${regData.moduleName}_t *regs = (${regData.moduleName}_t *)${modUpper}_BASE_ADDR;`);
      lines.push(`    return (regs->${reg.name} >> ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_POS) & ${reg.name.toUpperCase()}_${field.name.toUpperCase()}_MASK;`);
      lines.push('}');
      lines.push('');
    }
  }

  lines.push(`#endif ${modUpper}_H`);

  return lines.join('\n');
}

/** Generate complete C header file. */
export function generateCHeader(regData: RegData): string {
  const macros = generateMacros(regData);
  const struct = generateStruct(regData);
  const functions = generateFunctions(regData);

  return [macros, struct, functions].join('\n\n');
}

/** Generate preview of the three C code sections. */
export function generatePreview(regData: RegData): {
  macros: string;
  struct: string;
  functions: string;
} {
  return {
    macros: generateMacros(regData),
    struct: generateStruct(regData),
    functions: generateFunctions(regData),
  };
}
