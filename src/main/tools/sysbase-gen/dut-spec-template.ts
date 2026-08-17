/**
 * Dut spec template generator — generates xlsx from a markdown-defined structure.
 *
 * Instead of relying on a static `docs/dut_spec_template.xlsx` file, this module
 * defines the template structure in code (based on the markdown format in
 * `docs/unisoc-soc-env-generator-flow.md`) and generates the xlsx on the fly
 * using exceljs.
 *
 * The dut_spec has two sheets:
 *   1. Architecture — multiple sections (AXI, AHB, APB, POWER, CLKRST)
 *   2. MemoryMap — multiple sections (Region, Slave, Master)
 */

import ExcelJS from 'exceljs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

/** A row in a section (array of cell values). */
type Row = string[];

/** A section within a sheet (has a header row + data rows). */
type Section = {
  /** Header row (column titles). */
  header: Row;
  /** Data rows (can be empty for template). */
  rows: Row[];
};

/** A sheet definition with multiple sections. */
type SheetDef = {
  name: string;
  /** The first row of the sheet (e.g. Subsystem_Name | APCPU_SYS | ...). */
  titleRow: Row;
  /** Sections in order. */
  sections: Section[];
};

/** Architecture sheet definition. */
const ARCHITECTURE_SHEET: SheetDef = {
  name: 'Architecture',
  titleRow: ['Subsystem_Name', 'APCPU_SYS', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  sections: [
    {
      header: ['AXI_Name', 'Type', 'is_Active', 'Spec_Ver', 'Is_Lite', 'Spec_Subtype', 'Addr_Width', 'Data_Width', 'WID_Width', 'RID_Width', 'Auser_Width', 'Message_L', 'Rtl_Hier', 'Rtl_File', 'Clock_Name', 'Reset_Name', 'Sig_Mch_Pattern', 'Not_Touch', 'SV_MODEL'],
      rows: [
        ['AXIMST_APCPU_DSU_MM', 'MASTER', 'ACTIVE', 'AMBA4', 'NO', 'AXI_BASE', '64', '256', '10', '10', '14', 'MEDIUM', '`HIER_APCPU_CLUSTER', '$PROJ_RTL/apcpu_sys/xxx', 'ACLENENM0', 'nRESET', '*M0', 'YES', 'YES'],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ],
    },
    {
      header: ['AHB_Name', 'Type', 'is_Active', 'Spec_Ver', 'Is_Lite', 'Addr_Width', 'Data_Width', 'Has_Hsel', 'Hsel_Number', 'Hsel_Addr_Map', 'Message_L', 'Rtl_Hier', 'Rtl_File', 'Clock_Name', 'Reset_Name', 'Sig_Mch_Pattern', 'Not_Touch', 'SV_MODEL', ''],
      rows: [
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ],
    },
    {
      header: ['APB_Name', 'Type', 'is_Active', 'Spec_Ver', 'Addr_Width', 'Data_Width', 'Psel_Number', 'Psel_Addr_Map', 'Message_L', 'Rtl_Hier', 'Rtl_File', 'Clock_Name', 'Reset_Name', 'Sig_Mch_Pattern', 'Not_Touch', 'SV_MODEL', '', '', ''],
      rows: [
        ['APBMST_APCPU_FROM_TOP', 'MASTER', 'ACTIVE', 'APB3', '64', '32', '1', '0x20_6495_0000:0x20_6495_FFFF', 'MEDIUM', '`HIER_APCPU_AON_APB_ASYNC_BRG', '$PROJ_RTL/common/…', 'clk_c', 'reset_c_n', '*_c', 'YES', 'YES', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ],
    },
    {
      header: ['POWER_Name', 'Type', 'Is_Active', 'Parent_Domain', 'Clock_Name', 'Ctrl_CLKRST_Name', 'Not_Touch', '', '', '', '', '', '', '', '', '', '', '', ''],
      rows: [
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ],
    },
    {
      header: ['CLKRST_Name', 'Type', 'Is_Active', 'Sync_Clock', 'Ref_Clock', 'Freq', 'Rest_Time', 'Clock_Name', 'Reset_Name', 'Not_Touch', '', '', '', '', '', '', '', '', ''],
      rows: [
        ['u_clk_func_ate', 'CLK_ARST', 'ACTIVE', 'NO', 'NA', '26MHZ', '500ns', 'clk_func_ate', 'NA', 'NO', '', '', '', '', '', '', '', '', ''],
      ],
    },
  ],
};

/** MemoryMap sheet definition. */
const MEMORY_MAP_SHEET: SheetDef = {
  name: 'MemoryMap',
  titleRow: ['Subsystem_Name', 'APCPU_SYS', '', '', '', '', '', '', '', '', ''],
  sections: [
    {
      header: ['Region_Name', 'Start_Address', 'End_Address', 'RW', 'Test_Offset', 'Enable_Bit', 'Power', 'Remap', 'MapAddr0', '', ''],
      rows: [
        ['', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', ''],
      ],
    },
    {
      header: ['Slave_Name', 'Region_Name', 'Power', 'Power_Domain', 'Father_Power_Domain', 'Response_error', 'sys_not_child_domain', 'ligth_care', '', '', ''],
      rows: [
        ['', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', '', ''],
      ],
    },
    {
      header: ['Master_Name', 'Slave_Name', 'Remap', 'RAL_MapAddr', 'Power', 'Power_Domain', 'Father_Power_Domain', 'is_dsp', 'pd_auto_en_addr', 'pd_auto_en_bit_num', 'light_care'],
      rows: [],
    },
  ],
};

/** All sheets in order. */
const DUT_SPEC_SHEETS: SheetDef[] = [ARCHITECTURE_SHEET, MEMORY_MAP_SHEET];

/**
 * Generate a dut_spec xlsx file from the markdown-defined template structure.
 *
 * @param outputPath Path to write the xlsx file
 * @param subsysName Optional subsys name to fill in the title row (default: empty)
 */
export async function generateDutSpecTemplate(outputPath: string, subsysName?: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();

  for (const sheetDef of DUT_SPEC_SHEETS) {
    const worksheet = workbook.addWorksheet(sheetDef.name);

    let currentRow = 1;

    // Write title row
    const titleRow = worksheet.getRow(currentRow);
    const titleValues = [...sheetDef.titleRow];
    if (subsysName && titleValues.length > 1) {
      titleValues[1] = subsysName.toUpperCase();
    }
    titleValues.forEach((val, i) => {
      titleRow.getCell(i + 1).value = val;
    });
    titleRow.font = { bold: true };
    currentRow++;

    // Write each section
    for (const section of sheetDef.sections) {
      // Header row
      const headerRow = worksheet.getRow(currentRow);
      section.header.forEach((val, i) => {
        headerRow.getCell(i + 1).value = val;
      });
      headerRow.font = { bold: true };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E7FF' },
      };
      currentRow++;

      // Data rows
      for (const dataRow of section.rows) {
        const row = worksheet.getRow(currentRow);
        dataRow.forEach((val, i) => {
          row.getCell(i + 1).value = val || null;
        });
        currentRow++;
      }

      // Empty separator row between sections
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
 * Get a preview of the dut_spec template structure (sheet names + section headers).
 * Used by the UI to show a template preview without generating the file.
 */
export function getDutSpecTemplatePreview(): { sheets: { name: string; headers: string[] }[] } {
  return {
    sheets: DUT_SPEC_SHEETS.map((sheet) => ({
      name: sheet.name,
      headers: sheet.sections[0]?.header ?? [],
    })),
  };
}
