/**
 * fortune-sheet-bridge 双向转换测试。
 *
 * 测试缝：真实 exceljs Workbook 对象 ↔ Fortune-sheet WorkbookData。
 * 部分用例写真实 xlsx 临时文件并读回，验证端到端保真度。
 *
 * 覆盖：单元格值类型（字符串/数字/布尔/日期/公式）、样式（字体/填充/对齐）、
 * 合并单元格、列宽/行高、多 sheet、空工作簿、round-trip。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  excelToFortune,
  fortuneToExcel,
  type WorkbookData,
} from '../src/main/document/fortune-sheet-bridge';

/** 在临时目录创建测试用的 xlsx 文件，返回路径 */
async function writeTempXlsx(workbook: ExcelJS.Workbook): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-bridge-'));
  const filePath = join(dir, 'test.xlsx');
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

/** 查找 Fortune-sheet celldata 中指定位置的 cell */
function findCell(
  data: WorkbookData,
  sheetIndex: number,
  r: number,
  c: number,
): CellWithRowAndCol | undefined {
  const sheet = data.sheets[sheetIndex];
  if (!sheet?.celldata) return undefined;
  return sheet.celldata.find((cd) => cd.r === r && cd.c === c);
}

// 引入 fortune-sheet 类型仅用于类型标注
import type { CellWithRowAndCol } from '@fortune-sheet/core';

