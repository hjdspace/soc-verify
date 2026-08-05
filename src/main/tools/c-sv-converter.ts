/**
 * C/SV Converter — C ↔ SystemVerilog code converter.
 *
 * Ported from the Python `c_to_sv_converter` plugin (`c_parser.py` + `converter.py`).
 * Features: parse C code (functions, structs, macros, enums),
 * convert C to SV tasks/functions, convert SV to C functions.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export type FunctionParameter = {
  name: string;
  dataType: string;
  isPointer: boolean;
  isConst: boolean;
  direction: 'input' | 'output';
};

export type FunctionInfo = {
  name: string;
  returnType: string;
  parameters: FunctionParameter[];
  body: string;
  comments: string[];
  isStatic: boolean;
  mustBeTask?: boolean;
};

export type StructField = {
  type: string;
  name: string;
};

export type StructInfo = {
  name: string;
  fields: StructField[];
  comments: string[];
};

export type MacroInfo = {
  name: string;
  value: string;
  comments: string[];
};

export type EnumValue = {
  name: string;
  value: string;
};

export type EnumInfo = {
  name: string;
  values: EnumValue[];
  comments: string[];
};

export type ParseResult = {
  functions: FunctionInfo[];
  structs: StructInfo[];
  macros: MacroInfo[];
  enums: EnumInfo[];
};

export type ConversionConfig = {
  inputFiles: string[];
  outputPath: string;
  direction: 'c-to-sv' | 'sv-to-c';
  preserveComments: boolean;
  addAutomatic: boolean;
  coreNameDefault: string;
  typeMappings: Record<string, string>;
};

export type ConversionResult = {
  success: boolean;
  outputFile: string;
  functionsConverted: number;
  message: string;
  errors: string[];
  warnings: string[];
  svCode?: string;
};

// ── Default type mappings ───────────────────────────────────────────

const DEFAULT_TYPE_MAPPINGS: Record<string, string> = {
  'uint8_t': 'bit [7:0]',
  'uint16_t': 'bit [15:0]',
  'uint32_t': 'bit [31:0]',
  'uint64_t': 'bit [63:0]',
  'int8_t': 'bit signed [7:0]',
  'int16_t': 'bit signed [15:0]',
  'int32_t': 'bit signed [31:0]',
  'int64_t': 'bit signed [63:0]',
  'int': 'bit signed [31:0]',
  'char': 'bit [7:0]',
  'bool': 'bit',
  'void': 'void',
  'float': 'real',
  'double': 'real',
};

// ── C code parser ──────────────────────────────────────────────────

const C_KEYWORDS = new Set([
  'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'return', 'goto', 'sizeof', 'typedef',
  'struct', 'union', 'enum', 'const', 'volatile', 'static',
  'extern', 'register', 'auto', 'inline',
]);

/** Extract comments before a position in the content. */
function extractCommentsBefore(content: string, position: number): string[] {
  const comments: string[] = [];
  const lines = content.substring(0, position).split('\n');

  let foundNonComment = false;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i].trim();
    if (line.startsWith('//')) {
      if (!foundNonComment) {
        const c: string = line.substring(2).trim();
        comments.unshift(c);
      }
    } else if (line.startsWith('/*') || line.startsWith('*')) {
      if (!foundNonComment) {
        const c: string = line.replace(/^\/\*/, '').replace(/\*\/$/, '').replace(/^\*/, '').trim() || '';
        comments.unshift(c);
      }
    } else if (line) {
      if (comments.length > 0) break;
      foundNonComment = true;
    }
  }

  return comments;
}

/** Extract balanced braces content starting from `{`. */
function extractBalancedBraces(content: string, startPos: number): string | null {
  if (startPos >= content.length || content[startPos] !== '{') return null;

  let braceCount = 0;
  let i = startPos;

  while (i < content.length) {
    if (content[i] === '{') {
      braceCount++;
    } else if (content[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        return content.substring(startPos + 1, i);
      }
    }
    i++;
  }

  return null;
}

