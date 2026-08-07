/**
 * CSvConverter — C ↔ SystemVerilog code converter.
 *
 * Ported from the Python `c_to_sv_converter` plugin (main_window.py + preview_dialog.py).
 * Features:
 *   - Bidirectional conversion: C→SV and SV→C
 *   - Side-by-side comparison view (input left, output right)
 *   - Diff comparison view (line-by-line differences)
 *   - Batch conversion mode (multiple drivers → separate files)
 *   - Directory selection for input files
 *   - Custom type mapping editor
 *   - Conversion report export (TXT / HTML)
 *   - Parse result summary (functions, structs, macros, enums)
 */

import { useState, useCallback, useMemo } from 'react';
import { FolderOpen, FileCode2, Download, Eye, Columns2, GitCompare, Folder, Settings, FileText } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type FunctionParameter = {
  name: string;
  dataType: string;
  isPointer: boolean;
  isConst: boolean;
  direction: string;
};

type FunctionInfo = {
  name: string;
  returnType: string;
  parameters: FunctionParameter[];
  body: string;
  comments: string[];
  isStatic: boolean;
  mustBeTask?: boolean;
};

type ParseResult = {
  functions: FunctionInfo[];
  structs: Array<{ name: string; fields: Array<{ type: string; name: string }>; comments: string[] }>;
  macros: Array<{ name: string; value: string; comments: string[] }>;
  enums: Array<{ name: string; values: Array<{ name: string; value: string }>; comments: string[] }>;
};

type SvParseResult = {
  tasks: FunctionInfo[];
  macros: Array<{ name: string; value: string; comments: string[] }>;
};

type ConversionResult = {
  success: boolean;
  outputFile: string;
  functionsConverted: number;
  message: string;
  errors: string[];
  warnings: string[];
};

