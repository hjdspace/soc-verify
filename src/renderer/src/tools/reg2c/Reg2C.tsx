/**
 * Reg2C — Register table → C driver header file generator.
 *
 * Ported from the Python `reg2c` plugin.
 * Features: parse Excel, preview registers, generate C macros/struct/functions,
 * export as .h file.
 */

import { useState, useCallback } from 'react';
import { FolderOpen, FileCode2, Download, Eye } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type RegField = {
  bit: string;
  bitStart: number;
  bitEnd: number;
  bitWidth: number;
  name: string;
  rw: string;
  reset: string;
  desc: string;
};

type RegRegister = {
  offset: number;
  name: string;
  width: number;
  shortDesc: string;
  fields: RegField[];
};

type RegData = {
  moduleName: string;
  baseAddr: number;
  registers: RegRegister[];
};

type PreviewData = {
  macros: string;
  struct: string;
  functions: string;
};

export function Reg2C({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [filePath, setFilePath] = useState('');
  const [regData, setRegData] = useState<RegData | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [activeTab, setActiveTab] = useState<'macros' | 'struct' | 'functions'>('macros');
  const [parsing, setParsing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState('请选择 Excel 文件');

  const handleBrowse = useCallback(async () => {
    const res = await trpc.tools.selectFiles.mutate({
      title: '选择寄存器表格',
      filters: [{ name: 'Excel 文件', extensions: ['xlsx', 'xls'] }],
      defaultPath: projectRoot ?? undefined,
    });
    if (res.paths.length > 0) {
      setFilePath(res.paths[0]);
      await handleParse(res.paths[0]);
    }
  }, [projectRoot]);

  const handleParse = useCallback(async (path: string) => {
    if (!path) {
      setStatus('请先选择文件');
      return;
    }

    setParsing(true);
    setStatus('正在解析...');
    setRegData(null);
    setPreview(null);

    try {
      const res = await trpc.tools.reg2c.parse.mutate({ filePath: path });
      const data = res as unknown as RegData;
      setRegData(data);
      setStatus(`解析完成: 模块 ${data.moduleName}, ${data.registers.length} 个寄存器, ${data.registers.reduce((s, r) => s + r.fields.length, 0)} 个字段`);
    } catch (err) {
      setStatus(`解析失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setParsing(false);
    }
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!regData) return;

    setGenerating(true);
    setStatus('正在生成代码...');

    try {
      const res = await trpc.tools.reg2c.preview.query({ regData });
      setPreview(res as unknown as PreviewData);
      setStatus('代码生成完成');
    } catch (err) {
      setStatus(`生成失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(false);
    }
  }, [regData]);

  const handleExport = useCallback(async () => {
    if (!regData || !preview) return;

    const res = await trpc.tools.saveFileDialog.mutate({
      title: '保存 C 头文件',
      defaultPath: `${regData.moduleName}.h`,
      filters: [{ name: 'C 头文件', extensions: ['h'] }],
    });

    if (res.path) {
      const fullCode = [preview.macros, '', preview.struct, '', preview.functions].join('\n');
      await trpc.tools.reg2c.export.mutate({ content: fullCode, savePath: res.path });
      setStatus(`已导出到 ${res.path}`);
    }
  }, [regData, preview]);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── File selection ── */}
      <div className="rounded border border-border p-3">
        <div className="flex items-center gap-1">
          <FileCode2 className="h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            placeholder="请选择寄存器表格 Excel 文件"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
          />
          <button
            onClick={handleBrowse}
            className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent whitespace-nowrap"
          >
            <FolderOpen className="h-3 w-3" />
            浏览
          </button>
          <button
            onClick={() => handleParse(filePath)}
            disabled={parsing || !filePath}
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {parsing ? '解析中...' : '解析'}
          </button>
        </div>
      </div>

      {/* ── Buttons ── */}
      {regData && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleGenerate}
            disabled={generating || !regData}
            className="flex items-center gap-1.5 rounded border border-border px-4 py-1.5 text-xs font-medium hover:bg-accent"
          >
            <Eye className="h-3 w-3" />
            {generating ? '生成中...' : '生成代码'}
          </button>
          {preview && (
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 rounded bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground"
            >
              <Download className="h-3 w-3" />
              导出 .h 文件
            </button>
          )}
        </div>
      )}

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {/* ── Register preview table ── */}
      {regData && (
        <div className="rounded border border-border">
          <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
            {regData.moduleName} (基地址: 0x{regData.baseAddr.toString(16).toUpperCase()}) — {regData.registers.length} 个寄存器
          </div>
          <div className="max-h-48 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/50">
                <tr className="text-left">
                  <th className="px-2 py-1">偏移</th>
                  <th className="px-2 py-1">寄存器名</th>
                  <th className="px-2 py-1">位域</th>
                  <th className="px-2 py-1">字段名</th>
                  <th className="px-2 py-1 text-center">RW</th>
                  <th className="px-2 py-1">复位值</th>
                </tr>
              </thead>
              <tbody>
                {regData.registers.flatMap((reg) =>
                  reg.fields.length === 0
                    ? [<tr key={reg.name} className="border-b border-border/50"><td className="px-2 py-1 font-mono">0x{reg.offset.toString(16).toUpperCase()}</td><td className="px-2 py-1">{reg.name}</td><td colSpan={4} className="px-2 py-1 text-muted-foreground">无字段</td></tr>]
                    : reg.fields.map((field, fi) => (
                  <tr key={`${reg.name}-${fi}`} className="border-b border-border/50">
                    <td className="px-2 py-1 font-mono">{fi === 0 ? `0x${reg.offset.toString(16).toUpperCase()}` : ''}</td>
                    <td className="px-2 py-1">{fi === 0 ? reg.name : ''}</td>
                    <td className="px-2 py-1 font-mono">[{field.bit}]</td>
                    <td className="px-2 py-1">{field.name}</td>
                    <td className="px-2 py-1 text-center">{field.rw}</td>
                    <td className="px-2 py-1 font-mono">{field.reset}</td>
                  </tr>
                ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Code preview ── */}
      {preview && (
        <div className="flex min-h-0 flex-1 flex-col rounded border border-border">
          {/* Tabs */}
          <div className="flex border-b border-border">
            {(['macros', 'struct', 'functions'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'px-4 py-1.5 text-xs font-medium border-r border-border',
                  activeTab === tab ? 'bg-accent/50 text-foreground' : 'text-muted-foreground hover:bg-accent/20',
                )}
              >
                {tab === 'macros' ? '宏定义' : tab === 'struct' ? '结构体' : '函数'}
              </button>
            ))}
          </div>
          {/* Code content */}
          <div className="min-h-0 flex-1 overflow-auto bg-zinc-900 p-2">
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-300">
              {preview[activeTab]}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
