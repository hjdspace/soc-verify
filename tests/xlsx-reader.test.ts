/**
 * xlsx-reader 单元测试。
 *
 * 测试缝：readXlsxWorkbook 函数的命名空间修正逻辑。
 * mock exceljs（Workbook + readFile/load）和 jszip，不真实读写文件。
 *
 * 覆盖场景：
 *  - 正常 xlsx 文件（readFile 成功）→ 直接返回 workbook
 *  - officecli 生成的 xlsx（readFile 抛出 "reading 'sheets'" 错误）→ 触发命名空间修正
 *  - 非命名空间错误 → 直接 rethrow
 *  - 修正后 load 成功
 *  - stripNamespace 正确去除 x: 和 ap: 前缀
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock exceljs
const { ExcelJSWorkbookMock } = vi.hoisted(() => {
  const instance = {
    xlsx: {
      readFile: vi.fn(),
      load: vi.fn(),
    },
  };
  return {
    ExcelJSWorkbookMock: {
      instance,
      ctor: vi.fn(function () {
        return instance;
      }),
    },
  };
});

vi.mock('exceljs', () => ({
  default: { Workbook: ExcelJSWorkbookMock.ctor },
}));

import { readXlsxWorkbook } from '../src/main/document/xlsx-reader';

describe('readXlsxWorkbook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('正常 xlsx 文件直接读取成功（不触发命名空间修正）', async () => {
    ExcelJSWorkbookMock.instance.xlsx.readFile.mockResolvedValue(undefined);

    const result = await readXlsxWorkbook('/tmp/normal.xlsx');

    expect(ExcelJSWorkbookMock.ctor).toHaveBeenCalledTimes(1);
    expect(ExcelJSWorkbookMock.instance.xlsx.readFile).toHaveBeenCalledWith('/tmp/normal.xlsx');
    expect(ExcelJSWorkbookMock.instance.xlsx.load).not.toHaveBeenCalled();
    expect(result).toBe(ExcelJSWorkbookMock.instance);
  });

  it('非命名空间错误直接 rethrow', async () => {
    ExcelJSWorkbookMock.instance.xlsx.readFile.mockRejectedValue(
      new Error('File not found: /tmp/missing.xlsx'),
    );

    await expect(readXlsxWorkbook('/tmp/missing.xlsx')).rejects.toThrow('File not found');
    expect(ExcelJSWorkbookMock.instance.xlsx.load).not.toHaveBeenCalled();
  });

  it('officecli 生成的 xlsx（reading sheets 错误）触发命名空间修正', async () => {
    // 模拟 officecli 生成的 xlsx 文件
    const tmpDir = join(tmpdir(), `xlsx-reader-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const xlsxPath = join(tmpDir, 'officecli-gen.xlsx');

    // 用 jszip 创建一个带 x: 前缀的 xlsx 文件
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file(
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheets><x:sheet name="Sheet1" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" /></x:sheets></x:workbook>',
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<?xml version="1.0" encoding="utf-8"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData /></x:worksheet>',
    );
    zip.file(
      'docProps/app.xml',
      '<?xml version="1.0" encoding="utf-8"?><ap:Properties xmlns:ap="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><ap:Application>OfficeCLI/1.0.143</ap:Application></ap:Properties>',
    );
    zip.file(
      'docProps/core.xml',
      '<?xml version="1.0" encoding="utf-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><dc:creator>OfficeCLI</dc:creator></cp:coreProperties>',
    );
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');

    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(xlsxPath, buf);

    try {
      // readFile 抛出命名空间错误，load 成功
      ExcelJSWorkbookMock.instance.xlsx.readFile.mockRejectedValue(
        new TypeError("Cannot read properties of undefined (reading 'sheets')"),
      );
      ExcelJSWorkbookMock.instance.xlsx.load.mockResolvedValue(undefined);

      const result = await readXlsxWorkbook(xlsxPath);

      expect(ExcelJSWorkbookMock.instance.xlsx.readFile).toHaveBeenCalledTimes(1);
      expect(ExcelJSWorkbookMock.instance.xlsx.load).toHaveBeenCalledTimes(1);
      expect(result).toBe(ExcelJSWorkbookMock.instance);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reading company 错误也触发命名空间修正', async () => {
    const tmpDir = join(tmpdir(), `xlsx-reader-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const xlsxPath = join(tmpDir, 'officecli-gen2.xlsx');

    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file(
      'xl/workbook.xml',
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" /></sheets></workbook>',
    );
    zip.file('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData /></worksheet>');
    zip.file(
      'docProps/app.xml',
      '<?xml version="1.0"?><ap:Properties xmlns:ap="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><ap:Application>OfficeCLI</ap:Application></ap:Properties>',
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(xlsxPath, buf);

    try {
      ExcelJSWorkbookMock.instance.xlsx.readFile.mockRejectedValue(
        new TypeError("Cannot read properties of undefined (reading 'company')"),
      );
      ExcelJSWorkbookMock.instance.xlsx.load.mockResolvedValue(undefined);

      const result = await readXlsxWorkbook(xlsxPath);
      expect(ExcelJSWorkbookMock.instance.xlsx.load).toHaveBeenCalledTimes(1);
      expect(result).toBe(ExcelJSWorkbookMock.instance);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
