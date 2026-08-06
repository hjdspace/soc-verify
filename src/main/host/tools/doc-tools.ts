import { mkdir, unlink } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve, dirname } from 'node:path';
import type { OfficeCliExecOptions, OfficeCliExecResult } from '../../officecli/executor';
import { execOfficeCli } from '../../officecli/executor';
import { TEXT, defineTool, type HostToolEntry, type ToolContext } from './shared';

// ── 文档工具辅助函数 ─────────────────────────────────────

/** 解析文档输出路径。outputPath 可为完整文件路径、目录路径或 undefined（默认 <cwd>/docs/） */
function resolveDocumentOutputPath(outputPath: unknown, cwd: string, ext: string): string {
  const extName = `.${ext}`;
  if (typeof outputPath === 'string' && outputPath) {
    if (outputPath.endsWith(extName)) {
      return isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath);
    }
    const dir = isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath);
    return join(dir, `document-${Date.now()}${extName}`);
  }
  return join(cwd, 'docs', `document-${Date.now()}${extName}`);
}

/** 确保目录存在，递归创建 */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function execChecked(options: OfficeCliExecOptions): Promise<OfficeCliExecResult> {
  const result = await execOfficeCli(options);
  if (result.exitCode !== 0) {
    throw new Error(
      `officecli ${options.args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

/** 将 Markdown 文本解析为 officecli batch 操作数组（docx） */
function parseMarkdownToDocxBatchOps(markdown: string): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('### ')) {
      ops.push({ command: 'add', parent: '/body', type: 'paragraph', props: { text: trimmed.slice(4), style: 'Heading3' } });
    } else if (trimmed.startsWith('## ')) {
      ops.push({ command: 'add', parent: '/body', type: 'paragraph', props: { text: trimmed.slice(3), style: 'Heading2' } });
    } else if (trimmed.startsWith('# ')) {
      ops.push({ command: 'add', parent: '/body', type: 'paragraph', props: { text: trimmed.slice(2), style: 'Heading1' } });
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      ops.push({ command: 'add', parent: '/body', type: 'paragraph', props: { text: trimmed.slice(2), listStyle: 'bullet' } });
    } else {
      ops.push({ command: 'add', parent: '/body', type: 'paragraph', props: { text: trimmed } });
    }
  }
  return ops;
}

/** xlsx sheet 数据结构 */
type XlsxSheet = { name: string; data: unknown[][] };

/** 将 sheets 二维数组转换为 officecli batch 操作数组（xlsx） */
function buildXlsxBatchOps(sheets: XlsxSheet[]): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];
  sheets.forEach((sheet, sheetIdx) => {
    if (sheetIdx === 0) {
      ops.push({ command: 'set', path: '/Sheet1', props: { name: sheet.name } });
    } else {
      ops.push({ command: 'add', parent: '/', type: 'sheet', props: { name: sheet.name } });
    }
    const sheetPath = `/${sheet.name}`;
    for (let rowIdx = 0; rowIdx < sheet.data.length; rowIdx++) {
      const row = sheet.data[rowIdx];
      if (!Array.isArray(row)) continue;
      for (let colIdx = 0; colIdx < row.length; colIdx++) {
        const cellValue = row[colIdx];
        if (cellValue === undefined || cellValue === null) continue;
        const colLetter = String.fromCharCode(65 + colIdx);
        const cellRef = `${sheetPath}/${colLetter}${rowIdx + 1}`;
        ops.push({ command: 'set', path: cellRef, props: { value: String(cellValue) } });
      }
    }
  });
  return ops;
}

/** pptx slide 数据结构 */
type PptxSlide = { title: string; content: string };

/** 将 slides 数组转换为 officecli batch 操作数组（pptx） */
function buildPptxBatchOps(slides: PptxSlide[]): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];
  for (const slide of slides) {
    ops.push({ command: 'add', parent: '/', type: 'slide', props: { layout: 'blank', background: 'FFFFFF' } });
    ops.push({
      command: 'add',
      parent: '/slide[last()]',
      type: 'shape',
      props: {
        text: slide.title,
        x: '1.5cm', y: '1cm', width: '30cm', height: '2cm',
        font: 'Georgia', size: '36', bold: 'true', color: '1E2761',
      },
    });
    ops.push({
      command: 'add',
      parent: '/slide[last()]',
      type: 'shape',
      props: {
        text: slide.content,
        x: '1.5cm', y: '4cm', width: '30cm', height: '10cm',
        font: 'Calibri', size: '20', color: '333333',
      },
    });
  }
  return ops;
}

/**
 * 文档创建/读取工具：create_docx / create_xlsx / create_pptx / create_pdf / read_document
 */
export function createDocTools(ctx: ToolContext): HostToolEntry[] {
  return [
    defineTool(
      'create_docx',
      'Create a DOCX document from Markdown content. Supports # / ## / ### headings, - / * bullet lists, and plain text paragraphs. Output defaults to <project>/docs/ but can be overridden via outputPath. Useful for generating SoC verification plans, test specifications, and review reports.',
      {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Markdown content for the document. Supports # / ## / ### headings, - / * bullet lists, and plain text paragraphs.' },
          outputPath: { type: 'string', description: 'Optional output path. Can be a full file path (ending in .docx) or a directory. Defaults to <project>/docs/document-<timestamp>.docx.' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      async (args) => {
        const content = typeof args.content === 'string' ? args.content : '';
        if (!content) {
          return TEXT(JSON.stringify({ error: 'content is required' }));
        }
        const outputPath = resolveDocumentOutputPath(args.outputPath, ctx.cwd, 'docx');
        try {
          await ensureDir(dirname(outputPath));
          await execChecked({ args: ['create', outputPath] });
          const ops = parseMarkdownToDocxBatchOps(content);
          await execChecked({ args: ['batch', outputPath], input: JSON.stringify(ops) });
          return TEXT(JSON.stringify({ path: outputPath, format: 'docx' }));
        } catch (err) {
          return TEXT(JSON.stringify({ error: `create_docx failed: ${err instanceof Error ? err.message : String(err)}` }));
        }
      },
    ),

    defineTool(
      'create_xlsx',
      'Create an XLSX spreadsheet from a 2D array of sheets. Each sheet has a name and a data array of rows (array of cells). Output defaults to <project>/docs/. Useful for SoC coverage reports, regression summaries, and test case matrices. Note: xlsx files created by officecli may contain charts/styles that can be lost if later edited by exceljs.',
      {
        type: 'object',
        properties: {
          sheets: {
            type: 'array',
            description: 'Array of sheets. Each sheet: { name: string, data: unknown[][] } where data is a 2D array of cell values (row-major).',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                data: { type: 'array', items: { type: 'array' } },
              },
            },
          },
          outputPath: { type: 'string', description: 'Optional output path (file ending in .xlsx, or a directory).' },
        },
        required: ['sheets'],
        additionalProperties: false,
      },
      async (args) => {
        const sheets = Array.isArray(args.sheets) ? (args.sheets as XlsxSheet[]) : [];
        if (sheets.length === 0) {
          return TEXT(JSON.stringify({ error: 'sheets is required and must be a non-empty array' }));
        }
        const outputPath = resolveDocumentOutputPath(args.outputPath, ctx.cwd, 'xlsx');
        try {
          await ensureDir(dirname(outputPath));
          await execChecked({ args: ['create', outputPath] });
          const ops = buildXlsxBatchOps(sheets);
          await execChecked({ args: ['batch', outputPath], input: JSON.stringify(ops) });
          return TEXT(JSON.stringify({ path: outputPath, format: 'xlsx' }));
        } catch (err) {
          return TEXT(JSON.stringify({ error: `create_xlsx failed: ${err instanceof Error ? err.message : String(err)}` }));
        }
      },
    ),

    defineTool(
      'create_pptx',
      'Create a PPTX presentation from an array of slides. Each slide has a title and content. Output defaults to <project>/docs/. Useful for SoC verification plan reviews, regression sign-off decks, and TO (tape-out) checklists.',
      {
        type: 'object',
        properties: {
          slides: {
            type: 'array',
            description: 'Array of slides. Each slide: { title: string, content: string }.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                content: { type: 'string' },
              },
            },
          },
          outputPath: { type: 'string', description: 'Optional output path (file ending in .pptx, or a directory).' },
        },
        required: ['slides'],
        additionalProperties: false,
      },
      async (args) => {
        const slides = Array.isArray(args.slides) ? (args.slides as PptxSlide[]) : [];
        if (slides.length === 0) {
          return TEXT(JSON.stringify({ error: 'slides is required and must be a non-empty array' }));
        }
        const outputPath = resolveDocumentOutputPath(args.outputPath, ctx.cwd, 'pptx');
        try {
          await ensureDir(dirname(outputPath));
          await execChecked({ args: ['create', outputPath] });
          const ops = buildPptxBatchOps(slides);
          await execChecked({ args: ['batch', outputPath], input: JSON.stringify(ops) });
          return TEXT(JSON.stringify({ path: outputPath, format: 'pptx' }));
        } catch (err) {
          return TEXT(JSON.stringify({ error: `create_pptx failed: ${err instanceof Error ? err.message : String(err)}` }));
        }
      },
    ),

    defineTool(
      'create_pdf',
      'Create a PDF document from Markdown content. Internally converts Markdown to DOCX then exports to PDF via officecli. Output defaults to <project>/docs/. Useful for SoC regression reports, TO checklists, and sign-off documents that need a fixed-format deliverable.',
      {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Markdown content for the document. Supports # / ## / ### headings, - / * bullet lists, and plain text paragraphs.' },
          outputPath: { type: 'string', description: 'Optional output path (file ending in .pdf, or a directory).' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      async (args) => {
        const content = typeof args.content === 'string' ? args.content : '';
        if (!content) {
          return TEXT(JSON.stringify({ error: 'content is required' }));
        }
        const pdfPath = resolveDocumentOutputPath(args.outputPath, ctx.cwd, 'pdf');
        const docxPath = pdfPath.replace(/\.pdf$/i, '.docx');
        try {
          await ensureDir(dirname(pdfPath));
          await execChecked({ args: ['create', docxPath] });
          const ops = parseMarkdownToDocxBatchOps(content);
          await execChecked({ args: ['batch', docxPath], input: JSON.stringify(ops) });
          await execChecked({ args: ['view', docxPath, 'pdf', '-o', pdfPath] });
          try { await unlink(docxPath); } catch { /* best-effort cleanup */ }
          return TEXT(JSON.stringify({ path: pdfPath, format: 'pdf' }));
        } catch (err) {
          return TEXT(JSON.stringify({ error: `create_pdf failed: ${err instanceof Error ? err.message : String(err)}` }));
        }
      },
    ),

    defineTool(
      'read_document',
      'Read the text content of a document (docx, xlsx, pptx, pdf). Returns the plain text extraction via officecli view text. Useful for AI to inspect existing verification plans, coverage reports, or regression summaries.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Document path (absolute or relative to project root). Supported formats: .docx, .xlsx, .pptx, .pdf.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async (args) => {
        const inputPath = typeof args.path === 'string' ? args.path : '';
        if (!inputPath) {
          return TEXT(JSON.stringify({ error: 'path is required' }));
        }
        const absPath = isAbsolute(inputPath) ? inputPath : resolve(ctx.cwd, inputPath);
        const format = extname(absPath).slice(1).toLowerCase();
        try {
          const result = await execOfficeCli({ args: ['view', absPath, 'text'] });
          if (result.exitCode !== 0) {
            return TEXT(JSON.stringify({ error: `read_document failed: ${result.stderr || result.stdout || `exit code ${result.exitCode}`}` }));
          }
          return TEXT(JSON.stringify({ path: absPath, content: result.stdout, format }));
        } catch (err) {
          return TEXT(JSON.stringify({ error: `read_document failed: ${err instanceof Error ? err.message : String(err)}` }));
        }
      },
    ),
  ];
}