/** Parse macros from C content. */
function parseMacros(content: string): MacroInfo[] {
  const macros: MacroInfo[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();

    // Skip non-#define preprocessor directives
    if (stripped.startsWith('#') && !stripped.startsWith('#define')) continue;

    // Match #define
    const match = stripped.match(/^#define\s+(\w+)(?:\s+(.+))?$/);
    if (match) {
      const name = match[1];
      const value = match[2]?.trim() ?? '';

      // Skip header guard macros (no value)
      if (!value) continue;

      const lineStart = lines.slice(0, i).join('\n').length + 1;
      const comments = extractCommentsBefore(content, lineStart);

      macros.push({ name, value, comments });
    }
  }

  return macros;
}

/** Parse enums from C content. */
function parseEnums(content: string): EnumInfo[] {
  const enums: EnumInfo[] = [];
  const pattern = /typedef\s+enum\s*\{([^}]+)\}\s*(\w+);/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const enumBody = match[1];
    const enumName = match[2];
    const comments = extractCommentsBefore(content, match.index);

    const values: EnumValue[] = [];
    const valuePattern = /(\w+)(?:\s*=\s*([^,\n]+))?/g;
    let valueMatch: RegExpExecArray | null;
    while ((valueMatch = valuePattern.exec(enumBody)) !== null) {
      const name = valueMatch[1].trim();
      const value = valueMatch[2]?.trim() ?? '';
      if (name) {
        values.push({ name, value });
      }
    }

    enums.push({ name: enumName, values, comments });
  }

  return enums;
}

/** Parse structs from C content. */
function parseStructs(content: string): StructInfo[] {
  const structs: StructInfo[] = [];
  const pattern = /typedef\s+struct\s*\{([^}]+)\}\s*(\w+);/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const structBody = match[1];
    const structName = match[2];
    const comments = extractCommentsBefore(content, match.index);

    const fields: StructField[] = [];
    const fieldPattern = /(volatile\s+)?(\w+)\s+(\w+);/g;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldPattern.exec(structBody)) !== null) {
      const fieldType = fieldMatch[2];
      const fieldName = fieldMatch[3];
      fields.push({ type: fieldType, name: fieldName });
    }

    structs.push({ name: structName, fields, comments });
  }

  return structs;
}

/** Parse function parameters. */
function parseParameters(paramsStr: string): FunctionParameter[] {
  const parameters: FunctionParameter[] = [];

  if (!paramsStr || paramsStr.trim() === 'void') return parameters;

  const paramList = paramsStr.split(',');
  for (const param of paramList) {
    const trimmed = param.trim();
    if (!trimmed) continue;

    const isConst = trimmed.includes('const');
    const isPointer = trimmed.includes('*');

    // Remove const and pointer symbols
    const cleaned = trimmed.replace(/const/g, '').replace(/\*/g, '').trim();
    const parts = cleaned.split(/\s+/);

    if (parts.length >= 2) {
      const dataType = parts.slice(0, -1).join(' ');
      const name = parts[parts.length - 1];
      const direction = isPointer && !isConst ? 'output' : 'input';

      parameters.push({ name, dataType, isPointer, isConst, direction });
    }
  }

  return parameters;
}

/** Parse functions from C content. */
function parseFunctions(content: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const pattern = /(static\s+)?(\w+)\s+(\w+)\s*\(([^)]*)\)\s*\{/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const isStatic = match[1] !== undefined;
    const returnType = match[2];
    const funcName = match[3];
    const paramsStr = match[4];

    // Skip C keywords
    if (C_KEYWORDS.has(funcName)) continue;

    // Extract function body
    const bodyStart = match.index + match[0].length - 1; // Position of {
    const body = extractBalancedBraces(content, bodyStart);
    if (body === null) continue;

    const parameters = parseParameters(paramsStr);
    const comments = extractCommentsBefore(content, match.index);

    functions.push({
      name: funcName,
      returnType,
      parameters,
      body: body.trim(),
      comments,
      isStatic,
    });
  }

  return functions;
}

/** Parse a C file. */
export async function parseCFile(filePath: string): Promise<ParseResult> {
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const content = await readFile(filePath, 'utf-8');
  return parseCContent(content);
}

/** Parse C content. */
export function parseCContent(content: string): ParseResult {
  return {
    macros: parseMacros(content),
    enums: parseEnums(content),
    structs: parseStructs(content),
    functions: parseFunctions(content),
  };
}

// ── C to SV conversion ────────────────────────────────────────────

/** Check if a function has timing operations. */
function hasTimingOperations(func: FunctionInfo): boolean {
  const body = func.body;
  return (
    body.includes('mmio_read') ||
    body.includes('mmio_write') ||
    body.includes('->') ||
    body.includes('udelay') ||
    body.includes('mdelay')
  );
}

/** Check if function body has register operations. */
function hasRegisterOperations(body: string): boolean {
  return body.includes('mmio_write') || body.includes('mmio_read') || body.includes('->');
}

/** Find called functions in a function body. */
function findCalledFunctions(func: FunctionInfo, funcDict: Map<string, FunctionInfo>): Set<string> {
  const called = new Set<string>();
  const pattern = /\b(\w+)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(func.body)) !== null) {
    const funcName = match[1];
    const excluded = new Set(['if', 'while', 'for', 'switch', 'sizeof', 'return', 'typeof']);
    if (funcDict.has(funcName) && !excluded.has(funcName)) {
      called.add(funcName);
    }
  }

  return called;
}

