/**
 * Template loader for sysbase-gen — resolves and previews Excel templates.
 *
 * Provides:
 *   - resolveTemplatePath: resolve absolute path to dut_spec / mini template xlsx
 *   - getTemplatePreview: read template xlsx and extract sheet names + header row
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readXlsxWorkbook } from '../../document/xlsx-reader';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Template file names mapped by template identifier. */
const TEMPLATE_FILES = {
  dut_spec: 'dut_spec_template.xlsx',
  mini: 'sysbase_mini_case_template.xlsx',
} as const;

export type TemplateName = keyof typeof TEMPLATE_FILES;

/** Check if a string is a valid template name. */
export function isTemplateName(value: string): value is TemplateName {
  return value in TEMPLATE_FILES;
}

/**
 * Resolve the absolute path to a template xlsx file.
 *
 * Template files live in the `docs/` directory at the project root.
 *
 * In the bundled CJS output, all main-process modules are inlined into
 * `out/main/index.cjs`, so `__dirname` is `out/main/` and the project root
 * is two levels up (`../../docs`).
 * In vitest (source files), `__dirname` is `src/main/tools/sysbase-gen/`
 * and the project root is four levels up (`../../../../docs`).
 *
 * We try the bundled path first, then fall back to the source path.
 *
 * @param template Template identifier: 'dut_spec' or 'mini'
 * @returns Absolute file path to the template xlsx
 * @throws Error if template name is unknown
 */
export function resolveTemplatePath(template: TemplateName): string {
  const filename = TEMPLATE_FILES[template];
  // Bundled output: out/main/ → ../../docs
  const bundledPath = resolve(__dirname, '../../docs', filename);
  if (existsSync(bundledPath)) return bundledPath;
  // Source/test: src/main/tools/sysbase-gen/ → ../../../../docs
  return resolve(__dirname, '../../../../docs', filename);
}

/** Template preview sheet data. */
export type TemplatePreviewSheet = {
  /** Sheet name, e.g. "Architecture" */
  name: string;
  /** First row cell values (headers), pipe-separated in preview */
  headers: string[];
};

/** Template preview data. */
export type TemplatePreview = {
  sheets: TemplatePreviewSheet[];
};

/**
 * Read a template xlsx file and extract sheet names + first row as headers.
 *
 * @param template Template identifier: 'dut_spec' or 'mini'
 * @returns Preview data with sheet names and header rows
 * @throws Error if the template file does not exist
 */
export async function getTemplatePreview(template: TemplateName): Promise<TemplatePreview> {
  const filePath = resolveTemplatePath(template);
  if (!existsSync(filePath)) {
    throw new Error(`模板文件不存在: ${filePath}`);
  }

  const workbook = await readXlsxWorkbook(filePath);
  const sheets: TemplatePreviewSheet[] = [];

  workbook.eachSheet((worksheet) => {
    const headers: string[] = [];
    const row = worksheet.getRow(1);
    row.eachCell({ includeEmpty: false }, (cell) => {
      const val = cell.value;
      if (val !== null && val !== undefined) {
        headers.push(String(val));
      }
    });
    sheets.push({ name: worksheet.name, headers });
  });

  return { sheets };
}
