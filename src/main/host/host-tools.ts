import { readFile, readdir, mkdir, unlink } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { extname, isAbsolute, join, resolve, dirname } from 'node:path';
import type { AgentToolResult, RpcHostToolCallRequest, RpcHostToolDefinition } from './types';
import type { SubsysDiscovery, CaseStatus } from './discovery';
import { NoopDiscovery } from './discovery';
import type { PluginBackedSimulation, PluginBackedCoverage } from '../plugin-adapters';
import type { CoverageManager } from '../coverage/coverage-manager';
import type { CaseStatsService } from '../case/case-stats-service';
import type { CoverageMetric } from '@shared/types';
import { execOfficeCli, type OfficeCliExecOptions, type OfficeCliExecResult } from '../officecli/executor';
import { appendRows, updateCell, type CellValue } from '../document/xlsx-editor';
import { isEditing, requestFlush, notifyFileChanged } from '../document/editor-registry';

type HostToolHandler = (args: Record<string, unknown>) => Promise<AgentToolResult | string>;

interface HostToolEntry {
  definition: RpcHostToolDefinition;
  handler: HostToolHandler;
}

const TEXT = (text: string): AgentToolResult => ({ content: [{ type: 'text', text }] });

function defineTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: HostToolHandler,
): HostToolEntry {
  return {
    definition: { name, description, parameters },
    handler,
  };
}

/** 转义正则特殊字符，用于安全构造模块名匹配正则。 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 递归扫描目录下的 Verilog/SystemVerilog 源文件（.v/.sv/.svh）。
 * 限制深度并跳过隐藏目录与 node_modules，避免遍历过深。
 */
async function findRtlFiles(dir: string, maxDepth = 4): Promise<string[]> {
  const results: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        await walk(join(current, entry.name), depth + 1);
      } else if (entry.isFile() && /\.(sv|v|svh)$/.test(entry.name)) {
        results.push(join(current, entry.name));
      }
    }
  };
  await walk(dir, 0);
  return results;
}

// ─── 文档工具辅助函数 ─────────────────────────────────────

/** 解析文档输出路径。outputPath 可为完整文件路径、目录路径或 undefined（默认 <cwd>/docs/） */
function resolveDocumentOutputPath(outputPath: unknown, cwd: string, ext: string): string {
  const extName = `.${ext}`;
  if (typeof outputPath === 'string' && outputPath) {
    // 以扩展名结尾 → 视为完整文件路径
    if (outputPath.endsWith(extName)) {
      return isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath);
    }
    // 否则视为目录，生成时间戳文件名
    const dir = isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath);
    return join(dir, `document-${Date.now()}${extName}`);
  }
  // 默认：<cwd>/docs/document-<timestamp>.<ext>
  return join(cwd, 'docs', `document-${Date.now()}${extName}`);
}

/** 确保目录存在，递归创建 */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * 执行 officecli 命令并检查退出码，非 0 时抛出错误。
 *
 * execOfficeCli 本身只在超时或 spawn 错误时 reject，
 * 非零退出码也正常 resolve——调用方必须自行检查 exitCode。
 */
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
    // 第一个 sheet 重命名，后续 sheet 新增
    if (sheetIdx === 0) {
      ops.push({ command: 'set', path: '/Sheet1', props: { name: sheet.name } });
    } else {
      ops.push({ command: 'add', parent: '/', type: 'sheet', props: { name: sheet.name } });
    }
    const sheetPath = `/${sheet.name}`;
    // 填充单元格数据
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
    // 添加 slide（blank 布局）
    ops.push({ command: 'add', parent: '/', type: 'slide', props: { layout: 'blank', background: 'FFFFFF' } });
    // 添加标题 shape
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
    // 添加内容 shape
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

export class HostToolsRegistry {
  private tools = new Map<string, HostToolEntry>();
  private discovery: SubsysDiscovery;
  private simulation: PluginBackedSimulation | null = null;
  private coverage: PluginBackedCoverage | null = null;
  private coverageManager: CoverageManager | null = null;
  private caseStatsService: CaseStatsService | null = null;
  /** Working directory for resolving relative file paths in tools */
  cwd: string;