/** Analyze function dependencies to determine which must be tasks. */
function analyzeFunctionDependencies(functions: FunctionInfo[]): void {
  const funcDict = new Map<string, FunctionInfo>();
  for (const f of functions) {
    funcDict.set(f.name, f);
  }

  const mustBeTask = new Set<string>();

  // Step 1: Mark functions with direct timing operations
  for (const func of functions) {
    if (hasTimingOperations(func)) {
      mustBeTask.add(func.name);
    }
  }

  // Step 2: Propagate dependencies
  let changed = true;
  let iteration = 0;
  const maxIterations = 10;

  while (changed && iteration < maxIterations) {
    changed = false;
    iteration++;

    for (const func of functions) {
      if (mustBeTask.has(func.name)) continue;

      const calledFuncs = findCalledFunctions(func, funcDict);
      for (const calledName of calledFuncs) {
        if (mustBeTask.has(calledName)) {
          mustBeTask.add(func.name);
          changed = true;
          break;
        }
      }
    }
  }

  // Step 3: Mark results
  for (const func of functions) {
    func.mustBeTask = mustBeTask.has(func.name);
  }
}

/** Check if function should be a function (not task). */
function shouldBeFunction(func: FunctionInfo): boolean {
  if (func.mustBeTask !== undefined) return !func.mustBeTask;
  return !hasTimingOperations(func);
}

/** Add macro backticks to value. */
function addMacroBackticks(value: string): string {
  const pattern = /\b([A-Z][A-Z0-9_]+)\b/g;
  const excluded = new Set(['AON', 'TRUE', 'FALSE', 'NULL']);

  return value.replace(pattern, (match, macroName, offset, str) => {
    if (excluded.has(macroName)) return macroName;
    // Check if already has backtick
    if (offset > 0 && str[offset - 1] === '`') return macroName;
    return '`' + macroName;
  });
}

/** Convert hex numbers and add macro backticks. */
function addMacroBackticksAndHex(stmt: string): string {
  // Convert hex: 0x80000000 -> 'h80000000
  let result = stmt.replace(/\b0x([0-9a-fA-F]+)\b/g, "'h$1");
  // Add backticks to macro references
  result = addMacroBackticks(result);
  return result;
}

/** Convert a C enum to SV. */
function convertEnumToSv(enumInfo: EnumInfo): string {
  const lines: string[] = ['typedef enum {'];

  for (let i = 0; i < enumInfo.values.length; i++) {
    const { name, value } = enumInfo.values[i];
    if (value) {
      let svValue = value;
      if (value.startsWith('0x') || value.startsWith('0X')) {
        svValue = `'h${value.substring(2)}`;
      }
      if (i < enumInfo.values.length - 1) {
        lines.push(`    ${name} = ${svValue},`);
      } else {
        lines.push(`    ${name} = ${svValue}`);
      }
    } else {
      if (i < enumInfo.values.length - 1) {
        lines.push(`    ${name},`);
      } else {
        lines.push(`    ${name}`);
      }
    }
  }

  lines.push(`} ${enumInfo.name};`);
  return lines.join('\n');
}

/** Convert a C macro to SV. */
function convertMacroToSv(macro: MacroInfo): string {
  let value = macro.value;

  // Add backticks to macro references in value
  value = addMacroBackticks(value);

  // Convert hex format
  if (value.startsWith('0x') || value.startsWith('0X')) {
    return `\`define ${macro.name} (32'h${value.substring(2)})`;
  } else if (/^\d+$/.test(value)) {
    return `\`define ${macro.name} (${value})`;
  } else {
    return `\`define ${macro.name} (${value})`;
  }
}

/** Convert a C struct to SV register offset macros. */
function convertStructToSvMacros(struct: StructInfo): string[] {
  const lines: string[] = [];
  let offset = 0;

  let structName = struct.name.toUpperCase();
  if (structName.endsWith('_T')) {
    structName = structName.slice(0, -2);
  }

  for (const field of struct.fields) {
    const fieldName = field.name.toUpperCase();
    const macroName = `${structName}_${fieldName}`;
    lines.push(`\`define ${macroName} (32'h${offset.toString(16).toUpperCase().padStart(4, '0')})`);
    offset += 4;
  }

  return lines;
}

