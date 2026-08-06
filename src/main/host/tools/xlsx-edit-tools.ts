import { isAbsolute, resolve } from 'node:path';
import { appendRows, updateCell, type CellValue } from '../../document/xlsx-editor';
import { isEditing, requestFlush, notifyFileChanged } from '../../document/editor-registry';
import { TEXT, defineTool, type HostToolEntry, type ToolContext } from './shared';

/**
 * xlsx 细粒度编辑工具：append_xlsx_row / update_xlsx_cell
 *
 * AI 修改 xlsx 文件时，先检查前端是否正在编辑，若在编辑则 flush 前端未保存的修改，
 * 修改完成后通知前端重载文件。
 */
export function createXlsxEditTools(ctx: ToolContext): HostToolEntry[] {
  return [
    defineTool(
      'append_xlsx_row',
      'Append rows to a sheet in an existing xlsx file. If the file is being edited in the front-end, the system will flush unsaved changes before appending. After modification, the front-end will reload the file. Useful for AI to incrementally update coverage matrices, regression summaries, or test case lists.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'xlsx file path (absolute or relative to project root).' },
          sheet: { type: 'string', description: 'Sheet name. If the sheet does not exist, it will be created.' },
          rows: {
            type: 'array',
            description: 'Rows to append. Each row is an array of cell values (string, number, boolean, or null).',
            items: { type: 'array' },
          },
        },
        required: ['path', 'sheet', 'rows'],
        additionalProperties: false,
      },
      async (args) => {
        const inputPath = typeof args.path === 'string' ? args.path : '';
        if (!inputPath) {
          return TEXT(JSON.stringify({ error: 'path is required' }));
        }
        const sheet = typeof args.sheet === 'string' ? args.sheet : '';
        if (!sheet) {
          return TEXT(JSON.stringify({ error: 'sheet is required' }));
        }
        const rows = Array.isArray(args.rows) ? (args.rows as CellValue[][]) : [];
        if (rows.length === 0) {
          return TEXT(JSON.stringify({ error: 'rows is required and must be a non-empty array' }));
        }
        const absPath = isAbsolute(inputPath) ? inputPath : resolve(ctx.cwd, inputPath);
        try {
          if (isEditing(absPath)) {
            await requestFlush(absPath);
          }
          const result = await appendRows(absPath, sheet, rows);
          notifyFileChanged(absPath);
          return TEXT(JSON.stringify(result));
        } catch (err) {
          return TEXT(JSON.stringify({ error: `append_xlsx_row failed: ${err instanceof Error ? err.message : String(err)}` }));
        }
      },
    ),

    defineTool(
      'update_xlsx_cell',
      'Update a single cell in an xlsx file. If the file is being edited in the front-end, the system will flush unsaved changes before updating. After modification, the front-end will reload the file. Useful for AI to toggle test case status, update coverage numbers, or fix typos in a verification matrix.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'xlsx file path (absolute or relative to project root).' },
          sheet: { type: 'string', description: 'Sheet name.' },
          row: { type: 'number', description: 'Row number (1-based).' },
          col: { type: 'number', description: 'Column number (1-based, A=1, B=2, ...).' },
          value: {
            description: 'New cell value. Can be string, number, boolean, or null (to clear).',
          },
        },
        required: ['path', 'sheet', 'row', 'col', 'value'],
        additionalProperties: false,
      },
      async (args) => {
        const inputPath = typeof args.path === 'string' ? args.path : '';
        if (!inputPath) {
          return TEXT(JSON.stringify({ error: 'path is required' }));
        }
        const sheet = typeof args.sheet === 'string' ? args.sheet : '';
        if (!sheet) {
          return TEXT(JSON.stringify({ error: 'sheet is required' }));
        }
        const row = typeof args.row === 'number' ? args.row : 0;
        const col = typeof args.col === 'number' ? args.col : 0;
        if (row < 1 || col < 1) {
          return TEXT(JSON.stringify({ error: `row and col must be 1-based positive integers (got row=${row}, col=${col})` }));
        }
        const value = (args.value === null ? null : args.value) as CellValue;
        const absPath = isAbsolute(inputPath) ? inputPath : resolve(ctx.cwd, inputPath);
        try {
          if (isEditing(absPath)) {
            await requestFlush(absPath);
          }
          const result = await updateCell(absPath, sheet, row, col, value);
          notifyFileChanged(absPath);
          return TEXT(JSON.stringify(result));
        } catch (err) {
          return TEXT(JSON.stringify({ error: `update_xlsx_cell failed: ${err instanceof Error ? err.message : String(err)}` }));
        }
      },
    ),
  ];
}