  constructor(discovery?: SubsysDiscovery, cwd?: string) {
    this.discovery = discovery ?? new NoopDiscovery();
    this.cwd = cwd ?? process.cwd();
    this.registerDefaults();
    // 条件注册上下文工具（ADR 0009 决策 6）——仅在传入 discovery 时注册，
    // 保持无参构造的默认工具数不变。
    if (discovery) {
      this.registerContextTools();
    }
  }

  setSimulationAdapter(sim: PluginBackedSimulation | null): void {
    this.simulation = sim;
  }

  setCoverageAdapter(cov: PluginBackedCoverage | null): void {
    this.coverage = cov;
  }

  /**
   * 注入 CoverageManager（ADR 0009 摘要优先策略）。
   * 设置后 get_coverage 返回摘要而非整个树，并注册 get_coverage_detail 工具。
   * 传 null 回退到旧的 coverage.parse() 行为并注销 get_coverage_detail。
   */
  setCoverageManager(mgr: CoverageManager | null): void {
    this.coverageManager = mgr;
    if (mgr) {
      this.registerGetCoverageDetail();
      this.registerCoverageAnalysisTools();
    } else {
      this.unregister('get_coverage_detail');
      this.unregister('get_coverage_uncovered');
      this.unregister('get_coverage_grade');
      this.unregister('get_coverage_csv');
    }
  }

  /**
   * 注入 CaseStatsService（用例聚合统计共享服务）。
   *
   * 设置后：
   * - 注册 get_case_stats 工具（单 sys 摘要：总数/按状态/按文件分组）
   * - 注册 get_project_overview 工具（全项目聚合，避免 N+1 调用）
   * - 改造 list_cases：status 实时 join 自 SimulationManager 历史
   *
   * 传 null 回退到旧的 discovery.listCases 行为（status 一律 pending）并注销两个新工具。
   */
  setCaseStatsService(service: CaseStatsService | null): void {
    this.caseStatsService = service;
    if (service) {
      this.registerCaseStatsTools();
    } else {
      this.unregister('get_case_stats');
      this.unregister('get_project_overview');
    }
  }

