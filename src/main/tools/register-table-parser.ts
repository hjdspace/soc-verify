/**
 * Register Table Parser — Excel register specification table parser.
 *
 * Ported from the Python `register_table_parser` plugin (`parser.py` + `models.py` + `utils.py`).
 * Features: parse .xlsx/.xls register tables, extract header info + register + field data,
 * auto-fix Excel format issues (BOM, zero-width spaces, etc.).
 *
 * Key fix: Uses SheetJS (xlsx) for .xls files (OLE/binary format) which ExcelJS cannot read,
 * and ExcelJS for .xlsx files (ZIP/OOXML format) which is already used elsewhere in the project.
 */

import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';

// ── Types ──────────────────────────────────────────────────────────

export type HeaderInfo = {
  projectName: string;
  subSystem: string;
  moduleName: string;
  baseAddr: string;
};

export type FieldInfo = {
  name: string;
  bitRange: string; // "30:0" or "0"
  rwAttribute: string; // "RW" | "RO" | "WO"
  resetValue: string;
  description: string;
};

export type RegisterInfo = {
  offset: string; // "0x0004"
  name: string;
  description: string;
  width: number;
  fields: FieldInfo[];
};

export type RegisterTableData = {
  header: HeaderInfo;
  registers: RegisterInfo[];
};

// ── Column mapping (1-indexed, matching Python original) ────────────

const COLUMN_MAPPING = {
  offset: 1, // A: Offset
  regName: 2, // B: RegName
  width: 5, // E: Width
  bitRange: 8, // H: Bit
  fieldName: 9, // I: FieldName
  rw: 10, // J: RW
  resetValue: 11, // K: ResetValue
  setClear: 12, // L: Set/Clear
} as const;

const HEADER_ROW = 10;
const DATA_START_ROW = 12;

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

// ── Cell value cleaning ─────────────────────────────────────────────

/** Clean a cell value: strip BOM, zero-width spaces, non-breaking spaces. */
function cleanCellValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') return value;

  if (typeof value === 'string') {
    let cleaned = value.trim();
    cleaned = cleaned.replace(/\ufeff/g, ''); // BOM
    cleaned = cleaned.replace(/\u200b/g, ''); // Zero-width space
    cleaned = cleaned.replace(/\xa0/g, ' '); // Non-breaking space
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!cleaned) return null;
    return cleaned;
  }

  // Boolean (exceljs returns booleans for TRUE/FALSE cells)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

  return String(value).trim() || null;
}

// ── Bit range parsing ──────────────────────────────────────────────

/** Parse a bit range string like "[30:0]" or "[0]" → "30:0" or "0". */
function parseBitRangeBrackets(raw: string): string {
  if (!raw) return '';

  let bitRange = raw.trim();
  // Remove brackets
  if (bitRange.startsWith('[') && bitRange.endsWith(']')) {
    bitRange = bitRange.slice(1, -1);
  }

  if (bitRange.includes(':')) {
    const parts = bitRange.split(':');
    if (parts.length === 2) {
      const high = parseInt(parts[0].trim(), 10);
      const low = parseInt(parts[1].trim(), 10);
      if (!isNaN(high) && !isNaN(low) && high >= low && low >= 0) {
        return `${high}:${low}`;
      }
    }
  } else {
    const bitNum = parseInt(bitRange.trim(), 10);
    if (!isNaN(bitNum) && bitNum >= 0) {
      return String(bitNum);
    }
  }

  return '';
}

// ── Address normalization ──────────────────────────────────────────

/** Normalize an address to 0xNNNN format. */
function normalizeAddress(address: unknown): string {
  if (address === null || address === undefined) return '0x0000';

  let addrStr = String(address).trim();

  // Handle underscore-separated hex
  addrStr = addrStr.replace(/_/g, '');

  if (addrStr.toLowerCase().startsWith('0x')) {
    try {
      const addrInt = parseInt(addrStr, 16);
      return `0x${addrInt.toString(16).toUpperCase().padStart(4, '0')}`;
    } catch {
      return addrStr.toUpperCase();
    }
  }

  try {
    const addrInt = parseInt(addrStr, 10);
    return `0x${addrInt.toString(16).toUpperCase().padStart(4, '0')}`;
  } catch {
    return addrStr;
  }
}

// ── Width parsing ──────────────────────────────────────────────────