/** Convert a C parameter to SV. */
function convertParameterToSv(
  param: FunctionParameter,
  typeMappings: Record<string, string>,
): string {
  const baseType = param.dataType.replace(/\*/g, '').replace(/\s/g, '').trim();
  const standardTypes = new Set([
    'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
    'int8_t', 'int16_t', 'int32_t', 'int64_t',
    'int', 'char', 'bool', 'void', 'float', 'double',
  ]);

  // Struct pointer → base address
  if (param.isPointer && baseType.endsWith('_t') && !standardTypes.has(baseType)) {
    return 'input bit [31:0] base';
  }

  // Enum type
  if (baseType.endsWith('_e')) {
    return `${param.direction} ${param.dataType} ${param.name}`;
  }

  // Get SV type
  let svType: string;
  if (typeMappings[param.dataType]) {
    svType = typeMappings[param.dataType];
  } else if (param.dataType.includes('_') || /[A-Z]/.test(param.dataType)) {
    svType = param.dataType; // Custom type, keep as-is
  } else {
    svType = 'bit [31:0]';
  }

  return `${param.direction} ${svType} ${param.name}`;
}

/** Generate function declaration. */
function generateFunctionDeclaration(
  func: FunctionInfo,
  typeMappings: Record<string, string>,
): string {
  const parts: string[] = [];

  const svReturnType = func.returnType !== 'void'
    ? (typeMappings[func.returnType] ?? 'bit [31:0]')
    : 'void';

  parts.push(`function ${svReturnType} `);
  parts.push(func.name);
  parts.push('(');

  const paramStrs: string[] = [];
  for (const param of func.parameters) {
    let paramType: string;
    if (param.dataType.endsWith('_e')) {
      paramType = param.dataType;
    } else if (typeMappings[param.dataType]) {
      paramType = typeMappings[param.dataType];
    } else if (param.dataType.includes('_') || /[A-Z]/.test(param.dataType)) {
      paramType = param.dataType;
    } else {
      paramType = 'bit [31:0]';
    }
    paramStrs.push(`${paramType} ${param.name}`);
  }

  if (paramStrs.length > 0) {
    parts.push(paramStrs.join(', '));
  }
  parts.push(');');

  return parts.join('');
}

/** Generate task declaration. */
function generateTaskDeclaration(
  func: FunctionInfo,
  config: ConversionConfig,
  typeMappings: Record<string, string>,
): string {
  const parts: string[] = [];

  parts.push(config.addAutomatic ? 'task automatic ' : 'task ');
  parts.push(func.name);
  parts.push('(');

  const paramStrs: string[] = [];
  for (const param of func.parameters) {
    paramStrs.push(convertParameterToSv(param, typeMappings));
  }

  // Add output parameter for non-void return type
  if (func.returnType !== 'void') {
    const svType = typeMappings[func.returnType] ?? 'bit [31:0]';
    const paramNames = func.parameters.map((p) => p.name);
    const returnParamName = paramNames.includes('result') ? 'return_value' : 'result';
    paramStrs.push(`output ${svType} ${returnParamName}`);
  }

  // Add core_name parameter for tasks
  if (func.mustBeTask || hasRegisterOperations(func.body)) {
    paramStrs.push(`input string core_name = "${config.coreNameDefault}"`);
  }

  if (paramStrs.length > 0) {
    parts.push('\n    ' + paramStrs.join(',\n    '));
  }
  parts.push('\n);');

  return parts.join('');
}

/** Merge multiline statements. */
function mergeMultilineStatements(body: string): string[] {
  const lines = body.split('\n');
  const merged: string[] = [];
  let currentStatement = '';

  for (const line of lines) {
    const stripped = line.trim();

    if (!stripped) {
      if (currentStatement) {
        merged.push(currentStatement);
        currentStatement = '';
      }
      continue;
    }

    if (currentStatement) {
      currentStatement += ' ' + stripped;
    } else {
      currentStatement = stripped;
    }

    if (
      stripped.endsWith(';') ||
      stripped === '{' ||
      stripped === '}' ||
      (stripped.endsWith('{') && ['if', 'else', 'while', 'for'].some((kw) => stripped.startsWith(kw))) ||
      (stripped.startsWith('}') && stripped.includes('else'))
    ) {
      merged.push(currentStatement);
      currentStatement = '';
    }
  }

  if (currentStatement) {
    merged.push(currentStatement);
  }

  return merged;
}

/** Convert mmio_write_32 call. */
function convertMmioWrite(stmt: string): string {
  const match = stmt.match(/mmio_write_32\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/);
  if (match) {
    const addr = match[1].trim();
    const data = match[2].trim();
    return `write_reg_by_addr(${addr}, ${data}, core_name);`;
  }
  return stmt + ';';
}

/** Convert mmio_read_32 call. */
function convertMmioRead(stmt: string): string {
  if (stmt.includes('=')) {
    const parts = stmt.split('=');
    const varName = parts[0].trim().replace(/^\*/, '').trim();
    const match = stmt.match(/mmio_read_32\s*\(\s*([^)]+)\s*\)/);
    if (match) {
      const addr = match[1].trim();
      return `read_reg_by_addr(${addr}, ${varName}, core_name);`;
    }
  }
  return stmt + ';';
}

