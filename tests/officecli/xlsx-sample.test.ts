import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/main/officecli/service', () => ({
  checkInstalled: vi.fn(),
  getVersion: vi.fn(),
  viewHtml: vi.fn(),
  viewScreenshot: vi.fn(),
  watchStart: vi.fn(),
  watchStop: vi.fn(),
  watchStopAll: vi.fn(),
  listWatches: vi.fn(),
  readImageAsDataURL: vi.fn(),
}));

vi.mock('../../src/main/document/editor-registry', () => ({
  registerEditor: vi.fn(),
  unregisterEditor: vi.fn(),
  notifyFlushDone: vi.fn(),
}));

import { documentRouter } from '../../src/main/ipc/routers/document-router';
import { appendRows, updateCell } from '../../src/main/document/xlsx-editor';
import { readXlsxWorkbook } from '../../src/main/document/xlsx-reader';

const samplePath = resolve(process.cwd(), 'docs/document-1785775908722.xlsx');

describe('documentRouter.loadXlsx with an officecli-generated workbook', () => {
  it('loads the generated workbook into Fortune-sheet data', async () => {
    if (!existsSync(samplePath)) {
      throw new Error(`Required regression fixture is missing: ${samplePath}`);
    }

    const result = await documentRouter.createCaller({}).loadXlsx({ filePath: samplePath });

    expect(result.workbook.sheets.length).toBeGreaterThan(0);
    expect(result.workbook.sheets[0]?.name).toBeTruthy();
  });

  it('edits the generated workbook through the AI xlsx editor seam', async () => {
    if (!existsSync(samplePath)) {
      throw new Error(`Required regression fixture is missing: ${samplePath}`);
    }

    const tempDir = await mkdtemp(resolve(tmpdir(), 'soc-verify-xlsx-sample-'));
    const tempPath = resolve(tempDir, 'sample.xlsx');
    await copyFile(samplePath, tempPath);

    try {
      const workbook = await readXlsxWorkbook(tempPath);
      const sheetName = workbook.worksheets[0]?.name;
      if (!sheetName) {
        throw new Error('Regression fixture has no worksheets');
      }

      const updated = await updateCell(tempPath, sheetName, 1, 1, 'edited');
      expect(updated.newValue).toBe('edited');

      const appended = await appendRows(tempPath, sheetName, [['appended']]);
      expect(appended.appendedRows).toBe(1);

      const reloaded = await readXlsxWorkbook(tempPath);
      const worksheet = reloaded.getWorksheet(sheetName);
      expect(worksheet?.getCell(1, 1).value).toBe('edited');
      expect(worksheet?.getCell(appended.startRow, 1).value).toBe('appended');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