  private registerDefaults(): void {
    this.register(
      defineTool(
        'list_subsys',
        'List all subsystems in the current SoC verification project, with case count for each.',
        {
          type: 'object',
          properties: {
            filter: { type: 'string', description: 'Optional name filter pattern' },
          },
          additionalProperties: false,
        },
        async (args) => {
          const filter = typeof args.filter === 'string' ? args.filter : undefined;
          // 优先走 CaseStatsService（填充真实 caseCount）
          const subsys = this.caseStatsService
            ? await this.caseStatsService.listSubsysWithCaseCount(filter)
            : await this.discovery.listSubsys(filter);
          return TEXT(JSON.stringify(subsys));
        },
      ),
    );

    this.register(
      defineTool(
        'list_cases',
        'List verification cases for a subsystem. Case status is joined from the latest simulation run (pass/fail/running/pending). For aggregate counts (total / by-status / by-file), prefer get_case_stats which is token-efficient.',
        {
          type: 'object',
          properties: {
            subsys: { type: 'string', description: 'Subsystem name (required)' },
            status: {
              type: 'string',
              enum: ['pass', 'fail', 'running', 'pending', 'all'],
              description: 'Filter by case status',
            },
          },
          required: ['subsys'],
          additionalProperties: false,
        },
        async (args) => {
          const subsys = typeof args.subsys === 'string' ? args.subsys : undefined;
          if (!subsys) {
            return TEXT(JSON.stringify({ error: 'subsys is required. Use list_subsys to discover subsystem names, or get_project_overview for cross-subsystem aggregates.' }));
          }
          const status = typeof args.status === 'string' ? (args.status as CaseStatus) : undefined;
          // 优先走 CaseStatsService（status 实时 join 自 SimulationManager）
          let cases;
          if (this.caseStatsService) {
            cases = await this.caseStatsService.listCasesWithStatus(subsys);
          } else {
            cases = await this.discovery.listCases(subsys, status);
          }
          // 客户端 status 过滤（service 路径不支持服务端过滤，因为 status 是 join 后才有的）
          if (status && status !== 'all') {
            cases = cases.filter((c) => c.status === status);
          }
          return TEXT(JSON.stringify(cases));
        },
      ),
    );

    this.register(
      defineTool(
        'get_sim_options_schema',
        'Get the JSON schema for simulation run options supported by this project.',
        {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        async () => {
          const schema = await this.discovery.getSimOptionsSchema();
          return TEXT(JSON.stringify(schema));
        },
      ),
    );

    this.register(
      defineTool(
        'run_simulation',
        'Launch a simulation run with the specified options. Returns a run ID for tracking.',
        {
          type: 'object',
          properties: {
            testcase: { type: 'string', description: 'Testcase name to run' },
            subsys: { type: 'string', description: 'Target subsystem' },
            options: { type: 'object', description: 'Simulation options matching the schema', additionalProperties: true },
          },
          required: ['testcase'],
          additionalProperties: false,
        },
        async (args) => {
          if (!this.simulation?.hasRunner()) {
            return TEXT(JSON.stringify({ error: 'No simulation-runner plugin loaded. Cannot run simulations.' }));
          }
          try {
            const handle = await this.simulation.run({
              caseId: typeof args.testcase === 'string' ? args.testcase : '',
              caseName: typeof args.testcase === 'string' ? args.testcase : undefined,
              subsys: typeof args.subsys === 'string' ? args.subsys : '',
              options: typeof args.options === 'object' && args.options !== null ? args.options as Record<string, unknown> : undefined,
            });
            return TEXT(JSON.stringify({ runId: handle.runId, status: 'pending' }));
          } catch (err) {
            return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
      ),
    );

    this.register(
      defineTool(
        'get_run_status',
        'Get the status of a simulation run by its ID.',
        {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'Run ID returned by run_simulation' },
          },
          required: ['runId'],
          additionalProperties: false,
        },
        async (args) => {
          if (!this.simulation?.hasRunner()) {
            return TEXT(JSON.stringify({ error: 'No simulation-runner plugin loaded' }));
          }
          try {
            const runId = typeof args.runId === 'string' ? args.runId : '';
            const status = await this.simulation.getStatus(runId);
            return TEXT(JSON.stringify(status));
          } catch (err) {
            return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
      ),
    );

    this.register(
      defineTool(
        'get_compile_errors',
        'Retrieve compilation errors for a simulation run.',
        {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'Run ID returned by run_simulation' },
            subsys: { type: 'string', description: 'Subsystem name' },
            testcase: { type: 'string', description: 'Testcase name' },
          },
          additionalProperties: false,
        },
        async (args) => {
          if (!this.simulation?.hasRunner()) {
            return TEXT('[]');
          }
          try {
            const runId = typeof args.runId === 'string' ? args.runId : '';
            if (runId) {
              const errors = await this.simulation.getCompileErrors(runId);
              return TEXT(JSON.stringify(errors));
            }
            return TEXT('[]');
          } catch (err) {
            return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
      ),
    );

    this.register(
      defineTool(
        'get_coverage',
        'Get coverage summary for a coverage merge session. Returns top-level summary plus the worst-coverage modules (ADR 0009 summary-first strategy). Use get_coverage_detail to drill down into a specific module.',
        {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'Coverage Merge Session ID. If omitted, the most recent session is used.',
            },
            worstN: {
              type: 'number',
              description: 'Number of worst-coverage modules to return (default 5)',
            },
          },
          additionalProperties: false,
        },
        async (args) => {
          // 优先使用 CoverageManager 摘要策略（ADR 0009）
          if (this.coverageManager) {
            try {
              const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
              const worstN = typeof args.worstN === 'number' ? args.worstN : 5;
              const result = await this.coverageManager.getCoverageSummary(sessionId, worstN);
              return TEXT(JSON.stringify(result));
            } catch (err) {
              return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
          }
          // 回退：旧行为（直接调用插件 parse，返回完整树）
          if (!this.coverage?.hasParser()) {
            return TEXT(JSON.stringify({ error: 'No coverage-parser plugin loaded' }));
          }
          try {
            const sessionId = typeof args.sessionId === 'string' ? args.sessionId : 'latest';
            const reportDir = typeof args.reportDir === 'string' ? args.reportDir : '';
            const data = await this.coverage.parse(sessionId, reportDir);
            return TEXT(JSON.stringify(data));
          } catch (err) {
            return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
      ),
    );

    this.register(
      defineTool(
        'read_file',
        'Read the content of a file. The path is resolved relative to the project root.',
        {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or relative to project root)' },
            maxLines: { type: 'number', description: 'Maximum number of lines to read (default 500)' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        async (args) => {
          try {
            const inputPath = typeof args.path === 'string' ? args.path : '';
            if (!inputPath) return TEXT('Error: path is required');

            const maxLines = typeof args.maxLines === 'number' ? args.maxLines : 500;
            const resolvedPath = isAbsolute(inputPath) ? inputPath : resolve(this.cwd, inputPath);

            const content = await readFile(resolvedPath, 'utf-8');
            const lines = content.split('\n');
            const truncated = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
            const result = truncated.join('\n');
            const suffix = lines.length > maxLines ? `\n... (${lines.length - maxLines} more lines)` : '';
            return TEXT(result + suffix);
          } catch (err) {
            return TEXT(`Error reading file: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),
    );

    // ─── 文档创建/读取工具（Issue #6） ─────────────────────

    this.register(
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
          const outputPath = resolveDocumentOutputPath(args.outputPath, this.cwd, 'docx');
          try {
            await ensureDir(dirname(outputPath));
            // Step 1: 创建空白 docx
            await execChecked({ args: ['create', outputPath] });
            // Step 2: 应用 batch 操作（Markdown → 段落/标题/列表）
            const ops = parseMarkdownToDocxBatchOps(content);
            await execChecked({ args: ['batch', outputPath], input: JSON.stringify(ops) });
            return TEXT(JSON.stringify({ path: outputPath, format: 'docx' }));
          } catch (err) {
            return TEXT(JSON.stringify({ error: `create_docx failed: ${err instanceof Error ? err.message : String(err)}` }));
          }
        },
      ),
    );

    this.register(
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
          const outputPath = resolveDocumentOutputPath(args.outputPath, this.cwd, 'xlsx');
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
    );

    this.register(
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
          const outputPath = resolveDocumentOutputPath(args.outputPath, this.cwd, 'pptx');
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
    );

    this.register(
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
          const pdfPath = resolveDocumentOutputPath(args.outputPath, this.cwd, 'pdf');
          // 中间产物 docx 路径（与 pdf 同目录、同名，扩展名替换为 .docx）
          const docxPath = pdfPath.replace(/\.pdf$/i, '.docx');
          try {
            await ensureDir(dirname(pdfPath));
            // Step 1: 创建中间 docx 并填充 Markdown 内容
            await execChecked({ args: ['create', docxPath] });
            const ops = parseMarkdownToDocxBatchOps(content);
            await execChecked({ args: ['batch', docxPath], input: JSON.stringify(ops) });
            // Step 2: 导出 docx 为 PDF
            await execChecked({ args: ['view', docxPath, 'pdf', '-o', pdfPath] });
            // Step 3: 清理中间 docx（best-effort，失败忽略）
            try { await unlink(docxPath); } catch { /* 中间文件清理失败不影响主流程 */ }
            return TEXT(JSON.stringify({ path: pdfPath, format: 'pdf' }));
          } catch (err) {
            return TEXT(JSON.stringify({ error: `create_pdf failed: ${err instanceof Error ? err.message : String(err)}` }));
          }
        },
      ),
    );

    this.register(
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
          const absPath = isAbsolute(inputPath) ? inputPath : resolve(this.cwd, inputPath);
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
    );

    // ─── xlsx 细粒度编辑工具（Issue #7） ─────────────────

    this.register(
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
          const absPath = isAbsolute(inputPath) ? inputPath : resolve(this.cwd, inputPath);
          try {
            // 若文件正在前端编辑，先 flush 前端未保存的修改
            if (isEditing(absPath)) {
              await requestFlush(absPath);
            }
            const result = await appendRows(absPath, sheet, rows);
            // 通知前端重载文件
            notifyFileChanged(absPath);
            return TEXT(JSON.stringify(result));
          } catch (err) {
            return TEXT(JSON.stringify({ error: `append_xlsx_row failed: ${err instanceof Error ? err.message : String(err)}` }));
          }
        },
      ),
    );

    this.register(
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
          const absPath = isAbsolute(inputPath) ? inputPath : resolve(this.cwd, inputPath);
          try {
            // 若文件正在前端编辑，先 flush 前端未保存的修改
            if (isEditing(absPath)) {
              await requestFlush(absPath);
            }
            const result = await updateCell(absPath, sheet, row, col, value);
            // 通知前端重载文件
            notifyFileChanged(absPath);
            return TEXT(JSON.stringify(result));
          } catch (err) {
            return TEXT(JSON.stringify({ error: `update_xlsx_cell failed: ${err instanceof Error ? err.message : String(err)}` }));
          }
        },
      ),
    );
  }

  /**
   * 注册 get_coverage_detail 工具（ADR 0009 按需下钻）。
   * 仅在 CoverageManager 可用时注册。
   */
  private registerGetCoverageDetail(): void {
    if (this.hasTool('get_coverage_detail')) return;
    this.register(
      defineTool(
        'get_coverage_detail',
        'Get detailed coverage for a specific module and its direct children (ADR 0009 drill-down). Use after get_coverage to inspect a specific low-coverage module.',
        {
          type: 'object',
          properties: {
            module: { type: 'string', description: 'Module path (e.g. "top/cpu_core")' },
            sessionId: {
              type: 'string',
              description: 'Coverage Merge Session ID. If omitted, the most recent session is used.',
            },
          },
          required: ['module'],
          additionalProperties: false,
        },
        async (args) => {
          if (!this.coverageManager) {
            return TEXT(JSON.stringify({ error: 'Coverage manager not available' }));
          }
          try {
            const modulePath = typeof args.module === 'string' ? args.module : '';
            const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
            const result = await this.coverageManager.getCoverageDetail(modulePath, sessionId);
            return TEXT(JSON.stringify(result));
          } catch (err) {
            return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
      ),
    );
  }

  /**
   * 注册覆盖率深度分析工具（urg -grade / imc report -bins / CSV）。
   * 仅在 CoverageManager 可用时注册。
   *
   * 新增工具：
   * - get_coverage_uncovered: 返回未覆盖项列表（来自 bins 报告或 detail 报告）
   * - get_coverage_grade: 返回测试用例贡献度排名
   * - get_coverage_csv: 返回 CSV 原始覆盖率数据（urg -format csv）
   */
  private registerCoverageAnalysisTools(): void {
    // 未覆盖项查询
    if (!this.hasTool('get_coverage_uncovered')) {
      this.register(
        defineTool(
          'get_coverage_uncovered',
          'Get uncovered coverage items (bins, lines, branches) for a coverage session. Returns a list of uncovered items with module/signal/file info. Useful for AI to identify what needs to be tested to close coverage gaps.',
          {
            type: 'object',
            properties: {
              metric: {
                type: 'string',
                enum: ['line', 'branch', 'toggle', 'condition', 'fsm_state', 'fsm_transition', 'functional', 'assertion'],
                description: 'Filter by coverage metric type. If omitted, returns all uncovered items.',
              },
              sessionId: {
                type: 'string',
                description: 'Coverage Merge Session ID. If omitted, the most recent session is used.',
              },
            },
            additionalProperties: false,
          },
          async (args) => {
            if (!this.coverageManager) {
              return TEXT(JSON.stringify({ error: 'Coverage manager not available' }));
            }
            try {
              const metric = typeof args.metric === 'string' ? (args.metric as CoverageMetric) : undefined;
              const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
              const result = await this.coverageManager.getCoverageUncovered(sessionId, metric);
              return TEXT(JSON.stringify(result));
            } catch (err) {
              return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
          },
        ),
      );
    }

    // 测试用例贡献度排名
    if (!this.hasTool('get_coverage_grade')) {
      this.register(
        defineTool(
          'get_coverage_grade',
          'Get test case coverage contribution ranking. Returns a list of test cases with their coverage scores and ranks. Useful for AI to identify which tests contribute most to coverage and which tests are redundant. Data source: urg -grade testfile (VCS) or imc report -test (Cadence).',
          {
            type: 'object',
            properties: {
              sessionId: {
                type: 'string',
                description: 'Coverage Merge Session ID. If omitted, the most recent session is used.',
              },
            },
            additionalProperties: false,
          },
          async (args) => {
            if (!this.coverageManager) {
              return TEXT(JSON.stringify({ error: 'Coverage manager not available' }));
            }
            try {
              const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
              const result = await this.coverageManager.getTestContributions(sessionId);
              return TEXT(JSON.stringify(result));
            } catch (err) {
              return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
          },
        ),
      );
    }

    // CSV 原始覆盖率数据
    if (!this.hasTool('get_coverage_csv')) {
      this.register(
        defineTool(
          'get_coverage_csv',
          'Get raw CSV coverage data (from urg -format csv). Returns structured CSV text that can be parsed for detailed analysis. Only available when VCS urg is used as the EDA tool. Returns null if no CSV data was generated.',
          {
            type: 'object',
            properties: {
              sessionId: {
                type: 'string',
                description: 'Coverage Merge Session ID. If omitted, the most recent session is used.',
              },
            },
            additionalProperties: false,
          },
          async (args) => {
            if (!this.coverageManager) {
              return TEXT(JSON.stringify({ error: 'Coverage manager not available' }));
            }
            try {
              const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
              const result = await this.coverageManager.getCsvData(sessionId);
              return TEXT(JSON.stringify(result));
            } catch (err) {
              return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
          },
        ),
      );
    }
  }

  /**
   * 注册用例聚合统计工具（摘要优先策略）。
   *
   * - get_case_stats: 单个子系统的用例摘要（总数 / 按状态 / 按 filePath 分组）。
   *   每个 filePath = 一个「功能」/「种类」；rootCases 含子用例数。
   * - get_project_overview: 全项目聚合（所有子系统概览，避免 N+1 调用）。
   *
   * 仅在 CaseStatsService 可用时注册。
   */
  private registerCaseStatsTools(): void {
    if (!this.hasTool('get_case_stats')) {
      this.register(
        defineTool(
          'get_case_stats',
          'Get aggregate case statistics for a single subsystem. Returns total count, breakdown by status (pass/fail/running/pending), and breakdown by file (each file = a "feature" or "category" of cases). Use this to answer "how many cases", "how many pass/fail", "what kinds of cases" without dumping the full case list. Use list_cases to drill down into specific cases.',
          {
            type: 'object',
            properties: {
              subsys: { type: 'string', description: 'Subsystem name (required)' },
            },
            required: ['subsys'],
            additionalProperties: false,
          },
          async (args) => {
            if (!this.caseStatsService) {
              return TEXT(JSON.stringify({ error: 'Case stats service not available' }));
            }
            const subsys = typeof args.subsys === 'string' ? args.subsys : undefined;
            if (!subsys) {
              return TEXT(JSON.stringify({ error: 'subsys is required' }));
            }
            const stats = await this.caseStatsService.getCaseStats(subsys);
            return TEXT(JSON.stringify(stats));
          },
        ),
      );
    }

    if (!this.hasTool('get_project_overview')) {
      this.register(
        defineTool(
          'get_project_overview',
          'Get project-wide case overview in a single call (avoids N+1 list_subsys + list_cases). Returns total subsystem count, total case count, and per-subsystem breakdown (name, caseCount, byStatus). Use this to answer "how many cases in the whole project" or "which subsystem has the most cases".',
          {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          async () => {
            if (!this.caseStatsService) {
              return TEXT(JSON.stringify({ error: 'Case stats service not available' }));
            }
            const overview = await this.caseStatsService.getProjectOverview();
            return TEXT(JSON.stringify(overview));
          },
        ),
      );
    }
  }

  /**
   * 注册 AI 上下文工具（ADR 0009 决策 6）。
   * - get_module_source: 返回指定模块的 RTL 源码，供 AI 理解 gap 所在模块实现
   * - get_test_template: 返回现有测试结构，供 AI 照此生成风格一致的新测试
   * 两个工具均为基础实现，handler 内部对依赖做 null check。
   */
  private registerContextTools(): void {
    this.register(
      defineTool(
        'get_module_source',
        'Get RTL source code for a specific module. Returns file path and line range. Used by AI to understand module implementation for coverage gap analysis.',
        {
          type: 'object',
          properties: {
            module: { type: 'string', description: 'Module name or path (e.g. "top/cpu_core")' },
            maxLines: { type: 'number', description: 'Max lines to return (default 500)' },
          },
          required: ['module'],
          additionalProperties: false,
        },
        async (args) => {
          const moduleInput = typeof args.module === 'string' ? args.module : '';
          if (!moduleInput) {
            return TEXT(JSON.stringify({ error: 'module is required' }));
          }
          // module 可能是路径形式（如 "top/cpu_core"），取末段作为模块名
          const moduleName = moduleInput.split('/').pop() ?? moduleInput;
          const maxLines = typeof args.maxLines === 'number' ? args.maxLines : 500;
          try {
            const files = await findRtlFiles(this.cwd);
            const regex = new RegExp(`\\bmodule\\s+${escapeRegex(moduleName)}\\b`);
            for (const file of files) {
              const content = await readFile(file, 'utf-8');
              const match = content.match(regex);
              if (match && match.index !== undefined) {
                // 计算 module 声明所在行号（1-based）
                const lines = content.split('\n');
                let lineStart = 1;
                let consumed = 0;
                for (let i = 0; i < lines.length; i++) {
                  if (consumed + lines[i].length + 1 > match.index) {
                    lineStart = i + 1;
                    break;
                  }
                  consumed += lines[i].length + 1;
                }
                const sliced = lines.slice(lineStart - 1, lineStart - 1 + maxLines);
                return TEXT(JSON.stringify({
                  module: moduleName,
                  file,
                  lineStart,
                  lineEnd: lineStart + sliced.length - 1,
                  source: sliced.join('\n'),
                }));
              }
            }
            return TEXT(JSON.stringify({ error: `Module ${moduleName} not found in project sources` }));
          } catch (err) {
            return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
      ),
    );

    this.register(
      defineTool(
        'get_test_template',
        'Get the structure of an existing test case (testbench framework, virtual sequence pattern, env config). AI uses this as a template to generate new tests with consistent style.',
        {
          type: 'object',
          properties: {
            testcase: { type: 'string', description: 'Existing testcase name to use as template' },
            subsys: { type: 'string', description: 'Subsystem name' },
          },
          required: ['testcase'],
          additionalProperties: false,
        },
        async (args) => {
          const testcase = typeof args.testcase === 'string' ? args.testcase : '';
          if (!testcase) {
            return TEXT(JSON.stringify({ error: 'testcase is required' }));
          }
          const subsys = typeof args.subsys === 'string' ? args.subsys : undefined;
          try {
            const cases = await this.discovery.listCases(subsys);
            const matched = cases.find((c) => c.name === testcase || c.id === testcase);
            if (!matched) {
              return TEXT(JSON.stringify({ error: `Testcase ${testcase} not found` }));
            }
            const filePath = matched.path;
            if (!filePath) {
              return TEXT(JSON.stringify({ error: `Testcase ${testcase} has no file path` }));
            }
            const resolvedPath = isAbsolute(filePath) ? filePath : resolve(this.cwd, filePath);
            const content = await readFile(resolvedPath, 'utf-8');
            return TEXT(JSON.stringify({
              testcase: matched.name,
              file: resolvedPath,
              content,
            }));
          } catch (err) {
            return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
      ),
    );
  }

  register(entry: HostToolEntry): void {
    this.tools.set(entry.definition.name, entry);
  }

  registerCustom(name: string, description: string, parameters: Record<string, unknown>, handler: HostToolHandler): void {
    this.register(defineTool(name, description, parameters, handler));
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  getDefinitions(): RpcHostToolDefinition[] {
    return Array.from(this.tools.values()).map((e) => e.definition);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async handleToolCall(request: RpcHostToolCallRequest): Promise<AgentToolResult | string> {
    const entry = this.tools.get(request.toolName);
    if (!entry) {
      return TEXT(`Host tool "${request.toolName}" is not registered`);
    }
    return entry.handler(request.arguments);
  }
}
