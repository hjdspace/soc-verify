/**
 * CSvConverter — C ↔ SystemVerilog code converter.
 *
 * Ported from the Python `c_to_sv_converter` plugin.
 * Features: select C/SV files, preview conversion, export output.
 */

import { useState, useCallback } from 'react';
import { FolderOpen, FileCode2, ArrowLeftRight, Download, Eye } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type FunctionInfo = {
  name: string;
  returnType: string;
  parameters: Array<{ name: string; dataType: string; isPointer: boolean; isConst: boolean; direction: string }>;
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

export function CSvConverter({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [direction, setDirection] = useState<'c-to-sv' | 'sv-to-c'>('c-to-sv');
  const [preserveComments, setPreserveComments] = useState(true);
  const [addAutomatic, setAddAutomatic] = useState(true);
  const [coreName, setCoreName] = useState('default_core');
  const [svCode, setSvCode] = useState('');
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [converting, setConverting] = useState(false);
  const [status, setStatus] = useState('请选择 C 文件');

  const handleBrowse = useCallback(async () => {
    const res = await trpc.tools.selectFiles.mutate({
      title: '选择 C 文件',
      filters: [{ name: 'C 文件', extensions: ['c', 'h'] }],
      defaultPath: projectRoot ?? undefined,
    });
    if (res.paths.length > 0) {
      setFilePaths(res.paths);
      setStatus(`已选择 ${res.paths.length} 个文件`);
    }
  }, [projectRoot]);

  const handlePreview = useCallback(async () => {
    if (filePaths.length === 0) {
      setStatus('请先选择文件');
      return;
    }

    setConverting(true);
    setStatus('正在转换...');
    setSvCode('');
    setParseResult(null);

    try {
      const res = await trpc.tools.cSvConverter.preview.mutate({
        filePaths,
        config: {
          preserveComments,
          addAutomatic,
          coreNameDefault: coreName,
        },
      });
      setSvCode((res as { svCode: string }).svCode);
      setParseResult((res as { parseResult: ParseResult }).parseResult);
      const pr = (res as { parseResult: ParseResult }).parseResult;
      setStatus(`转换完成: ${pr.functions.length} 个函数, ${pr.structs.length} 个结构体, ${pr.macros.length} 个宏, ${pr.enums.length} 个枚举`);
    } catch (err) {
      setStatus(`转换失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConverting(false);
    }
  }, [filePaths, preserveComments, addAutomatic, coreName]);

  const handleExport = useCallback(async () => {
    if (!svCode) return;

    const res = await trpc.tools.saveFileDialog.mutate({
      title: '保存 SV 文件',
      defaultPath: 'output_task_lib.sv',
      filters: [{ name: 'SystemVerilog', extensions: ['sv'] }],
    });

    if (res.path) {
      await trpc.tools.cSvConverter.export.mutate({ content: svCode, savePath: res.path });
      setStatus(`已导出到 ${res.path}`);
    }
  }, [svCode]);

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
            placeholder="请选择 C 源文件 (.c / .h)"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
          />
          <button
            onClick={handleBrowse}
            className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent whitespace-nowrap"
          >
            <FolderOpen className="h-3 w-3" />
            浏览
          </button>
        </div>

        {/* Options */}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">转换方向</label>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'c-to-sv' | 'sv-to-c')}
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
        </div>
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
        {svCode && (
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 rounded border border-border px-4 py-1.5 text-xs font-medium hover:bg-accent"
          >
            <Download className="h-3 w-3" />
            导出 SV
          </button>
        )}
      </div>

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {/* ── Parse result summary ── */}
      {parseResult && (
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

      {/* ── Function list + SV code preview ── */}
      {svCode && (
        <div className="flex min-h-0 flex-1 gap-2">
          {/* Function list */}
          {parseResult && parseResult.functions.length > 0 && (
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

          {/* SV code */}
          <div className="flex min-w-0 flex-1 flex-col rounded border border-border">
            <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
              SystemVerilog 代码
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-zinc-900 p-2">
              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-300">
                {svCode}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