/** Convert delay function. */
function convertDelay(stmt: string): string {
  const match = stmt.match(/(udelay|mdelay)\s*\(\s*(\d+)\s*\)/);
  if (match) {
    const funcName = match[1];
    const delayVal = match[2];
    if (funcName === 'udelay') {
      return `#${delayVal}us;`;
    } else {
      return `#${delayVal}ms;`;
    }
  }
  return stmt + ';';
}

/** Get struct type from function parameters. */
function getStructTypeFromParams(func: FunctionInfo, varName: string): string | null {
  if (!func.parameters) return null;
  for (const param of func.parameters) {
    if (param.name === varName) {
      return param.dataType.replace(/\*/g, '').trim();
    }
  }
  return null;
}

/** Convert pointer operation (struct member access). */
function convertPointerOperation(stmt: string, func: FunctionInfo): string {
  // Compound assignment: regs->member |= value
  const compoundMatch = stmt.match(/^(\w+)\s*->\s*(\w+)\s*([|&^+\-*/%])=\s*(.+)$/);
  if (compoundMatch) {
    const structVar = compoundMatch[1];
    const member = compoundMatch[2];
    const operator = compoundMatch[3];
    const value = compoundMatch[4];
    const baseVar = ['regs', 'reg'].includes(structVar) ? 'base' : structVar;
    const structType = getStructTypeFromParams(func, structVar);
    const structPrefix = structType ? structType.replace('_t', '').toUpperCase() : 'REGS';
    const macroName = `${structPrefix}_${member.toUpperCase()}`;
    return [
      'bit [31:0] rdata;',
      `read_reg_by_addr(${baseVar} + \`${macroName}, rdata, core_name);`,
      `rdata ${operator}= ${value};`,
      `write_reg_by_addr(${baseVar} + \`${macroName}, rdata, core_name);`,
    ].join('\n    ');
  }

  // Write: regs->member = value
  const writeMatch = stmt.match(/^(\w+)\s*->\s*(\w+)\s*=\s*(.+)$/);
  if (writeMatch) {
    const structVar = writeMatch[1];
    const member = writeMatch[2];
    const value = writeMatch[3];
    const baseVar = ['regs', 'reg'].includes(structVar) ? 'base' : structVar;
    const structType = getStructTypeFromParams(func, structVar);
    const structPrefix = structType ? structType.replace('_t', '').toUpperCase() : 'REGS';
    const macroName = `${structPrefix}_${member.toUpperCase()}`;
    return `write_reg_by_addr(${baseVar} + \`${macroName}, ${value}, core_name);`;
  }

  // Read: value = regs->member
  const readMatch = stmt.match(/^(\w+)\s*=\s*(\w+)\s*->\s*(\w+)$/);
  if (readMatch) {
    const varName = readMatch[1];
    const structVar = readMatch[2];
    const member = readMatch[3];
    const baseVar = ['regs', 'reg'].includes(structVar) ? 'base' : structVar;
    const structType = getStructTypeFromParams(func, structVar);
    const structPrefix = structType ? structType.replace('_t', '').toUpperCase() : 'REGS';
    const macroName = `${structPrefix}_${member.toUpperCase()}`;
    return `read_reg_by_addr(${baseVar} + \`${macroName}, ${varName}, core_name);`;
  }

  // Other pointer operations
  let result = stmt.replace(/->/g, '.');
  result = result.replace(/\*\s*([a-zA-Z_]\w*)/g, '$1');
  return result + ';';
}

/** Convert return statement. */
function convertReturn(stmt: string, func: FunctionInfo, typeMappings: Record<string, string>): string {
  if (func.returnType === 'void') return '';

  const isFunction = shouldBeFunction(func);
  const match = stmt.match(/return\s+(.+)/);
  if (match) {
    const value = match[1].trim();

    if (isFunction) {
      return `return ${value};`;
    }

    const paramNames = func.parameters.map((p) => p.name);
    const returnParamName = paramNames.includes('result') ? 'return_value' : 'result';

    // mmio_read_32 in return
    if (value.includes('mmio_read_32')) {
      const mmioMatch = value.match(/mmio_read_32\s*\(\s*([^)]+)\s*\)/);
      if (mmioMatch) {
        const addr = mmioMatch[1].trim();
        return `read_reg_by_addr(${addr}, ${returnParamName}, core_name);`;
      }
    }

    // Struct member access in return
    if (value.includes('->')) {
      const structMatch = value.match(/(\w+)\s*->\s*(\w+)/);
      if (structMatch) {
        const structVar = structMatch[1];
        const member = structMatch[2];
        const baseVar = ['regs', 'reg'].includes(structVar) ? 'base' : structVar;
        const structType = getStructTypeFromParams(func, structVar);
        const structPrefix = structType ? structType.replace('_t', '').toUpperCase() : 'REGS';
        const macroName = `${structPrefix}_${member.toUpperCase()}`;

        const lines: string[] = [];
        lines.push('bit [31:0] rdata;');
        lines.push(`read_reg_by_addr(${baseVar} + \`${macroName}, rdata, core_name);`);
        const modifiedValue = value.replace(/\w+\s*->\s*\w+/g, 'rdata');
        lines.push(`${returnParamName} = ${modifiedValue};`);
        return lines.join('\n    ');
      }
    }

    return `${returnParamName} = ${value};`;
  }

  return '';
}