/** Generate a simple line-by-line diff HTML. */
function generateDiffHtml(inputCode: string, outputCode: string): string {
  const inputLines = inputCode.split('\n');
  const outputLines = outputCode.split('\n');
  const maxLines = Math.max(inputLines.length, outputLines.length);

  const rows: string[] = [];
  for (let i = 0; i < maxLines; i++) {
    const inLine = inputLines[i] ?? '';
    const outLine = outputLines[i] ?? '';
    const isAdd = !inLine && outLine;
    const isDel = inLine && !outLine;
    const isChg = inLine && outLine && inLine !== outLine;
    const cls = isAdd ? 'diff-add' : isDel ? 'diff-del' : isChg ? 'diff-chg' : '';
    rows.push(
      `<tr class="${cls}">` +
      `<td class="line-num">${i + 1}</td>` +
      `<td class="line-content">${escapeHtml(inLine) || '&nbsp;'}</td>` +
      `<td class="line-num">${i + 1}</td>` +
      `<td class="line-content">${escapeHtml(outLine) || '&nbsp;'}</td>` +
      `</tr>`
    );
  }

  return `<table class="diff-table">${rows.join('')}</table>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function CSvConverter({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [direction, setDirection] = useState<'c-to-sv' | 'sv-to-c'>('c-to-sv');
  const [preserveComments, setPreserveComments] = useState(true);
  const [addAutomatic, setAddAutomatic] = useState(true);
  const [coreName, setCoreName] = useState('AON');
  const [outputCode, setOutputCode] = useState('');
  const [inputContent, setInputContent] = useState('');
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [svParseResult, setSvParseResult] = useState<SvParseResult | null>(null);
  const [converting, setConverting] = useState(false);
  const [status, setStatus] = useState('请选择文件');
  const [viewMode, setViewMode] = useState<'output' | 'side-by-side' | 'diff'>('output');
  const [showTypeMapping, setShowTypeMapping] = useState(false);
  const [customTypeMappings, setCustomTypeMappings] = useState<Record<string, string>>({});
  const [defaultTypeMappings, setDefaultTypeMappings] = useState<Record<string, string>>({});

  // Load default type mappings on mount
  useMemo(() => {
    trpc.tools.cSvConverter.getDefaultTypeMappings.query().then((res) => {
      setDefaultTypeMappings(res.typeMappings as Record<string, string>);
    }).catch(() => {
      // ignore
    });
  }, []);

  const handleBrowse = useCallback(async () => {
    const fileExtensions = direction === 'c-to-sv'
      ? [{ name: 'C 文件', extensions: ['c', 'h'] }]
      : [{ name: 'SystemVerilog 文件', extensions: ['sv', 'svh'] }];
    const res = await trpc.tools.selectFiles.mutate({
      title: direction === 'c-to-sv' ? '选择 C 文件' : '选择 SV 文件',
      filters: fileExtensions,
      defaultPath: projectRoot ?? undefined,
    });
    if (res.paths.length > 0) {
      // Merge with existing files, avoiding duplicates
      setFilePaths((prev) => {
        const existing = new Set(prev);
        const newPaths = res.paths.filter((p) => !existing.has(p));
        return [...prev, ...newPaths];
      });
      setStatus(`已添加 ${res.paths.length} 个文件`);
    }
  }, [projectRoot, direction]);

  const handleAddDirectory = useCallback(async () => {
    const res = await trpc.tools.selectDirectory.mutate({
      title: '选择输入目录',
      defaultPath: projectRoot ?? undefined,
    });
    if (res.path) {
      const extensions = direction === 'c-to-sv' ? ['.c', '.h'] : ['.sv', '.svh'];
      const scanRes = await trpc.tools.cSvConverter.scanDirectory.mutate({
        directory: res.path,
        extensions,
      });
      if (scanRes.files.length > 0) {
        // Merge with existing files, avoiding duplicates
        setFilePaths((prev) => {
          const existing = new Set(prev);
          const newPaths = scanRes.files.filter((p) => !existing.has(p));
          return [...prev, ...newPaths];
        });
        setStatus(`从目录添加了 ${scanRes.files.length} 个文件`);
      } else {
        setStatus(`目录中没有找到匹配的文件`);
      }
    }
  }, [projectRoot, direction]);

  const handleRemoveFile = useCallback((index: number) => {
    setFilePaths((prev) => prev.filter((_, i) => i !== index));
    setStatus(`已移除 1 个文件`);
  }, []);

  const handleClearFiles = useCallback(() => {
    setFilePaths([]);
    setStatus('已清空文件列表');
  }, []);

  const handlePreview = useCallback(async () => {
    if (filePaths.length === 0) {
      setStatus('请先选择文件');
      return;
    }

    setConverting(true);
    setStatus('正在转换...');
    setOutputCode('');
    setParseResult(null);
    setSvParseResult(null);
    setInputContent('');

    try {
      const config = {
        preserveComments,
        addAutomatic,
        coreNameDefault: coreName,
        typeMappings: customTypeMappings,
      };

      if (direction === 'c-to-sv') {
        const res = await trpc.tools.cSvConverter.preview.mutate({
          filePaths,
          config,
        });
        const data = res as { svCode: string; parseResult: ParseResult; inputContent: string };
        setOutputCode(data.svCode);
        setParseResult(data.parseResult);
        setInputContent(data.inputContent || '');
        const pr = data.parseResult;
        setStatus(`转换完成: ${pr.functions.length} 个函数, ${pr.structs.length} 个结构体, ${pr.macros.length} 个宏, ${pr.enums.length} 个枚举`);
      } else {
        const res = await trpc.tools.cSvConverter.previewSvToC.mutate({
          filePaths,
          config,
        });
        const data = res as { cCode: string; svParseResult: SvParseResult; inputContent: string };
        setOutputCode(data.cCode);
        setSvParseResult(data.svParseResult);
        setInputContent(data.inputContent || '');
        const sr = data.svParseResult;
        setStatus(`转换完成: ${sr.tasks.length} 个 task, ${sr.macros.length} 个宏`);
      }
    } catch (err) {
      setStatus(`转换失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConverting(false);
    }
  }, [filePaths, direction, preserveComments, addAutomatic, coreName, customTypeMappings]);

  const handleExport = useCallback(async () => {
    if (!outputCode) return;

    const isSv = direction === 'c-to-sv';
    const res = await trpc.tools.saveFileDialog.mutate({
      title: isSv ? '保存 SV 文件' : '保存 C 文件',
      defaultPath: isSv ? 'output_task_lib.sv' : 'output.c',
      filters: isSv
        ? [{ name: 'SystemVerilog', extensions: ['sv'] }]
        : [{ name: 'C Source', extensions: ['c'] }],
    });

    if (res.path) {
      await trpc.tools.cSvConverter.export.mutate({ content: outputCode, savePath: res.path });
      setStatus(`已导出到 ${res.path}`);
    }
  }, [outputCode, direction]);

  const handleConvert = useCallback(async () => {
    if (filePaths.length === 0) {
      setStatus('请先选择文件');
      return;
    }

    const dirRes = await trpc.tools.selectDirectory.mutate({
      title: '选择输出目录',
      defaultPath: projectRoot ?? undefined,
    });

    if (!dirRes.path) return;

    setConverting(true);
    setStatus('正在转换并写入文件...');

    try {
      const res = await trpc.tools.cSvConverter.convert.mutate({
        inputFiles: filePaths,
        outputPath: dirRes.path,
        direction,
        preserveComments,
        addAutomatic,
        coreNameDefault: coreName,
        typeMappings: customTypeMappings,
      });

      const result = res as ConversionResult;
      if (result.success) {
        setStatus(`✓ ${result.message}`);
      } else {
        setStatus(`✗ ${result.message}`);
      }
    } catch (err) {
      setStatus(`转换失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConverting(false);
    }
  }, [filePaths, direction, preserveComments, addAutomatic, coreName, customTypeMappings, projectRoot]);

  const handleExportReport = useCallback(async () => {
    const res = await trpc.tools.saveFileDialog.mutate({
      title: '保存转换报告',
      defaultPath: `conversion_report_${new Date().toISOString().slice(0, 10)}.html`,
      filters: [
        { name: 'HTML 报告', extensions: ['html'] },
        { name: '文本报告', extensions: ['txt'] },
      ],
    });

    if (res.path) {
      const isHtml = res.path.endsWith('.html');
      const funcCount = parseResult?.functions.length ?? svParseResult?.tasks.length ?? 0;
      const reportContent = isHtml
        ? generateHtmlReport(direction, filePaths, funcCount, outputCode)
        : generateTxtReport(direction, filePaths, funcCount, outputCode);

      await trpc.tools.cSvConverter.export.mutate({ content: reportContent, savePath: res.path });
      setStatus(`报告已导出到 ${res.path}`);
    }
  }, [direction, filePaths, parseResult, svParseResult, outputCode]);

  const allTypeMappings = useMemo(() => ({
    ...defaultTypeMappings,
    ...customTypeMappings,
  }), [defaultTypeMappings, customTypeMappings]);

  const hasOutput = outputCode.length > 0;
  const hasInput = inputContent.length > 0;

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── File selection ── */}
      <div className="rounded border border-border p-3">
        <div className="flex items-center gap-1">
          <FileCode2 className="h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={filePaths.join('; ')}
            readOnly
            placeholder={direction === 'c-to-sv' ? '请选择 C 源文件 (.c / .h)' : '请选择 SV 文件 (.sv / .svh)'}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
          />
          <button
            onClick={handleBrowse}
            className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent whitespace-nowrap"
          >
            <FolderOpen className="h-3 w-3" />
            添加文件
          </button>
          <button
            onClick={handleAddDirectory}
            className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent whitespace-nowrap"
          >
            <Folder className="h-3 w-3" />
            添加目录
          </button>
          {filePaths.length > 0 && (
            <button
              onClick={handleClearFiles}
              className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent whitespace-nowrap text-destructive"
            >
              清空
            </button>
          )}
        </div>

        {/* File list */}
        {filePaths.length > 0 && (
          <div className="mt-2 max-h-32 overflow-auto rounded border border-border/50">
            {filePaths.map((fp, i) => (
              <div key={`${fp}-${i}`} className="flex items-center gap-2 border-b border-border/30 px-2 py-0.5 text-xs last:border-b-0">
                <span className="truncate font-mono text-[11px]" title={fp}>{fp}</span>
                <button
                  onClick={() => handleRemoveFile(i)}
                  className="ml-auto text-destructive hover:underline text-[10px]"
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Options */}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">转换方向</label>
            <select
              value={direction}
              onChange={(e) => {
                setDirection(e.target.value as 'c-to-sv' | 'sv-to-c');
                setOutputCode('');
                setParseResult(null);
                setSvParseResult(null);
              }}
              className="rounded border border-border bg-background px-2 py-1.5 text-xs"
            >
              <option value="c-to-sv">C → SystemVerilog</option>
              <option value="sv-to-c">SystemVerilog → C</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">默认 core_name</label>
            <input
              type="text"
              value={coreName}
              onChange={(e) => setCoreName(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1.5 text-xs font-mono"
            />
          </div>
        </div>

        <div className="mt-2 flex items-center gap-4">
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={preserveComments}
              onChange={(e) => setPreserveComments(e.target.checked)}
              className="h-3 w-3"
            />
            保留注释
          </label>
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={addAutomatic}
              onChange={(e) => setAddAutomatic(e.target.checked)}
              className="h-3 w-3"
            />
            添加 automatic
          </label>
          <button
            onClick={() => setShowTypeMapping(!showTypeMapping)}
            className="flex items-center gap-1 text-xs text-primary hover:underline ml-auto"
          >
            <Settings className="h-3 w-3" />
            自定义类型映射
          </button>
        </div>

        {/* Type mapping editor */}
        {showTypeMapping && (
          <div className="mt-2 rounded border border-border bg-muted/20 p-2">
            <div className="text-xs font-medium mb-1">类型映射 (C → SV)</div>
            <div className="max-h-40 overflow-auto">
              {Object.entries(allTypeMappings).map(([cType, svType]) => (
                <div key={cType} className="flex items-center gap-2 py-0.5">
                  <span className="font-mono text-[11px] w-24">{cType}</span>
                  <span className="text-muted-foreground text-[11px]">→</span>
                  <input
                    type="text"
                    value={svType}
                    onChange={(e) => {
                      setCustomTypeMappings((prev) => ({ ...prev, [cType]: e.target.value }));
                    }}
                    className="flex-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px]"
                  />
                </div>
              ))}
            </div>
            <button
              onClick={() => setCustomTypeMappings({})}
              className="mt-1 text-[11px] text-destructive hover:underline"
            >
              重置为默认
            </button>
          </div>
        )}
      </div>

      {/* ── Buttons ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={handlePreview}
          disabled={converting || filePaths.length === 0}
          className="flex items-center gap-1.5 rounded bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Eye className={cn('h-3 w-3', converting && 'animate-pulse')} />
          {converting ? '转换中...' : '预览转换'}
        </button>
        <button
          onClick={handleConvert}
          disabled={converting || filePaths.length === 0}
          className="flex items-center gap-1.5 rounded border border-border px-4 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
        >
          <Folder className="h-3 w-3" />
          开始转换
        </button>
        {hasOutput && (
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 rounded border border-border px-4 py-1.5 text-xs font-medium hover:bg-accent"
          >
            <Download className="h-3 w-3" />
            导出文件
          </button>
        )}
        {hasOutput && (
          <button
            onClick={handleExportReport}
            className="flex items-center gap-1.5 rounded border border-border px-4 py-1.5 text-xs font-medium hover:bg-accent"
          >
            <FileText className="h-3 w-3" />
            导出报告
          </button>
        )}
      </div>

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {/* ── Parse result summary ── */}
      {parseResult && direction === 'c-to-sv' && (
        <div className="grid grid-cols-4 gap-2">
          <div className="rounded border border-border p-2 text-center">
            <div className="text-lg font-bold">{parseResult.functions.length}</div>
            <div className="text-[10px] text-muted-foreground">函数</div>
          </div>
          <div className="rounded border border-border p-2 text-center">
            <div className="text-lg font-bold">{parseResult.structs.length}</div>
            <div className="text-[10px] text-muted-foreground">结构体</div>
          </div>
          <div className="rounded border border-border p-2 text-center">
            <div className="text-lg font-bold">{parseResult.macros.length}</div>
            <div className="text-[10px] text-muted-foreground">宏定义</div>
          </div>
          <div className="rounded border border-border p-2 text-center">
            <div className="text-lg font-bold">{parseResult.enums.length}</div>
            <div className="text-[10px] text-muted-foreground">枚举</div>
          </div>
        </div>
      )}
      {svParseResult && direction === 'sv-to-c' && (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-border p-2 text-center">
            <div className="text-lg font-bold">{svParseResult.tasks.length}</div>
            <div className="text-[10px] text-muted-foreground">Task</div>
          </div>
          <div className="rounded border border-border p-2 text-center">
            <div className="text-lg font-bold">{svParseResult.macros.length}</div>
            <div className="text-[10px] text-muted-foreground">宏定义</div>
          </div>
        </div>
      )}

      {/* ── View mode tabs ── */}
      {hasOutput && (
        <div className="flex items-center gap-1 border-b border-border">
          <button
            onClick={() => setViewMode('output')}
            className={cn(
              'flex items-center gap-1 px-3 py-1 text-xs font-medium border-b-2',
              viewMode === 'output' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <FileCode2 className="h-3 w-3" />
            输出代码
          </button>
          {hasInput && (
            <>
              <button
                onClick={() => setViewMode('side-by-side')}
                className={cn(
                  'flex items-center gap-1 px-3 py-1 text-xs font-medium border-b-2',
                  viewMode === 'side-by-side' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <Columns2 className="h-3 w-3" />
                并排对比
              </button>
              <button
                onClick={() => setViewMode('diff')}
                className={cn(
                  'flex items-center gap-1 px-3 py-1 text-xs font-medium border-b-2',
                  viewMode === 'diff' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <GitCompare className="h-3 w-3" />
                差异对比
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Output views ── */}
      {hasOutput && viewMode === 'output' && (
        <div className="flex min-h-0 flex-1 gap-2">
          {/* Function list */}
          {parseResult && direction === 'c-to-sv' && parseResult.functions.length > 0 && (
            <div className="flex w-56 flex-col rounded border border-border">
              <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
                函数列表 ({parseResult.functions.length})
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {parseResult.functions.map((func, i) => (
                  <div key={i} className="border-b border-border/50 px-2 py-1 text-xs">
                    <div className="flex items-center gap-1">
                      {func.isStatic ? (
                        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">static</span>
                      ) : func.mustBeTask ? (
                        <span className="rounded bg-blue-500/10 px-1 text-[10px] text-blue-600 dark:text-blue-400">task</span>
                      ) : (
                        <span className="rounded bg-green-500/10 px-1 text-[10px] text-green-600 dark:text-green-400">func</span>
                      )}
                      <span className="font-mono truncate" title={func.name}>{func.name}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                      {func.returnType} ({func.parameters.length} params)
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Output code */}
          <div className="flex min-w-0 flex-1 flex-col rounded border border-border">
            <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
              {direction === 'c-to-sv' ? 'SystemVerilog 代码' : 'C 代码'}
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-zinc-900 p-2">
              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-300">
                {outputCode}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Side-by-side comparison */}
      {hasOutput && viewMode === 'side-by-side' && hasInput && (
        <div className="flex min-h-0 flex-1 gap-2">
          <div className="flex min-w-0 flex-1 flex-col rounded border border-border">
            <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
              输入代码（前100行）
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-zinc-900 p-2">
              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-300">
                {inputContent}
              </pre>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col rounded border border-border">
            <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
              输出代码预览
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-zinc-900 p-2">
              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-300">
                {outputCode}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Diff comparison */}
      {hasOutput && viewMode === 'diff' && hasInput && (
        <div className="flex min-h-0 flex-1 flex-col rounded border border-border">
          <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
            差异对比
          </div>
          <div
            className="min-h-0 flex-1 overflow-auto bg-zinc-900 p-2"
            dangerouslySetInnerHTML={{
              __html: `<style>
                .diff-table { width: 100%; border-collapse: collapse; font-family: monospace; font-size: 11px; }
                .diff-table td { padding: 1px 8px; vertical-align: top; white-space: pre-wrap; word-wrap: break-word; color: #d4d4d4; }
                .diff-table .line-num { text-align: right; color: #666; background: #1e1e1e; width: 40px; min-width: 40px; user-select: none; }
                .diff-add { background: rgba(40, 167, 69, 0.15); }
                .diff-add .line-content { color: #4ade80; }
                .diff-del { background: rgba(220, 53, 69, 0.15); }
                .diff-del .line-content { color: #f87171; }
                .diff-chg { background: rgba(255, 193, 7, 0.15); }
                .diff-chg .line-content { color: #fbbf24; }
              </style>
              ${generateDiffHtml(inputContent, outputCode)}`
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── Report generators ─────────────────────────────────────────────

function generateHtmlReport(
  direction: 'c-to-sv' | 'sv-to-c',
  inputFiles: string[],
  funcCount: number,
  outputCode: string,
): string {
  const dirLabel = direction === 'c-to-sv' ? 'C → SystemVerilog' : 'SystemVerilog → C';
  const now = new Date().toLocaleString('zh-CN');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>C/SV代码互转工具 - 转换报告</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background-color: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background-color: white; padding: 30px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
    h1 { color: #333; border-bottom: 3px solid #4CAF50; padding-bottom: 10px; }
    h2 { color: #555; border-bottom: 2px solid #ddd; padding-bottom: 8px; margin-top: 30px; }
    .info-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .info-table td { padding: 10px; border: 1px solid #ddd; }
    .info-table td:first-child { background-color: #f0f0f0; font-weight: bold; width: 200px; }
    .success { color: #4CAF50; font-weight: bold; }
    .file-list { background-color: #f9f9f9; padding: 15px; border-left: 4px solid #2196F3; margin: 10px 0; }
    ul { list-style-type: none; padding-left: 0; }
    li { padding: 5px 0; }
    li:before { content: "▸ "; color: #4CAF50; font-weight: bold; }
    .timestamp { color: #888; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="container">
    <h1>C/SV代码互转工具 - 转换报告</h1>
    <p class="timestamp">生成时间: ${now}</p>
    <h2>转换信息</h2>
    <table class="info-table">
      <tr><td>转换方向</td><td>${dirLabel}</td></tr>
      <tr><td>转换状态</td><td class="success">成功 ✓</td></tr>
      <tr><td>输入文件数</td><td>${inputFiles.length}</td></tr>
      <tr><td>转换函数数</td><td>${funcCount}</td></tr>
      <tr><td>输出代码行数</td><td>${outputCode.split('\\n').length}</td></tr>
    </table>
    <h2>输入文件列表</h2>
    <div class="file-list">
      <ul>
        ${inputFiles.map((f) => `<li>${f}</li>`).join('')}
      </ul>
    </div>
    <p style="text-align: center; color: #888; margin-top: 50px; border-top: 1px solid #ddd; padding-top: 20px;">
      C/SV代码互转工具 | 报告生成完成
    </p>
  </div>
</body>
</html>`;
}

function generateTxtReport(
  direction: 'c-to-sv' | 'sv-to-c',
  inputFiles: string[],
  funcCount: number,
  outputCode: string,
): string {
  const dirLabel = direction === 'c-to-sv' ? 'C → SV' : 'SV → C';
  const now = new Date().toLocaleString('zh-CN');
  const lines: string[] = [];

  lines.push('='.repeat(70));
  lines.push('C/SV代码互转工具 - 转换报告');
  lines.push('='.repeat(70));
  lines.push('');
  lines.push(`生成时间: ${now}`);
  lines.push(`转换方向: ${dirLabel}`);
  lines.push(`转换状态: 成功`);
  lines.push('');
  lines.push('-'.repeat(70));
  lines.push('转换统计');
  lines.push('-'.repeat(70));
  lines.push(`输入文件数: ${inputFiles.length}`);
  lines.push(`转换函数数: ${funcCount}`);
  lines.push(`输出代码行数: ${outputCode.split('\n').length}`);
  lines.push('');
  lines.push('-'.repeat(70));
  lines.push('输入文件列表');
  lines.push('-'.repeat(70));
  inputFiles.forEach((f, i) => {
    lines.push(`${i + 1}. ${f}`);
  });
  lines.push('');
  lines.push('='.repeat(70));
  lines.push('报告结束');
  lines.push('='.repeat(70));

  return lines.join('\n');
}
