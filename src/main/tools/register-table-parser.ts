/**
 * Register Table Parser — Excel register specification table parser.
 *
 * Ported from the Python `register_table_parser` plugin (`parser.py` + `models.py`).
 * Features: parse .xlsx/.xls register tables, extract header info + register + field data,
 * auto-fix Excel format issues (BOM, zero-width spaces, etc.).
 */

import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';

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
function extractHeaderInfo(
  worksheet: ExcelJS.Worksheet,
): HeaderInfo {
  const header: HeaderInfo = {
    projectName: '',
    subSystem: '',
    moduleName: '',
    baseAddr: '',
  };

  for (let row = 1; row <= 4; row++) {
    const cellA = worksheet.getCell(row, 1).value;
    const cellB = worksheet.getCell(row, 2).value;

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
  worksheet: ExcelJS.Worksheet,
  rowNum: number,
): Record<string, string | number | null> {
  const row: Record<string, string | number | null> = {};

  for (const [colType, colNum] of Object.entries(COLUMN_MAPPING)) {
    const cellValue = worksheet.getCell(rowNum, colNum).value;
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
function extractRegisterData(
  worksheet: ExcelJS.Worksheet,
): RegisterInfo[] {
  const registers: RegisterInfo[] = [];
  let currentRegister: RegisterInfo | null = null;

  const maxRow = worksheet.rowCount;

  for (let rowNum = DATA_START_ROW; rowNum <= maxRow; rowNum++) {
    const rowData = extractRowData(worksheet, rowNum);

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

// ── Excel format auto-fix ───────────────────────────────────────────

/** Check if the Excel file needs format fixing. */
function checkIfNeedsFormatFix(worksheet: ExcelJS.Worksheet): boolean {
  let issuesFound = 0;

  // Check header area (first 4 rows)
  for (let row = 1; row <= 4; row++) {
    for (let col = 1; col <= 2; col++) {
      const value = worksheet.getCell(row, col).value;
      if (value && typeof value === 'string') {
        if (value.includes('\ufeff') || value.includes('\u200b') || value.includes('\xa0')) {
          issuesFound++;
        }
      }
    }
  }

  // Check header row (row 10)
  for (let col = 1; col <= 12; col++) {
    const value = worksheet.getCell(HEADER_ROW, col).value;
    if (value && typeof value === 'string') {
      if (value.includes('\ufeff') || value.includes('\u200b') || value.includes('\xa0')) {
        issuesFound++;
      }
    }
  }

  // Check data area (rows 12-16)
  for (let row = 12; row <= Math.min(16, worksheet.rowCount); row++) {
    for (let col = 1; col <= 12; col++) {
      const value = worksheet.getCell(row, col).value;
      if (value && typeof value === 'string') {
        if (value.includes('\ufeff') || value.includes('\u200b') || value.includes('\xa0')) {
          issuesFound++;
        }
      }
    }
  }

  return issuesFound > 2;
}

/** Auto-fix Excel format by copying to a clean new workbook. */
async function autoFixExcelFormat(filePath: string): Promise<string> {
  const tempDir = join(tmpdir(), `register_parser_${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  const tempFilePath = join(
    tempDir,
    `fixed_${filePath.split(/[/\\]/).pop()}`.replace(/\.xls$/, '.xlsx'),
  );

  // Read original
  const originalWorkbook = new ExcelJS.Workbook();
  await originalWorkbook.xlsx.readFile(filePath);
  const originalWorksheet = originalWorkbook.worksheets[0];

  if (!originalWorksheet) return filePath;

  // Create new workbook
  const newWorkbook = new ExcelJS.Workbook();
  const newWorksheet = newWorkbook.addWorksheet('RegisterTable');

  const maxRow = Math.max(originalWorksheet.rowCount, 50);
  const maxCol = Math.max(originalWorksheet.columnCount, 15);

  for (let row = 1; row <= maxRow; row++) {
    for (let col = 1; col <= maxCol; col++) {
      const sourceCell = originalWorksheet.getCell(row, col);
      const cleaned = cleanCellValue(sourceCell.value);
      if (cleaned !== null) {
        newWorksheet.getCell(row, col).value = cleaned;
      }
    }
  }

  await newWorkbook.xlsx.writeFile(tempFilePath);
  return tempFilePath;
}

// ── Main parse function ─────────────────────────────────────────────

/** Parse a register table Excel file. */
export async function parseRegisterTable(
  filePath: string,
): Promise<RegisterTableData> {
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const ext = extname(filePath).toLowerCase();
  if (ext !== '.xlsx' && ext !== '.xls') {
    throw new Error('不支持的文件格式，请使用 Excel 文件 (.xlsx 或 .xls)');
  }

  let actualFilePath = filePath;

  // Auto-fix format if needed
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];

  if (!worksheet) {
    throw new Error('Excel 文件中没有工作表');
  }

  if (checkIfNeedsFormatFix(worksheet)) {
    try {
      actualFilePath = await autoFixExcelFormat(filePath);
      const fixedWorkbook = new ExcelJS.Workbook();
      await fixedWorkbook.xlsx.readFile(actualFilePath);
      const fixedWorksheet = fixedWorkbook.worksheets[0];
      if (fixedWorksheet) {
        const headerInfo = extractHeaderInfo(fixedWorksheet);
        const registers = extractRegisterData(fixedWorksheet);
        return { header: headerInfo, registers };
      }
    } catch {
      // Fall through to use original
    }
  }

  const headerInfo = extractHeaderInfo(worksheet);
  const registers = extractRegisterData(worksheet);

  return { header: headerInfo, registers };
}
