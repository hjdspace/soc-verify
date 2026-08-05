/**
 * Reg2C — Register table → C driver header file generator.
 *
 * Ported from the Python `reg2c` plugin (`parser_engine.py` + Jinja2 templates).
 * Features: parse Excel register tables (adaptive header detection),
 * generate C macros, struct, and access functions.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import ExcelJS from 'exceljs';

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

// ── Excel parsing ───────────────────────────────────────────────────

/** Get cell value as string, handling null/undefined. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Find valid (visible, non-empty) sheet in workbook. */
function getValidSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet | null {
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

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const worksheet = getValidSheet(workbook);

  if (!worksheet) {
    throw new Error('Excel 文件中没有有效工作表');
  }

  // Scan for Module Name and BASE ADDR
  let moduleName = 'module';
  let baseAddr = 0;

  const maxScanRow = Math.min(worksheet.rowCount, 20);

  for (let row = 1; row <= maxScanRow; row++) {
    for (let col = 1; col <= worksheet.columnCount; col++) {
      const cellVal = cellToString(worksheet.getCell(row, col).value).toLowerCase();

      if (cellVal.includes('module name')) {
        // Next column has the value
        moduleName = cellToString(worksheet.getCell(row, col + 1).value) || moduleName;
      }

      if (cellVal.includes('base addr')) {
        const baseStr = cellToString(worksheet.getCell(row, col + 1).value);
        const cleaned = baseStr.replace(/[_ ]/g, '').toLowerCase();
        if (cleaned.startsWith('0x')) {
          baseAddr = parseInt(cleaned, 16) || 0;
        } else {
          baseAddr = parseInt(cleaned, 16) || 0;
        }
      }
    }
  }

  // Adaptive header row detection
  const requiredKeywords = ['offset', 'regname', 'bit', 'fieldname', 'rw', 'resetvalue', 'description'];
  let headerRow = -1;

  for (let row = 1; row <= Math.min(20, worksheet.rowCount); row++) {
    const rowValues: string[] = [];
    for (let col = 1; col <= worksheet.columnCount; col++) {
      const val = worksheet.getCell(row, col).value;
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

  // Default header row if not found
  if (headerRow === -1) {
    headerRow = 10; // Match Python default
  }

  // Build column mapping from header row
  const columnMap: Record<string, number> = {};
  for (let col = 1; col <= worksheet.columnCount; col++) {
    const headerVal = worksheet.getCell(headerRow, col).value;
    const cleanedCol = cleanColumnName(headerVal);
    for (const reqCol of requiredKeywords) {
      if (cleanedCol.includes(reqCol) && !(reqCol in columnMap)) {
        columnMap[reqCol] = col;
        break;
      }
    }
  }

  // Check for width column
  if (!('width' in columnMap)) {
    // Try to find width column
    for (let col = 1; col <= worksheet.columnCount; col++) {
      const headerVal = worksheet.getCell(headerRow, col).value;
      const cleanedCol = cleanColumnName(headerVal);
      if (cleanedCol.includes('width')) {
        columnMap.width = col;
        break;
      }
    }
  }

  // Also check for shortdescription
  if (!('shortdescription' in columnMap)) {
    for (let col = 1; col <= worksheet.columnCount; col++) {
      const headerVal = worksheet.getCell(headerRow, col).value;
      const cleanedCol = cleanColumnName(headerVal);
      if (cleanedCol.includes('shortdesc')) {
        columnMap.shortdescription = col;
        break;
      }
    }
  }

  // Parse data rows
  const dataStartRow = headerRow + 1;
  const registers: RegRegister[] = [];
  let currentReg: RegRegister | null = null;
  let prevOffset: number | null = null;

  // Forward fill tracking for merged cells
  let lastRegName = '';
  let lastOffset = '';
  let lastWidth = 0;
  let lastDesc = '';

  for (let row = dataStartRow; row <= worksheet.rowCount; row++) {
    // Get values using column mapping
    const getVal = (key: string): string => {
      const col = columnMap[key];
      if (!col) return '';
      const v = worksheet.getCell(row, col).value;
      return cellToString(v);
    };

    let regName = getVal('regname');
    let offsetStr = getVal('offset');
    let widthStr = getVal('width') || (lastWidth ? String(lastWidth) : '32');
    let bitStr = getVal('bit');
    let fieldName = getVal('fieldname');
    let rwStr = getVal('rw');
    let resetStr = getVal('resetvalue');
    let descStr = getVal('description') || getVal('shortdescription');
    const shortDescStr = getVal('shortdescription') || '';

    // Forward fill for merged cells
    if (regName) lastRegName = regName;
    else regName = lastRegName;

    if (offsetStr) lastOffset = offsetStr;
    else offsetStr = lastOffset;

    if (widthStr && widthStr !== '32') lastWidth = parseInt(widthStr, 10) || 32;
    else if (!widthStr) widthStr = lastWidth ? String(lastWidth) : '32';

    if (descStr) lastDesc = descStr;
    else descStr = lastDesc;

    // Validate offset
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

    // New register boundary (offset changed)
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
      // Skip reserved fields
      if (fieldName.toLowerCase().includes('reserved')) continue;

      // Parse bit range
      let bitStart: number;
      let bitEnd: number;
      let bitWidth: number;

      const bracketMatch = bitStr.match(/\[(\d+)(?::(\d+))?\]/);
      if (bracketMatch) {
        bitStart = parseInt(bracketMatch[1], 10);
        bitEnd = bracketMatch[2] ? parseInt(bracketMatch[2], 10) : bitStart;
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

      // Clean field name (remove non-alphanumeric chars except underscore)
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