describe('fortune-sheet-bridge', () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = null;
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── excelToFortune：值类型转换 ─────────────────────────────

  describe('excelToFortune - 值类型', () => {
    it('转换字符串单元格', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = 'hello';

      const data = excelToFortune(wb);

      expect(data.sheets).toHaveLength(1);
      expect(data.sheets[0].name).toBe('Sheet1');
      const cell = findCell(data, 0, 0, 0);
      expect(cell?.v?.v).toBe('hello');
      expect(cell?.v?.m).toBe('hello');
    });

    it('转换数字单元格', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = 42;

      const data = excelToFortune(wb);
      const cell = findCell(data, 0, 0, 0);
      expect(cell?.v?.v).toBe(42);
    });

    it('转换布尔单元格', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = true;

      const data = excelToFortune(wb);
      const cell = findCell(data, 0, 0, 0);
      expect(cell?.v?.v).toBe(true);
    });

    it('转换日期单元格并保留数字格式', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      const date = new Date('2024-01-15T00:00:00.000Z');
      ws.getCell(1, 1).value = date;
      ws.getCell(1, 1).numFmt = 'yyyy-mm-dd';

      const data = excelToFortune(wb);
      const cell = findCell(data, 0, 0, 0);
      expect(cell?.v?.ct?.t).toBe('d');
      expect(cell?.v?.ct?.fa).toBe('yyyy-mm-dd');
    });

    it('转换公式单元格，保留公式和结果', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = { formula: 'B1+C1', result: 5 };

      const data = excelToFortune(wb);
      const cell = findCell(data, 0, 0, 0);
      expect(cell?.v?.f).toBe('B1+C1');
      expect(cell?.v?.v).toBe(5);
    });

    it('跳过空单元格', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = 'a';
      // (1,2) 留空

      const data = excelToFortune(wb);
      expect(data.sheets[0].celldata).toHaveLength(1);
      expect(findCell(data, 0, 0, 1)).toBeUndefined();
    });
  });

  // ─── excelToFortune：样式转换 ───────────────────────────────

  describe('excelToFortune - 样式', () => {
    it('转换字体样式（粗体、斜体、颜色、字号）', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = 'styled';
      ws.getCell(1, 1).style = {
        font: { bold: true, italic: true, size: 14, color: { argb: 'FFFF0000' } },
      };

      const data = excelToFortune(wb);
      const cell = findCell(data, 0, 0, 0);
      expect(cell?.v?.bl).toBe(1);
      expect(cell?.v?.it).toBe(1);
      expect(cell?.v?.fs).toBe(14);
      expect(cell?.v?.fc).toMatch(/#FF0000/i);
    });

    it('转换背景填充色', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = 'bg';
      ws.getCell(1, 1).style = {
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } },
      };

      const data = excelToFortune(wb);
      const cell = findCell(data, 0, 0, 0);
      expect(cell?.v?.bg).toMatch(/#FFFF00/i);
    });

    it('转换对齐方式', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = 'aligned';
      ws.getCell(1, 1).style = {
        alignment: { horizontal: 'center', vertical: 'middle' },
      };

      const data = excelToFortune(wb);
      const cell = findCell(data, 0, 0, 0);
      expect(cell?.v?.ht).toBe(0); // center
      expect(cell?.v?.vt).toBe(0); // middle
    });
  });

  // ─── excelToFortune：合并单元格、列宽、行高 ─────────────────

  describe('excelToFortune - 结构', () => {
    it('转换合并单元格到 config.merge', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.mergeCells('A1:B2');
      ws.getCell('A1').value = 'merged';

      const data = excelToFortune(wb);
      const merge = data.sheets[0].config?.merge ?? {};
      const keys = Object.keys(merge);
      expect(keys).toHaveLength(1);
      const m = merge[keys[0]];
      expect(m.r).toBe(0);
      expect(m.c).toBe(0);
      expect(m.rs).toBe(2);
      expect(m.cs).toBe(2);
    });

    it('转换列宽到 config.columnlen', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = 'x';
      ws.getColumn(1).width = 25;

      const data = excelToFortune(wb);
      expect(data.sheets[0].config?.columnlen?.['0']).toBe(25);
    });

    it('转换行高到 config.rowlen', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = 'x';
      ws.getRow(1).height = 30;

      const data = excelToFortune(wb);
      expect(data.sheets[0].config?.rowlen?.['0']).toBe(30);
    });

    it('处理多个 sheet', () => {
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('First');
      wb.addWorksheet('Second');

      const data = excelToFortune(wb);
      expect(data.sheets).toHaveLength(2);
      expect(data.sheets[0].name).toBe('First');
      expect(data.sheets[1].name).toBe('Second');
    });

    it('处理空工作簿', () => {
      const wb = new ExcelJS.Workbook();
      const data = excelToFortune(wb);
      expect(data.sheets).toHaveLength(0);
    });
  });

  // ─── fortuneToExcel：值类型转换 ─────────────────────────────

  describe('fortuneToExcel - 值类型', () => {
    it('转换字符串单元格', async () => {
      const data: WorkbookData = {
        name: 'test',
        sheets: [
          {
            name: 'Sheet1',
            celldata: [{ r: 0, c: 0, v: { v: 'hello', m: 'hello' } }],
          },
        ],
      };

      const wb = await fortuneToExcel(data);
      const ws = wb.getWorksheet('Sheet1');
      expect(ws?.getCell(1, 1).value).toBe('hello');
    });

    it('转换数字单元格', async () => {
      const data: WorkbookData = {
        name: 'test',
        sheets: [
          {
            name: 'Sheet1',
            celldata: [{ r: 0, c: 0, v: { v: 42, m: '42' } }],
          },
        ],
      };

      const wb = await fortuneToExcel(data);
      expect(wb.getWorksheet('Sheet1')?.getCell(1, 1).value).toBe(42);
    });

    it('转换布尔单元格', async () => {
      const data: WorkbookData = {
        name: 'test',
        sheets: [
          {
            name: 'Sheet1',
            celldata: [{ r: 0, c: 0, v: { v: true, m: 'TRUE' } }],
          },
        ],
      };

      const wb = await fortuneToExcel(data);
      expect(wb.getWorksheet('Sheet1')?.getCell(1, 1).value).toBe(true);
    });

    it('转换公式单元格', async () => {
      const data: WorkbookData = {
        name: 'test',
        sheets: [
          {
            name: 'Sheet1',
            celldata: [{ r: 0, c: 0, v: { f: 'B1+C1', v: 5, m: '5' } }],
          },
        ],
      };

      const wb = await fortuneToExcel(data);
      const cell = wb.getWorksheet('Sheet1')?.getCell(1, 1);
      expect(cell?.formula).toBe('B1+C1');
      expect(cell?.result).toBe(5);
    });

    it('转换日期单元格回 Date', async () => {
      const data: WorkbookData = {
        name: 'test',
        sheets: [
          {
            name: 'Sheet1',
            celldata: [
              {
                r: 0,
                c: 0,
                v: {
                  v: '2024-01-15T00:00:00.000Z',
                  m: '2024-01-15',
                  ct: { fa: 'yyyy-mm-dd', t: 'd' },
                },
              },
            ],
          },
        ],
      };

      const wb = await fortuneToExcel(data);
      const cell = wb.getWorksheet('Sheet1')?.getCell(1, 1);
      expect(cell?.value).toBeInstanceOf(Date);
    });
  });

  // ─── fortuneToExcel：结构转换 ───────────────────────────────

  describe('fortuneToExcel - 结构', () => {
    it('转换合并单元格', async () => {
      const data: WorkbookData = {
        name: 'test',
        sheets: [
          {
            name: 'Sheet1',
            celldata: [{ r: 0, c: 0, v: { v: 'merged', m: 'merged' } }],
            config: {
              merge: { '0_0': { r: 0, c: 0, rs: 2, cs: 2 } },
            },
          },
        ],
      };

      const wb = await fortuneToExcel(data);
      const ws = wb.getWorksheet('Sheet1');
      expect(ws?.model.merges).toContain('A1:B2');
    });

    it('转换列宽', async () => {
      const data: WorkbookData = {
        name: 'test',
        sheets: [
          {
            name: 'Sheet1',
            celldata: [{ r: 0, c: 0, v: { v: 'x', m: 'x' } }],
            config: { columnlen: { '0': 25 } },
          },
        ],
      };

      const wb = await fortuneToExcel(data);
      expect(wb.getWorksheet('Sheet1')?.getColumn(1).width).toBe(25);
    });

    it('转换行高', async () => {
      const data: WorkbookData = {
        name: 'test',
        sheets: [
          {
            name: 'Sheet1',
            celldata: [{ r: 0, c: 0, v: { v: 'x', m: 'x' } }],
            config: { rowlen: { '0': 30 } },
          },
        ],
      };

      const wb = await fortuneToExcel(data);
      expect(wb.getWorksheet('Sheet1')?.getRow(1).height).toBe(30);
    });

    it('转换字体样式', async () => {
      const data: WorkbookData = {
        name: 'test',
        sheets: [
          {
            name: 'Sheet1',
            celldata: [
              {
                r: 0,
                c: 0,
                v: { v: 'bold', m: 'bold', bl: 1, it: 1, fs: 14, fc: '#FF0000' },
              },
            ],
          },
        ],
      };

      const wb = await fortuneToExcel(data);
      const cell = wb.getWorksheet('Sheet1')?.getCell(1, 1);
      expect(cell?.font?.bold).toBe(true);
      expect(cell?.font?.italic).toBe(true);
      expect(cell?.font?.size).toBe(14);
      expect(cell?.font?.color?.argb).toMatch(/FF0000$/i);
    });

    it('转换背景色', async () => {
      const data: WorkbookData = {
        name: 'test',
        sheets: [
          {
            name: 'Sheet1',
            celldata: [{ r: 0, c: 0, v: { v: 'x', m: 'x', bg: '#FFFF00' } }],
          },
        ],
      };

      const wb = await fortuneToExcel(data);
      const cell = wb.getWorksheet('Sheet1')?.getCell(1, 1);
      expect(cell?.fill?.type).toBe('pattern');
      if (cell?.fill?.type === 'pattern') {
        expect(cell.fill.fgColor?.argb).toMatch(/FFFF00$/i);
      }
    });
  });

  // ─── round-trip ─────────────────────────────────────────────

  describe('round-trip 转换', () => {
    it('字符串/数字/公式 round-trip 保持值', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = 'text';
      ws.getCell(1, 2).value = 100;
      ws.getCell(1, 3).value = { formula: 'B1*2', result: 200 };

      const data = excelToFortune(wb);
      const wb2 = await fortuneToExcel(data);
      const ws2 = wb2.getWorksheet('Sheet1');

      expect(ws2?.getCell(1, 1).value).toBe('text');
      expect(ws2?.getCell(1, 2).value).toBe(100);
      expect(ws2?.getCell(1, 3).formula).toBe('B1*2');
      expect(ws2?.getCell(1, 3).result).toBe(200);
    });

    it('样式 round-trip 保持粗体和背景色', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = 'styled';
      ws.getCell(1, 1).style = {
        font: { bold: true, color: { argb: 'FFFF0000' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF00' } },
      };

      const data = excelToFortune(wb);
      const wb2 = await fortuneToExcel(data);
      const cell = wb2.getWorksheet('Sheet1')?.getCell(1, 1);

      expect(cell?.font?.bold).toBe(true);
      expect(cell?.font?.color?.argb).toMatch(/FF0000$/i);
      if (cell?.fill?.type === 'pattern') {
        expect(cell.fill.fgColor?.argb).toMatch(/00FF00$/i);
      }
    });

    it('合并单元格 round-trip 保持合并范围', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.mergeCells('A1:C3');
      ws.getCell('A1').value = 'merged';

      const data = excelToFortune(wb);
      const wb2 = await fortuneToExcel(data);
      const ws2 = wb2.getWorksheet('Sheet1');

      expect(ws2?.model.merges).toContain('A1:C3');
      expect(ws2?.getCell('A1').value).toBe('merged');
    });

    it('列宽行高 round-trip 保持尺寸', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.getCell(1, 1).value = 'x';
      ws.getColumn(1).width = 30;
      ws.getRow(1).height = 40;

      const data = excelToFortune(wb);
      const wb2 = await fortuneToExcel(data);
      const ws2 = wb2.getWorksheet('Sheet1');

      expect(ws2?.getColumn(1).width).toBe(30);
      expect(ws2?.getRow(1).height).toBe(40);
    });

    it('真实 xlsx 文件 round-trip：写文件→读文件→转换→写回→读回', async () => {
      // 1. 创建原始 xlsx 文件
      const wb1 = new ExcelJS.Workbook();
      const ws1 = wb1.addWorksheet('Data');
      ws1.getCell(1, 1).value = 'name';
      ws1.getCell(1, 2).value = 'value';
      ws1.getCell(2, 1).value = 'alpha';
      ws1.getCell(2, 2).value = 100;
      ws1.getCell(2, 2).style = {
        font: { bold: true },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } },
      };
      ws1.mergeCells('A1:B1');
      ws1.getColumn(1).width = 15;

      const filePath = await writeTempXlsx(wb1);
      tempDir = filePath;

      // 2. 用 exceljs 读回文件
      const wbRead = new ExcelJS.Workbook();
      await wbRead.xlsx.readFile(filePath);

      // 3. 转为 Fortune-sheet 数据
      const fortuneData = excelToFortune(wbRead);
      expect(fortuneData.sheets).toHaveLength(1);
      expect(fortuneData.sheets[0].name).toBe('Data');

      // 4. 转回 exceljs 并写回文件
      const wbWrite = await fortuneToExcel(fortuneData);
      const outPath = join(filePath, '..', 'round-trip.xlsx');
      await wbWrite.xlsx.writeFile(outPath);

      // 5. 再次读回验证
      const wbFinal = new ExcelJS.Workbook();
      await wbFinal.xlsx.readFile(outPath);
      const wsFinal = wbFinal.getWorksheet('Data');

      expect(wsFinal?.getCell(2, 1).value).toBe('alpha');
      expect(wsFinal?.getCell(2, 2).value).toBe(100);
      expect(wsFinal?.getCell(2, 2).font?.bold).toBe(true);
      expect(wsFinal?.model.merges).toContain('A1:B1');
      expect(wsFinal?.getColumn(1).width).toBe(15);
    });
  });
});

