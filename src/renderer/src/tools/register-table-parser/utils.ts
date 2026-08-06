/**
 * Register Table Parser — utility functions.
 *
 * Ported from the Python `register_table_parser` plugin (`utils.py` + `models.py`).
 * These are pure functions that don't depend on Node.js APIs, so they can run
 * entirely in the renderer process for real-time field value calculation.
 */

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
  offset: string;
  name: string;
  description: string;
  width: number;
  fields: FieldInfo[];
};

export type RegisterTableData = {
  header: HeaderInfo;
  registers: RegisterInfo[];
};

export type NumberFormat = 'hexadecimal' | 'decimal' | 'binary';

// ── Field properties (ported from models.py FieldInfo) ──────────────

/** Check if a field is a reserved field. */
export function isReservedField(field: FieldInfo): boolean {
  return field.name.toLowerCase().trim() === 'reserved';
}

/** Check if a field is read-only. */
export function isReadOnlyField(field: FieldInfo): boolean {
  return field.rwAttribute === 'RO';
}

/** Check if a field is writable. */
export function isWritableField(field: FieldInfo): boolean {
  return (field.rwAttribute === 'RW' || field.rwAttribute === 'WO') && !isReservedField(field);
}

/** Get non-reserved fields from a register. */
export function getNonReservedFields(register: RegisterInfo): FieldInfo[] {
  return register.fields.filter((f) => !isReservedField(f));
}

/** Get writable fields from a register. */
export function getWritableFields(register: RegisterInfo): FieldInfo[] {
  return register.fields.filter((f) => isWritableField(f));
}

// ── Bit range utilities (ported from utils.py BitRangeParser) ───────

/** Parse a bit range string like "31:24" or "15" → [high, low]. */
export function parseBitRange(bitRange: string): [number, number] {
  if (!bitRange) throw new Error('位范围不能为空');

  const trimmed = bitRange.trim();

  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    if (parts.length !== 2) throw new Error(`位范围格式错误: ${bitRange}`);

    const high = parseInt(parts[0].trim(), 10);
    const low = parseInt(parts[1].trim(), 10);

    if (isNaN(high) || isNaN(low)) throw new Error(`位范围格式错误: ${bitRange}`);
    if (high < low) throw new Error(`高位不能小于低位: ${bitRange}`);

    return [high, low];
  }

  const bit = parseInt(trimmed, 10);
  if (isNaN(bit)) throw new Error(`位范围格式错误: ${bitRange}`);
  return [bit, bit];
}

/** Get the bit width of a bit range. */
export function getBitWidth(bitRange: string): number {
  const [high, low] = parseBitRange(bitRange);
  return high - low + 1;
}

/** Get the bit position [high, low] from a field's bit range. */
export function getBitPosition(field: FieldInfo): [number, number] {
  return parseBitRange(field.bitRange);
}

// ── Field value calculator (ported from utils.py FieldValueCalculator) ──

/** Extract a field value from a register value. */
export function extractFieldValue(registerValue: number, bitRange: string): number {
  const [high, low] = parseBitRange(bitRange);
  const width = high - low + 1;
  const mask = (1 << width) - 1;
  return (registerValue >> low) & mask;
}

/** Insert a field value into a register value. */
export function insertFieldValue(registerValue: number, fieldValue: number, bitRange: string): number {
  const [high, low] = parseBitRange(bitRange);
  const width = high - low + 1;
  const mask = (1 << width) - 1;
  const clampedValue = fieldValue & mask;
  const clearMask = ~(mask << low);
  return (registerValue & clearMask) | (clampedValue << low);
}

/** Validate if a field value is within the valid range. */
export function validateFieldValue(fieldValue: number, bitRange: string): boolean {
  try {
    const width = getBitWidth(bitRange);
    const maxValue = (1 << width) - 1;
    return fieldValue >= 0 && fieldValue <= maxValue;
  } catch {
    return false;
  }
}

// ── SystemVerilog value parser (ported from utils.py) ──────────────

