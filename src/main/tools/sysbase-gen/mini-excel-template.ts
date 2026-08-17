/**
 * Mini excel template generator — generates xlsx from a code-defined structure.
 *
 * Instead of relying on the static `docs/sysbase_mini_case_template.xlsx` file,
 * this module defines the template structure in code (based on the parsed
 * structure from the original template file) and generates the xlsx on the fly
 * using exceljs.
 *
 * The mini excel has four sheets:
 *   1. BFM_INFO  — BFM/core info with a title row + header + sample data
 *   2. IP_PATH_INFO — IP path configuration (header only)
 *   3. IP_CFG_INFO — IP configuration (header only)
 *   4. IP_IPV_INFO — IP IPV configuration (header only)
 */

import ExcelJS from 'exceljs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

/** A row in a section (array of cell values). */
type Row = string[];

/** A sheet definition. */
type MiniSheetDef = {
  name: string;
  /** The title row (e.g. Subsys_Name | APCPU_SYS). Optional — only BFM_INFO has one. */
  titleRow?: Row;
  /** Header row (column titles). */
  header: Row;
  /** Data rows (can contain sample data or be empty for template). */
  rows: Row[];
};

/** BFM_INFO sheet definition. */
const BFM_INFO_SHEET: MiniSheetDef = {
  name: 'BFM_INFO',
  titleRow: ['Subsys_Name', 'APCPU_SYS'],
  header: ['Core_Name', 'Type', 'Address_Width', 'Data_Width'],
  rows: [
    ['APCPU', 'AXI', '64', '64'],
    ['AON', 'AXI', '64', '32'],
  ],
};

/** IP_PATH_INFO sheet definition. */
const IP_PATH_INFO_SHEET: MiniSheetDef = {
  name: 'IP_PATH_INFO',
  header: [
    'IP_NAME',
    'Core_Name',
    'Base_Address',
    'Reg_Offset',
    'Write_Data',
    'Data_Mask(32bit)',
    'Action',
    'Repeat',
    'Is_Valid',
  ],
  rows: [],
};

/** IP_CFG_INFO sheet definition. */
const IP_CFG_INFO_SHEET: MiniSheetDef = {
  name: 'IP_CFG_INFO',
  header: [
    'IP_NAME',
    'Core_Name',
    'Soft_Reset',
    'IP_Eb_0',
    'IP_Eb_1',
    'IP_Eb_2',
    'IP_Eb_3',
    'Clk_Info',
    'Region',
    'Antihang',
  ],
  rows: [],
};

/** IP_IPV_INFO sheet definition. */
const IP_IPV_INFO_SHEET: MiniSheetDef = {
  name: 'IP_IPV_INFO',
  header: [
    'IP_NAME',
    'Instance_Name',
    'IP_Clk',
    'Interrupt_Signal',
    'INTC Cfg',
    'Clk Pad Sel',
    ' Pad Cfg',
    'Misc Cfg',
    'DDR Region in Systba Dut Spec',
  ],
  rows: [],
};

/** All sheets in order. */
const MINI_EXCEL_SHEETS: MiniSheetDef[] = [
  BFM_INFO_SHEET,
  IP_PATH_INFO_SHEET,
  IP_CFG_INFO_SHEET,
  IP_IPV_INFO_SHEET,
];

/**
 * Generate a mini excel xlsx file from the code-defined template structure.
 *
 * @param outputPath Path to write the xlsx file
 * @param subsysName Optional subsys name to fill in the BFM_INFO title row
 */
export async function generateMiniExcelTemplate(outputPath: string, subsysName?: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();

  for (const sheetDef of MINI_EXCEL_SHEETS) {
    const worksheet = workbook.addWorksheet(sheetDef.name);

    let currentRow = 1;

    // Write title row (only BFM_INFO has one)
    if (sheetDef.titleRow) {
      const titleRow = worksheet.getRow(currentRow);
      const titleValues = [...sheetDef.titleRow];
      if (subsysName && titleValues.length > 1) {
        titleValues[1] = subsysName.toUpperCase();
      }
      titleValues.forEach((val, i) => {
        titleRow.getCell(i + 1).value = val;
      });
      titleRow.font = { bold: true };
      // Red fill for title row (matching original template)
      titleRow.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFF0000' },
        };
      });
      currentRow++;
    }

    // Write header row
    const headerRow = worksheet.getRow(currentRow);
    sheetDef.header.forEach((val, i) => {
      headerRow.getCell(i + 1).value = val;
    });
    headerRow.font = { bold: true };
    // Green fill for header row (matching original template #92D050)
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF92D050' },
      };
    });
    currentRow++;

    // Write data rows
    for (const dataRow of sheetDef.rows) {
      const row = worksheet.getRow(currentRow);
      dataRow.forEach((val, i) => {
        row.getCell(i + 1).value = val || null;
      });
      currentRow++;
    }

    // Set column widths
    worksheet.columns.forEach((col) => {
      col.width = 18;
    });
  }

  // Ensure directory exists
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  await writeFile(outputPath, '');
  await workbook.xlsx.writeFile(outputPath);
}

/**
 * Get a preview of the mini excel template structure (sheet names + headers).
 * Used by the UI to show a template preview without generating the file.
 */
export function getMiniExcelTemplatePreview(): { sheets: { name: string; headers: string[] }[] } {
  return {
    sheets: MINI_EXCEL_SHEETS.map((sheet) => ({
      name: sheet.name,
      headers: sheet.header,
    })),
  };
}