// ─── xlsx-editor：appendRows / updateCell（Issue #7）──────────────

import { appendRows, updateCell, colIndexToLetter } from '../src/main/document/xlsx-editor';

describe('xlsx-editor — appendRows / updateCell', () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = null;
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** 创建带初始数据的 xlsx 文件 */
  async function writeSeedXlsx(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'xlsx-editor-'));
    tempDir = dir;
    const filePath = join(dir, 'sheet.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.getCell(1, 1).value = 'module';
    ws.getCell(1, 2).value = 'coverage';
    ws.getCell(2, 1).value = 'cpu_core';
    ws.getCell(2, 2).value = 95.2;
    await wb.xlsx.writeFile(filePath);
    return filePath;
  }

  // ─── colIndexToLetter ─────────────────────────────────────

  describe('colIndexToLetter', () => {
    it('1 → A', () => {
      expect(colIndexToLetter(1)).toBe('A');
    });
    it('26 → Z', () => {
      expect(colIndexToLetter(26)).toBe('Z');
    });
    it('27 → AA', () => {
      expect(colIndexToLetter(27)).toBe('AA');
    });
    it('52 → AZ', () => {
      expect(colIndexToLetter(52)).toBe('AZ');
    });
    it('53 → BA', () => {
      expect(colIndexToLetter(53)).toBe('BA');
    });
  });

  // ─── appendRows ──────────────────────────────────────────

  describe('appendRows', () => {
    it('在已有 sheet 末尾追加多行', async () => {
      const filePath = await writeSeedXlsx();

      const result = await appendRows(filePath, 'Data', [
        ['gpu', 78.3],
        ['memory_ctrl', 88.1],
      ]);

      expect(result.path).toBe(filePath);
      expect(result.sheet).toBe('Data');
      expect(result.appendedRows).toBe(2);
      expect(result.startRow).toBe(3); // 原始 2 行，从第 3 行开始追加

      // 读回验证
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(filePath);
      const ws = wb.getWorksheet('Data');
      expect(ws?.rowCount).toBe(4);
      expect(ws?.getCell(3, 1).value).toBe('gpu');
      expect(ws?.getCell(3, 2).value).toBe(78.3);
      expect(ws?.getCell(4, 1).value).toBe('memory_ctrl');
      expect(ws?.getCell(4, 2).value).toBe(88.1);
    });

    it('sheet 不存在时自动创建', async () => {
      const filePath = await writeSeedXlsx();

      const result = await appendRows(filePath, 'NewSheet', [['a', 'b']]);

      expect(result.appendedRows).toBe(1);
      expect(result.startRow).toBe(1);

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(filePath);
      const ws = wb.getWorksheet('NewSheet');
      expect(ws).toBeDefined();
      expect(ws?.getCell(1, 1).value).toBe('a');
      expect(ws?.getCell(1, 2).value).toBe('b');
    });

    it('支持不同类型的单元格值', async () => {
      const filePath = await writeSeedXlsx();
      const date = new Date('2024-01-15T00:00:00.000Z');

      await appendRows(filePath, 'Data', [
        ['string', 42, true, null, date],
      ]);

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(filePath);
      const ws = wb.getWorksheet('Data');
      expect(ws?.getCell(3, 1).value).toBe('string');
      expect(ws?.getCell(3, 2).value).toBe(42);
      expect(ws?.getCell(3, 3).value).toBe(true);
      expect(ws?.getCell(3, 4).value).toBeNull();
      expect(ws?.getCell(3, 5).value).toBeInstanceOf(Date);
    });

    it('空 rows 数组追加 0 行', async () => {
      const filePath = await writeSeedXlsx();

      const result = await appendRows(filePath, 'Data', []);

      expect(result.appendedRows).toBe(0);
      expect(result.startRow).toBe(3);

      // 文件仍可读，行数不变
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(filePath);
      const ws = wb.getWorksheet('Data');
      expect(ws?.rowCount).toBe(2);
    });

    it('文件不存在时抛错', async () => {
      await expect(
        appendRows(join(tmpdir(), 'nonexistent-file.xlsx'), 'Data', [['a']]),
      ).rejects.toThrow();
    });
  });

  // ─── updateCell ──────────────────────────────────────────

  describe('updateCell', () => {
    it('更新已有单元格的值并返回旧值', async () => {
      const filePath = await writeSeedXlsx();

      const result = await updateCell(filePath, 'Data', 2, 2, 99.9);

      expect(result.path).toBe(filePath);
      expect(result.sheet).toBe('Data');
      expect(result.row).toBe(2);
      expect(result.col).toBe(2);
      expect(result.previousValue).toBe(95.2);
      expect(result.newValue).toBe(99.9);

      // 读回验证
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(filePath);
      const ws = wb.getWorksheet('Data');
      expect(ws?.getCell(2, 2).value).toBe(99.9);
    });

    it('更新空单元格时 previousValue 为 null', async () => {
      const filePath = await writeSeedXlsx();

      const result = await updateCell(filePath, 'Data', 5, 5, 'new-value');

      expect(result.previousValue).toBeNull();
      expect(result.newValue).toBe('new-value');

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(filePath);
      const ws = wb.getWorksheet('Data');
      expect(ws?.getCell(5, 5).value).toBe('new-value');
    });

    it('用 null 清除单元格值', async () => {
      const filePath = await writeSeedXlsx();
      // 先写入再清除
      await updateCell(filePath, 'Data', 3, 1, 'temp');
      const result = await updateCell(filePath, 'Data', 3, 1, null);

      expect(result.previousValue).toBe('temp');
      expect(result.newValue).toBeNull();

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(filePath);
      const ws = wb.getWorksheet('Data');
      expect(ws?.getCell(3, 1).value).toBeNull();
    });

    it('支持更新为布尔值', async () => {
      const filePath = await writeSeedXlsx();

      const result = await updateCell(filePath, 'Data', 2, 2, true);

      expect(result.newValue).toBe(true);
      expect(result.previousValue).toBe(95.2);
    });

    it('row 或 col 小于 1 时抛错', async () => {
      const filePath = await writeSeedXlsx();

      await expect(updateCell(filePath, 'Data', 0, 1, 'x')).rejects.toThrow(
        /1-based positive integers/,
      );
      await expect(updateCell(filePath, 'Data', 1, 0, 'x')).rejects.toThrow(
        /1-based positive integers/,
      );
    });

    it('sheet 不存在时抛错', async () => {
      const filePath = await writeSeedXlsx();

      await expect(updateCell(filePath, 'Nonexistent', 1, 1, 'x')).rejects.toThrow(
        /Sheet "Nonexistent" not found/,
      );
    });

    it('文件不存在时抛错', async () => {
      await expect(
        updateCell(join(tmpdir(), 'nonexistent-file.xlsx'), 'Data', 1, 1, 'x'),
      ).rejects.toThrow();
    });
  });
});