/** Parse register width from various formats. */
function parseWidth(value: unknown): number {
  if (value === null || value === undefined) return 32;

  if (typeof value === 'number') return Math.floor(value);

  const str = String(value).trim();
  if (!str) return 32;

  // Try float parsing (handles "32.0")
  const floatVal = parseFloat(str);
  if (!isNaN(floatVal)) return Math.floor(floatVal);

  // Extract digits
  const match = str.match(/\d+/);
  if (match) return parseInt(match[0], 10);

  return 32;
}

// ── Header extraction ───────────────────────────────────────────────

/** Extract header info from the first 4 rows. */
function extractHeaderInfo(ws: UnifiedWorksheet): HeaderInfo {
  const header: HeaderInfo = {
    projectName: '',
    subSystem: '',
    moduleName: '',
    baseAddr: '',
  };

  for (let row = 1; row <= 4; row++) {
    const cellA = ws.getCell(row, 1).value;
    const cellB = ws.getCell(row, 2).value;

    const label = cleanCellValue(cellA);
    const value = cleanCellValue(cellB);

    if (label && value && typeof label === 'string' && typeof value === 'string') {
      const labelLower = label.toLowerCase();

      if (labelLower.includes('project') || labelLower.includes('proj') || labelLower.includes('项目')) {
        header.projectName = value;
      } else if (labelLower.includes('sub') || labelLower.includes('system') || labelLower.includes('子系统') || labelLower.includes('系统')) {
        header.subSystem = value;
      } else if (labelLower.includes('module') || labelLower.includes('mod') || labelLower.includes('模块')) {
        header.moduleName = value;
      } else if (labelLower.includes('base') || labelLower.includes('addr') || labelLower.includes('address') || labelLower.includes('基地址') || labelLower.includes('地址')) {
        header.baseAddr = value;
      }
    }
  }

  // Defaults for missing fields
  if (!header.projectName) header.projectName = '未知项目';
  if (!header.subSystem) header.subSystem = '未知子系统';
  if (!header.moduleName) header.moduleName = '未知模块';
  if (!header.baseAddr) header.baseAddr = '0x0000';

  return header;
}

// ── Register data extraction ───────────────────────────────────────

/** Extract a row's data by fixed column positions. */
function extractRowData(
  ws: UnifiedWorksheet,
  rowNum: number,
): Record<string, string | number | null> {
  const row: Record<string, string | number | null> = {};

  for (const [colType, colNum] of Object.entries(COLUMN_MAPPING)) {
    const cellValue = ws.getCell(rowNum, colNum).value;
    row[colType] = cleanCellValue(cellValue);
  }

  return row;
}

/** Create a FieldInfo object from row data (new format). */
function createFieldInfo(
  rowData: Record<string, string | number | null>,
  _rowNum: number,
): FieldInfo | null {
  const fieldNameRaw = rowData.fieldName;
  const fieldName =
    typeof fieldNameRaw === 'string' ? fieldNameRaw.trim() : fieldNameRaw !== null ? String(fieldNameRaw).trim() : '';
  if (!fieldName) return null;

  // Skip reserved fields
  if (fieldName.toLowerCase() === 'reserved' || fieldName.toLowerCase() === 'rsvd' || fieldName === '保留') {
    return null;
  }

  // Parse bit range
  const bitRangeRaw = rowData.bitRange;
  const bitRangeStr = bitRangeRaw !== null ? String(bitRangeRaw).trim() : '';
  const bitRange = parseBitRangeBrackets(bitRangeStr);
  if (!bitRange) return null;

  // Parse RW attribute
  const rwRaw = rowData.rw;
  let rwAttr = rwRaw !== null ? String(rwRaw).trim().toUpperCase() : 'RW';
  if (!rwAttr) rwAttr = 'RW';

  // Parse reset value
  const resetRaw = rowData.resetValue;
  let resetValue = resetRaw !== null ? String(resetRaw).trim() : '0';
  if (!resetValue) resetValue = '0';

  // Set/Clear description
  const setClearRaw = rowData.setClear;
  const setClear = setClearRaw !== null ? String(setClearRaw).trim() : '';
  const description = setClear ? `Set/Clear: ${setClear}` : '';

  return {
    name: fieldName,
    bitRange,
    rwAttribute: rwAttr,
    resetValue,
    description,
  };
}