const SV_VALUE_PATTERN = /^(\d+)'([bdhBDH])([0-9a-fA-F_]+)$/;

/** Check if a string is in SystemVerilog format (e.g., "32'habcd", "8'hF", "1'b0"). */
export function isSystemVerilogFormat(valueStr: string): boolean {
  if (!valueStr || typeof valueStr !== 'string') return false;
  return SV_VALUE_PATTERN.test(valueStr.trim());
}

/** Parse a SystemVerilog format value (e.g., "32'habcd" → 43981). */
export function parseSystemVerilogValue(valueStr: string): number {
  if (!valueStr || typeof valueStr !== 'string') throw new Error('输入值不能为空');

  const trimmed = valueStr.trim();
  const match = trimmed.match(SV_VALUE_PATTERN);
  if (!match) throw new Error(`不是有效的SystemVerilog格式: ${valueStr}`);

  const [, widthStr, baseChar, valuePart] = match;
  const width = parseInt(widthStr, 10);
  const base = baseChar.toLowerCase();
  const cleanValue = valuePart.replace(/_/g, '');

  let parsedValue: number;

  if (base === 'b') {
    if (!/^[01]+$/.test(cleanValue)) throw new Error(`二进制数值包含无效字符: ${cleanValue}`);
    parsedValue = parseInt(cleanValue, 2);
  } else if (base === 'd') {
    if (!/^\d+$/.test(cleanValue)) throw new Error(`十进制数值包含无效字符: ${cleanValue}`);
    parsedValue = parseInt(cleanValue, 10);
  } else if (base === 'h') {
    if (!/^[0-9a-fA-F]+$/.test(cleanValue)) throw new Error(`十六进制数值包含无效字符: ${cleanValue}`);
    parsedValue = parseInt(cleanValue, 16);
  } else {
    throw new Error(`不支持的进制: ${base}`);
  }

  const maxValue = (1 << width) - 1;
  if (parsedValue > maxValue) {
    throw new Error(`数值 ${parsedValue} 超出 ${width} 位的最大值 ${maxValue}`);
  }

  return parsedValue;
}

// ── Number format converter (ported from utils.py NumberFormatConverter) ──

/** Parse a number string supporting 0x, 0b, decimal, and SystemVerilog formats. */
export function parseNumberFromString(valueStr: string): number {
  if (!valueStr) return 0;

  const trimmed = valueStr.trim();
  if (!trimmed) return 0;

  // Try SystemVerilog format first
  if (isSystemVerilogFormat(trimmed)) {
    try {
      return parseSystemVerilogValue(trimmed);
    } catch {
      // Fall through to standard formats
    }
  }

  // Binary format
  if (trimmed.toLowerCase().startsWith('0b')) {
    return parseInt(trimmed, 2);
  }

  // Hexadecimal format
  if (trimmed.toLowerCase().startsWith('0x')) {
    return parseInt(trimmed, 16);
  }

  // Decimal format
  return parseInt(trimmed, 10);
}

/** Parse a reset value string to an integer (with SystemVerilog support). */
export function parseResetValue(resetValue: string): number {
  try {
    return parseNumberFromString(resetValue);
  } catch {
    return 0;
  }
}

/** Format a number to the target format. */
export function formatNumber(value: number, format: NumberFormat, width?: number): string {
  if (format === 'binary') {
    if (width) {
      return `0b${value.toString(2).padStart(width, '0')}`;
    }
    return `0b${value.toString(2)}`;
  }

  if (format === 'decimal') {
    return String(value);
  }

  // Hexadecimal
  if (width) {
    const hexWidth = Math.ceil(width / 4);
    return `0x${value.toString(16).toUpperCase().padStart(hexWidth, '0')}`;
  }
  return `0x${value.toString(16).toUpperCase()}`;
}