/** Convert a C statement to SV. */
function convertStatementToSv(stmt: string, func: FunctionInfo, typeMappings: Record<string, string>): string {
  const statement = stmt.replace(/;$/, '').trim();
  if (!statement) return '';

  const isControlStatement = ['if ', 'else', 'while ', 'for ', 'case ', 'switch '].some((kw) => statement.startsWith(kw));

  // Return statement
  if (statement.startsWith('return')) {
    return convertReturn(statement, func, typeMappings);
  }

  // Variable declaration
  const varTypePrefixes = ['uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'int ', 'bool ', 'char '];
  if (varTypePrefixes.some((t) => statement.startsWith(t))) {
    const varMatch = statement.match(/^(\w+)\s+(\w+)(?:\s*=\s*(.+))?$/);
    if (varMatch) {
      const cType = varMatch[1];
      const varName = varMatch[2];
      const initValue = varMatch[3];
      const svType = typeMappings[cType] ?? 'bit [31:0]';
      if (initValue) {
        return `${svType} ${varName} = ${initValue};`;
      }
      return `${svType} ${varName};`;
    }
  }

  // mmio_write
  if (statement.includes('mmio_write_32')) {
    return convertMmioWrite(statement);
  }

  // mmio_read
  if (statement.includes('mmio_read_32')) {
    return convertMmioRead(statement);
  }

  // Pointer operation
  if (statement.includes('->') || statement.includes('*')) {
    return convertPointerOperation(statement, func);
  }

  // Delay
  if (statement.includes('udelay') || statement.includes('mdelay')) {
    return convertDelay(statement);
  }

  if (isControlStatement) {
    return addMacroBackticksAndHex(statement);
  }

  // Other statements
  return addMacroBackticksAndHex(statement) + ';';
}

/** Generate task body. */
function generateTaskBody(func: FunctionInfo, typeMappings: Record<string, string>): string[] {
  const lines: string[] = [];
  let indentLevel = 1;

  const bodyLines = mergeMultilineStatements(func.body);

  for (const line of bodyLines) {
    const stripped = line.trim();
    if (!stripped) continue;

    // } else { pattern
    if (stripped.startsWith('}') && stripped.includes('else')) {
      indentLevel--;
      if (stripped.endsWith('{')) {
        lines.push('    '.repeat(indentLevel) + 'end else begin');
        indentLevel++;
      } else {
        lines.push('    '.repeat(indentLevel) + 'end else');
      }
      continue;
    }

    // Single braces
    if (stripped === '{') {
      lines.push('    '.repeat(indentLevel) + 'begin');
      indentLevel++;
      continue;
    }
    if (stripped === '}') {
      indentLevel--;
      lines.push('    '.repeat(indentLevel) + 'end');
      continue;
    }

    // if/while ending with {
    if (stripped.endsWith('{')) {
      const stmtWithoutBrace = stripped.slice(0, -1).trim();
      const svLine = convertStatementToSv(stmtWithoutBrace, func, typeMappings);
      if (svLine) {
        lines.push('    '.repeat(indentLevel) + svLine + ' begin');
        indentLevel++;
      }
      continue;
    }

    // Regular statement
    const svLine = convertStatementToSv(stripped, func, typeMappings);
    if (svLine) {
      lines.push('    '.repeat(indentLevel) + svLine);
    }
  }

  return lines;
}

/** Convert a C function to SV task/function. */
function convertFunctionToSvTask(
  func: FunctionInfo,
  config: ConversionConfig,
  typeMappings: Record<string, string>,
): string {
  const lines: string[] = [];
  const isFunction = shouldBeFunction(func);

  // Comments
  if (config.preserveComments && func.comments.length > 0) {
    for (const comment of func.comments) {
      lines.push(`// ${comment}`);
    }
  }

  // Declaration
  if (isFunction) {
    lines.push(generateFunctionDeclaration(func, typeMappings));
  } else {
    lines.push(generateTaskDeclaration(func, config, typeMappings));
  }

  // Body
  const bodyLines = generateTaskBody(func, typeMappings);
  lines.push(...bodyLines);

  // End
  lines.push(isFunction ? 'endfunction' : 'endtask');

  return lines.join('\n');
}

/** Group files by driver name. */
function groupFilesByDriver(filePaths: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  for (const filePath of filePaths) {
    if (!existsSync(filePath)) continue;

    const baseName = basename(filePath);
    const nameWithoutExt = baseName.replace(/\.[^.]+$/, '');
    const parentDir = basename(dirname(filePath));

    let driverName: string;

    if (parentDir && parentDir.toLowerCase() === nameWithoutExt.toLowerCase()) {
      driverName = nameWithoutExt;
    } else if (['src', 'source', 'drivers', 'driver', 'lib', 'libs'].includes(parentDir.toLowerCase())) {
      driverName = nameWithoutExt;
    } else {
      driverName = nameWithoutExt;
    }

    if (!groups.has(driverName)) {
      groups.set(driverName, []);
    }
    groups.get(driverName)!.push(filePath);
  }

  return groups;
}

/** Generate SV code from parsed C data. */
function generateSvCode(
  functions: FunctionInfo[],
  structs: StructInfo[],
  macros: MacroInfo[],
  enums: EnumInfo[],
  driverName: string,
  config: ConversionConfig,
  typeMappings: Record<string, string>,
): string {
  const lines: string[] = [];

  // File header
  lines.push('// Auto-generated SystemVerilog Task Library');
  if (driverName) {
    lines.push(`// Driver: ${driverName}`);
  }
  lines.push('// Converted from C code');
  lines.push('');

  // Header guard
  if (driverName && driverName !== 'preview') {
    const guardName = `__${driverName.toUpperCase()}_TASK_LIB_SV__`;
    lines.push(`\`ifndef ${guardName}`);
    lines.push(`\`define ${guardName}`);
    lines.push('');
  }

  // Enums
  if (enums.length > 0) {
    lines.push('// Enum Definitions');
    lines.push('');
    for (const enumInfo of enums) {
      if (config.preserveComments && enumInfo.comments.length > 0) {
        for (const comment of enumInfo.comments) {
          lines.push(`// ${comment.trim()}`);
        }
      }
      lines.push(convertEnumToSv(enumInfo));
      lines.push('');
    }
  }

  // Macros
  if (macros.length > 0) {
    lines.push('// Macro Definitions');
    lines.push('');
    for (const macro of macros) {
      if (config.preserveComments && macro.comments.length > 0) {
        for (const comment of macro.comments) {
          lines.push(`// ${comment.trim()}`);
        }
      }
      lines.push(convertMacroToSv(macro));
    }
    lines.push('');
  }

  // Structs → register offset macros
  if (structs.length > 0) {
    lines.push('// Register Offsets (from struct)');
    for (const struct of structs) {
      if (config.preserveComments && struct.comments.length > 0) {
        for (const comment of struct.comments) {
          lines.push(`// ${comment}`);
        }
      }
      const svMacros = convertStructToSvMacros(struct);
      lines.push(...svMacros);
    }
    lines.push('');
  }

  // Functions
  if (functions.length > 0) {
    lines.push('// Task Definitions');
    for (const func of functions) {
      if (func.isStatic) {
        lines.push(`// Skipped static function: ${func.name}`);
        continue;
      }
      lines.push(convertFunctionToSvTask(func, config, typeMappings));
      lines.push('');
    }
  }

  // End guard
  if (driverName && driverName !== 'preview') {
    const guardName = `__${driverName.toUpperCase()}_TASK_LIB_SV__`;
    lines.push('');
    lines.push(`\`endif // ${guardName}`);
  }

  return lines.join('\n');
}

// ── Main convert function ─────────────────────────────────────────

/** Convert C files to SystemVerilog. */
export async function convertCToSv(
  config: ConversionConfig,
): Promise<ConversionResult> {
  const typeMappings = { ...DEFAULT_TYPE_MAPPINGS, ...config.typeMappings };
  const result: ConversionResult = {
    success: false,
    outputFile: '',
    functionsConverted: 0,
    message: '',
    errors: [],
    warnings: [],
  };

  // Group files by driver
  const driverGroups = groupFilesByDriver(config.inputFiles);

  if (driverGroups.size === 0) {
    result.errors.push('没有找到可转换的文件');
    result.message = '转换失败: 没有找到可转换的文件';
    return result;
  }

  // Single driver
  if (driverGroups.size === 1) {
    const [driverName, files] = [...driverGroups.entries()][0];

    // Parse all files
    const allFunctions: FunctionInfo[] = [];
    const allStructs: StructInfo[] = [];
    const allMacros: MacroInfo[] = [];
    const allEnums: EnumInfo[] = [];

    for (const filePath of files) {
      try {
        const parseResult = await parseCFile(filePath);
        allFunctions.push(...parseResult.functions);
        allStructs.push(...parseResult.structs);
        allMacros.push(...parseResult.macros);
        allEnums.push(...parseResult.enums);
      } catch (e) {
        result.warnings.push(`解析文件失败 ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (allFunctions.length === 0 && allMacros.length === 0) {
      result.errors.push(`驱动 ${driverName} 没有找到可转换的函数或宏定义`);
      result.message = `转换失败: 驱动 ${driverName} 没有找到可转换的内容`;
      return result;
    }

    // Analyze dependencies
    analyzeFunctionDependencies(allFunctions);

    // Generate SV code
    const svCode = generateSvCode(allFunctions, allStructs, allMacros, allEnums, driverName, config, typeMappings);
    result.svCode = svCode;

    // Write output file
    try {
      let outputFile = config.outputPath;
      if (existsSync(config.outputPath) && (await import('node:fs')).statSync(config.outputPath).isDirectory()) {
        outputFile = join(config.outputPath, `${driverName}_task_lib.sv`);
      }
      await writeFile(outputFile, svCode, 'utf-8');
      result.success = true;
      result.outputFile = outputFile;
      result.functionsConverted = allFunctions.length;
      result.message = `成功转换驱动 ${driverName}: ${allFunctions.length} 个函数 -> ${outputFile}`;
    } catch (e) {
      result.errors.push(`写入文件失败: ${e instanceof Error ? e.message : String(e)}`);
      result.message = `写入文件失败: ${e instanceof Error ? e.message : String(e)}`;
    }

    return result;
  }

  // Multiple drivers
  const outputDir = dirname(config.outputPath) || '.';
  const outputFiles: string[] = [];
  let totalFunctions = 0;

  for (const [driverName, files] of driverGroups) {
    const outputFile = join(outputDir, `${driverName}_task_lib.sv`);

    const driverConfig: ConversionConfig = {
      ...config,
      inputFiles: files,
      outputPath: outputFile,
    };

    const driverResult = await convertCToSv(driverConfig);
    if (driverResult.success) {
      totalFunctions += driverResult.functionsConverted;
      outputFiles.push(driverResult.outputFile);
    } else {
      result.warnings.push(...driverResult.warnings);
      result.errors.push(...driverResult.errors);
    }
  }

  if (outputFiles.length > 0) {
    result.success = true;
    result.outputFile = `${outputFiles.length} 个文件`;
    result.functionsConverted = totalFunctions;
    result.message = `成功转换 ${outputFiles.length} 个驱动，共 ${totalFunctions} 个函数:\n`;
    for (const file of outputFiles) {
      result.message += `  - ${basename(file)}\n`;
    }
  } else {
    result.errors.push('所有驱动转换失败');
    result.message = '转换失败: 所有驱动转换失败';
  }

  return result;
}

/** Preview C-to-SV conversion (returns SV code without writing file). */
export async function previewCToSv(
  filePaths: string[],
  config: Partial<ConversionConfig> = {},
): Promise<{ svCode: string; parseResult: ParseResult }> {
  const fullConfig: ConversionConfig = {
    inputFiles: filePaths,
    outputPath: '/dev/null',
    direction: 'c-to-sv',
    preserveComments: config.preserveComments ?? true,
    addAutomatic: config.addAutomatic ?? true,
    coreNameDefault: config.coreNameDefault ?? 'default_core',
    typeMappings: config.typeMappings ?? {},
  };

  const typeMappings = { ...DEFAULT_TYPE_MAPPINGS, ...fullConfig.typeMappings };

  // Parse all files
  const allFunctions: FunctionInfo[] = [];
  const allStructs: StructInfo[] = [];
  const allMacros: MacroInfo[] = [];
  const allEnums: EnumInfo[] = [];

  for (const filePath of filePaths) {
    try {
      const parseResult = await parseCFile(filePath);
      allFunctions.push(...parseResult.functions);
      allStructs.push(...parseResult.structs);
      allMacros.push(...parseResult.macros);
      allEnums.push(...parseResult.enums);
    } catch {
      // Skip invalid files
    }
  }

  // Analyze dependencies
  analyzeFunctionDependencies(allFunctions);

  // Determine driver name
  const driverGroups = groupFilesByDriver(filePaths);
  const driverName = driverGroups.size === 1 ? [...driverGroups.keys()][0] : 'preview';

  const svCode = generateSvCode(allFunctions, allStructs, allMacros, allEnums, driverName, fullConfig, typeMappings);

  return {
    svCode,
    parseResult: { functions: allFunctions, structs: allStructs, macros: allMacros, enums: allEnums },
  };
}