/** Extract register data from the worksheet. */
function extractRegisterData(ws: UnifiedWorksheet): RegisterInfo[] {
  const registers: RegisterInfo[] = [];
  let currentRegister: RegisterInfo | null = null;

  const maxRow = ws.rowCount;

  for (let rowNum = DATA_START_ROW; rowNum <= maxRow; rowNum++) {
    const rowData = extractRowData(ws, rowNum);

    // Skip empty rows
    const hasData = Object.values(rowData).some(
      (v) => v !== null && String(v).trim() !== '',
    );
    if (!hasData) continue;

    // Skip "Register group" rows
    const regNameRaw = rowData.regName;
    const regName = regNameRaw !== null ? String(regNameRaw).trim() : '';
    if (regName.toLowerCase() === 'register group') continue;

    // Check if new register (has offset + regName)
    const offsetRaw = rowData.offset;
    const offsetStr = offsetRaw !== null ? String(offsetRaw).trim() : '';
    const regNameStr = regName;

    if (offsetStr && regNameStr) {
      // Save previous register
      if (currentRegister) {
        registers.push(currentRegister);
      }

      // Create new register
      currentRegister = {
        offset: normalizeAddress(offsetRaw),
        name: regNameStr,
        description: '',
        width: parseWidth(rowData.width ?? 32),
        fields: [],
      };
    }

    // Extract field info
    const fieldNameRaw = rowData.fieldName;
    const fieldName = fieldNameRaw !== null ? String(fieldNameRaw).trim() : '';
    if (currentRegister && fieldName) {
      const field = createFieldInfo(rowData, rowNum);
      if (field) {
        currentRegister.fields.push(field);
      }
    }
  }

  // Add the last register
  if (currentRegister) {
    registers.push(currentRegister);
  }

  return registers;
}

// ── Validation ─────────────────────────────────────────────────────

/** Validate registers for duplicates and completeness. */
function validateRegisters(registers: RegisterInfo[]): void {
  if (registers.length === 0) {
    throw new Error('验证错误: 未找到有效的寄存器数据');
  }

  // Check duplicate register names
  const nameCounts: Record<string, number> = {};
  for (const reg of registers) {
    nameCounts[reg.name] = (nameCounts[reg.name] ?? 0) + 1;
  }
  const dupNames = Object.entries(nameCounts)
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
  if (dupNames.length > 0) {
    throw new Error(`验证错误: 发现重复的寄存器名称: ${dupNames.join(', ')}`);
  }

  // Check duplicate offsets
  const offsetCounts: Record<string, number> = {};
  for (const reg of registers) {
    offsetCounts[reg.offset] = (offsetCounts[reg.offset] ?? 0) + 1;
  }
  const dupOffsets = Object.entries(offsetCounts)
    .filter(([, count]) => count > 1)
    .map(([offset]) => offset);
  if (dupOffsets.length > 0) {
    throw new Error(`验证错误: 发现重复的偏移地址: ${dupOffsets.join(', ')}`);
  }
}

// ── Excel format auto-fix ───────────────────────────────────────────

/** Check if the Excel file needs format fixing. */
function checkIfNeedsFormatFix(ws: UnifiedWorksheet): boolean {
  let issuesFound = 0;

  // Check header area (first 4 rows)
  for (let row = 1; row <= 4; row++) {
    for (let col = 1; col <= 2; col++) {
      const value = ws.getCell(row, col).value;
      if (value && typeof value === 'string') {
        if (value.includes('\ufeff') || value.includes('\u200b') || value.includes('\xa0')) {
          issuesFound++;
        }
      }
    }
  }

  // Check header row (row 10)
  for (let col = 1; col <= 12; col++) {
    const value = ws.getCell(HEADER_ROW, col).value;
    if (value && typeof value === 'string') {
      if (value.includes('\ufeff') || value.includes('\u200b') || value.includes('\xa0')) {
        issuesFound++;
      }
    }
  }

  // Check data area (rows 12-16)
  for (let row = 12; row <= Math.min(16, ws.rowCount); row++) {
    for (let col = 1; col <= 12; col++) {
      const value = ws.getCell(row, col).value;
      if (value && typeof value === 'string') {
        if (value.includes('\ufeff') || value.includes('\u200b') || value.includes('\xa0')) {
          issuesFound++;
        }
      }
    }
  }

  return issuesFound > 2;
}