/** Format a register value (always 32-bit). */
export function formatRegisterValue(value: number, format: NumberFormat): string {
  if (format === 'binary') {
    return `0b${(value >>> 0).toString(2).padStart(32, '0')}`;
  }
  if (format === 'decimal') {
    return String(value >>> 0);
  }
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

// ── Register value calculation (ported from models.py RegisterInfo) ──

/**
 * Calculate the register value from field values.
 * Reserved fields use their reset values; non-reserved fields use provided values.
 */
export function calculateRegisterValue(
  fields: FieldInfo[],
  fieldValues: Record<string, number>,
): number {
  let registerValue = 0;

  for (const field of fields) {
    let fieldValue: number;

    if (isReservedField(field)) {
      fieldValue = parseResetValue(field.resetValue);
    } else {
      fieldValue = fieldValues[field.name] ?? parseResetValue(field.resetValue);
    }

    const [, low] = getBitPosition(field);
    const width = getBitWidth(field.bitRange);
    const maxValue = (1 << width) - 1;
    fieldValue = Math.min(fieldValue, maxValue);

    registerValue |= (fieldValue << low);
  }

  return registerValue >>> 0; // Ensure unsigned
}

/** Calculate the reset value of a register from its fields. */
export function calculateResetValue(fields: FieldInfo[]): number {
  let resetValue = 0;

  for (const field of fields) {
    if (!isReservedField(field)) {
      const [, low] = getBitPosition(field);
      const fieldValue = parseResetValue(field.resetValue);
      resetValue |= (fieldValue << low);
    }
  }

  return resetValue >>> 0;
}

/** Initialize field values with reset values. */
export function initFieldValues(register: RegisterInfo): Record<string, number> {
  const values: Record<string, number> = {};
  for (const field of getNonReservedFields(register)) {
    values[field.name] = parseResetValue(field.resetValue);
  }
  return values;
}

/** Extract all field values from a register value (reverse annotation). */
export function extractAllFieldValues(
  register: RegisterInfo,
  registerValue: number,
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const field of getNonReservedFields(register)) {
    values[field.name] = extractFieldValue(registerValue, field.bitRange);
  }
  return values;
}

// ── Register table data helpers (ported from models.py RegisterTableData) ──

/** Get register count. */
export function getRegisterCount(data: RegisterTableData): number {
  return data.registers.length;
}

/** Get total field count. */
export function getTotalFieldCount(data: RegisterTableData): number {
  return data.registers.reduce((sum, reg) => sum + reg.fields.length, 0);
}

/** Get non-reserved field count. */
export function getNonReservedFieldCount(data: RegisterTableData): number {
  return data.registers.reduce((sum, reg) => sum + getNonReservedFields(reg).length, 0);
}

/** Search registers by name or offset address. */
export function searchRegisters(data: RegisterTableData, query: string): RegisterInfo[] {
  const queryLower = query.toLowerCase().trim();
  if (!queryLower) return data.registers;

  const results: RegisterInfo[] = [];

  for (const register of data.registers) {
    // Search register name (fuzzy)
    if (register.name.toLowerCase().includes(queryLower)) {
      results.push(register);
      continue;
    }

    // Search offset address (exact string match)
    if (register.offset.toLowerCase().includes(queryLower)) {
      results.push(register);
      continue;
    }

    // Try as hex address
    try {
      const queryInt = queryLower.startsWith('0x')
        ? parseInt(queryLower, 16)
        : parseInt(queryLower, 16);
      const regOffsetInt = parseInt(register.offset, 16);
      if (regOffsetInt === queryInt) {
        results.push(register);
        continue;
      }
    } catch {
      // Not a valid number
    }

    // Try as decimal address
    try {
      const queryInt = parseInt(queryLower, 10);
      const regOffsetInt = parseInt(register.offset, 16);
      if (regOffsetInt === queryInt) {
        results.push(register);
      }
    } catch {
      // Not a valid number
    }
  }

  return results;
}

/** Get the integer offset of a register. */
export function getOffsetInt(offset: string): number {
  try {
    if (offset.toLowerCase().startsWith('0x')) {
      return parseInt(offset, 16);
    }
    return parseInt(offset, 10);
  } catch {
    return 0;
  }
}