/** Auto-fix Excel format by copying to a clean new workbook (xlsx output). */
async function autoFixExcelFormat(
  filePath: string,
  ws: UnifiedWorksheet,
): Promise<UnifiedWorksheet> {
  const tempDir = join(tmpdir(), `register_parser_${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  const tempFilePath = join(
    tempDir,
    `fixed_${filePath.split(/[/\\]/).pop()}`.replace(/\.xls$/, '.xlsx'),
  );

  // Create new workbook with ExcelJS and copy cleaned data
  const newWorkbook = new ExcelJS.Workbook();
  const newWorksheet = newWorkbook.addWorksheet('RegisterTable');

  const maxRow = Math.max(ws.rowCount, 50);
  const maxCol = Math.max(ws.columnCount, 15);

  for (let row = 1; row <= maxRow; row++) {
    for (let col = 1; col <= maxCol; col++) {
      const sourceCell = ws.getCell(row, col);
      const cleaned = cleanCellValue(sourceCell.value);
      if (cleaned !== null) {
        newWorksheet.getCell(row, col).value = cleaned;
      }
    }
  }

  await newWorkbook.xlsx.writeFile(tempFilePath);

  // Re-read the fixed file
  const fixedWorkbook = new ExcelJS.Workbook();
  await fixedWorkbook.xlsx.readFile(tempFilePath);
  const fixedWs = fixedWorkbook.worksheets[0];
  if (!fixedWs) {
    throw new Error('Fixed workbook has no worksheet');
  }
  return new ExcelJsWorksheetWrapper(fixedWs);
}

// ── Worksheet loading ──────────────────────────────────────────────

/**
 * Load a worksheet from a file, using the appropriate library based on extension.
 * - .xlsx: ExcelJS (ZIP/OOXML format)
 * - .xls: SheetJS (OLE/binary format, which ExcelJS cannot read)
 */
async function loadWorksheet(filePath: string): Promise<UnifiedWorksheet> {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.xls') {
    // SheetJS for .xls files — this fixes the "Can't find end of central directory" error
    const workbook = XLSX.readFile(filePath, { type: 'file' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new Error('Excel 文件中没有工作表');
    }
    const ws = workbook.Sheets[firstSheetName];
    if (!ws) {
      throw new Error('Excel 文件中没有工作表');
    }
    return new SheetJsWorksheetWrapper(ws);
  }

  if (ext === '.xlsx') {
    // ExcelJS for .xlsx files
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const ws = workbook.worksheets[0];
    if (!ws) {
      throw new Error('Excel 文件中没有工作表');
    }
    return new ExcelJsWorksheetWrapper(ws);
  }

  throw new Error(`不支持的文件格式: ${ext}，请使用 .xls 或 .xlsx 文件`);
}

// ── Main parse function ─────────────────────────────────────────────

/**
 * Parse a register table Excel file.
 *
 * @param filePath - Path to the .xls or .xlsx file
 * @param autoFix - Whether to auto-fix format issues (default: true)
 * @returns Parsed register table data
 */
export async function parseRegisterTable(
  filePath: string,
  autoFix = true,
): Promise<RegisterTableData> {
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const ext = extname(filePath).toLowerCase();
  if (ext !== '.xlsx' && ext !== '.xls') {
    throw new Error('不支持的文件格式，请使用 Excel 文件 (.xlsx 或 .xls)');
  }

  // Load worksheet using the appropriate library
  let ws = await loadWorksheet(filePath);

  // Auto-fix format if needed
  if (autoFix && checkIfNeedsFormatFix(ws)) {
    try {
      ws = await autoFixExcelFormat(filePath, ws);
    } catch {
      // Fall through to use original worksheet
    }
  }

  // Validate table format
  if (ws.rowCount < DATA_START_ROW) {
    throw new Error(`表格行数不足，至少需要 ${DATA_START_ROW} 行`);
  }
  if (ws.rowCount < HEADER_ROW) {
    throw new Error(`未找到表头行（第 ${HEADER_ROW} 行）`);
  }

  // Extract data
  const headerInfo = extractHeaderInfo(ws);
  const registers = extractRegisterData(ws);

  // Validate
  validateRegisters(registers);

  return { header: headerInfo, registers };
}
