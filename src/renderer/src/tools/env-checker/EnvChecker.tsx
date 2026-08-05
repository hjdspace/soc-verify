/**
 * EnvChecker — verification environment force/wait statement checker.
 *
 * Ported from the Python `env_checker_one_touch` plugin.
 * Features: subsystem discovery, force/wait scanning, code preview,
 * confirmation marking, HTML report export.
 */

import { useState, useCallback, useEffect } from 'react';
import { FolderOpen, Play, Square, FileText, CheckCircle, PackageCheck, Download } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type FileResult = {
  path: string;
  count: number;
  lines: { line: number; statement: string }[];
};

type ScanResult = {
  force: FileResult[];
  wait: FileResult[];
};

type Tab = 'force' | 'wait';

export function EnvChecker({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [subsystems, setSubsystems] = useState<string[]>([]);
  const [selectedSubsys, setSelectedSubsys] = useState('');
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<ScanResult>({ force: [], wait: [] });
  const [activeTab, setActiveTab] = useState<Tab>('force');
  const [selectedFile, setSelectedFile] = useState<FileResult | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [status, setStatus] = useState('就绪');

  // Discover subsystems when project root changes
  useEffect(() => {
    if (!projectRoot) {
      setSubsystems([]);
      return;
    }
    trpc.tools.envChecker.discoverSubsystems
      .query({ projectRoot })
      .then((res) => {
        setSubsystems(res.subsystems);
        if (res.subsystems.length > 0 && !selectedSubsys) {
          setSelectedSubsys(res.subsystems[0]);
        }
      })
      .catch(() => setSubsystems([]));
  }, [projectRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectDirectory = useCallback(async () => {
    const result = await trpc.tools.selectDirectory.mutate({
      title: '选择项目根目录',
      defaultPath: projectRoot ?? undefined,
    });
    if (result.path) {
      onProjectRootChange(result.path);
    }
  }, [projectRoot, onProjectRootChange]);

  const handleScan = useCallback(async () => {
    if (!projectRoot || !selectedSubsys) return;
    setScanning(true);
    setStatus('扫描中...');
    setResults({ force: [], wait: [] });
    try {
      const res = await trpc.tools.envChecker.scan.mutate({
        projectRoot,
        subsys: selectedSubsys,
      });
      setResults(res);
      setStatus(`扫描完成：Force ${res.force.length} 个文件，Wait ${res.wait.length} 个文件`);
    } catch (err) {
      setStatus(`扫描失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScanning(false);
    }
  }, [projectRoot, selectedSubsys]);

  const handlePreview = useCallback((file: FileResult) => {
    setSelectedFile(file);
    const lines = file.lines.map((l) => `===== 行 ${l.line} =====\n${l.statement}`).join('\n\n');
    setPreviewContent(lines);
  }, []);

  const handleConfirm = useCallback(async (file: FileResult) => {
    const comment = window.prompt('请输入确认信息 (如: Confirmed by xxx):', '');
    if (comment === null) return;
    try {
      await trpc.tools.envChecker.confirm.mutate({
        filePath: file.path,
        checkType: activeTab,
        comment,
      });
      setStatus(`已标记 ${file.path}`);
    } catch (err) {
      setStatus(`标记失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeTab]);

  const handleBatchConfirm = useCallback(async () => {
    const comment = window.prompt('请输入确认信息 (如: Confirmed by xxx):', '');
    if (comment === null) return;
    const files = results[activeTab];
    for (const file of files) {
      try {
        await trpc.tools.envChecker.confirm.mutate({
          filePath: file.path,
          checkType: activeTab,
          comment,
        });
      } catch (err) {
        console.error(`Failed to confirm ${file.path}:`, err);
      }
    }
    setStatus(`批量标记完成: ${files.length} 个文件`);
  }, [results, activeTab]);

  const handleExport = useCallback(async () => {
    if (!selectedSubsys) return;
    const result = await trpc.tools.saveFileDialog.mutate({
      title: '保存检查报告',
      defaultPath: `${selectedSubsys}_report.html`,
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (!result.path) return;
    try {
      await trpc.tools.envChecker.exportReport.mutate({
        savePath: result.path,
        subsys: selectedSubsys,
        results,
      });
      setStatus(`报告已导出到 ${result.path}`);
    } catch (err) {
      setStatus(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [selectedSubsys, results]);

  const currentResults = results[activeTab];
  const forceCount = results.force.length;
  const waitCount = results.wait.length;

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* ── Header: project path + subsystem + actions ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">项目路径:</span>
          <span className="max-w-[300px] truncate text-xs font-medium">{projectRoot ?? '未设置'}</span>
          <button
            onClick={handleSelectDirectory}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            <FolderOpen className="h-3 w-3" /> 选择
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">子系统:</span>
          <select
            value={selectedSubsys}
            onChange={(e) => setSelectedSubsys(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          >
            {subsystems.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <button
          onClick={handleScan}
          disabled={scanning || !selectedSubsys}
          className="flex items-center gap-1 rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          {scanning ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          {scanning ? '扫描中' : '扫描'}
        </button>
      </div>

      {/* ── Tabs ── */}
      <div className="flex items-center gap-1 border-b border-border">
        <button
          onClick={() => setActiveTab('force')}
          className={cn(
            'border-b-2 px-4 py-1.5 text-xs font-medium transition-colors',
            activeTab === 'force'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          Force 语句 ({forceCount})
        </button>
        <button
          onClick={() => setActiveTab('wait')}
          className={cn(
            'border-b-2 px-4 py-1.5 text-xs font-medium transition-colors',
            activeTab === 'wait'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          Wait 语句 ({waitCount})
        </button>
      </div>

      {/* ── Main content: file list + preview ── */}
      <div className="flex min-h-0 flex-1 gap-3">
        {/* File list */}
        <div className="flex w-1/2 flex-col">
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs font-medium text-muted-foreground">文件列表</span>
            <div className="flex gap-2">
              <button
                onClick={handleBatchConfirm}
                disabled={currentResults.length === 0}
                className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
              >
                <PackageCheck className="h-3 w-3" /> 批量确认
              </button>
              <button
                onClick={handleExport}
                disabled={forceCount === 0 && waitCount === 0}
                className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
              >
                <Download className="h-3 w-3" /> 导出报告
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded border border-border">
            {currentResults.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {scanning ? '扫描中...' : '暂无数据'}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {currentResults.map((file) => (
                  <li
                    key={file.path}
                    onClick={() => handlePreview(file)}
                    className={cn(
                      'flex cursor-pointer items-center justify-between px-3 py-2 text-xs transition-colors hover:bg-accent',
                      selectedFile?.path === file.path && 'bg-accent',
                    )}
                  >
                    <span className="truncate" title={file.path}>{file.path}</span>
                    <span className="ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px]">
                      {file.count} 处
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Preview + actions */}
        <div className="flex w-1/2 flex-col">
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs font-medium text-muted-foreground">代码预览</span>
            {selectedFile && (
              <div className="flex gap-2">
                <button
                  onClick={() => handleConfirm(selectedFile)}
                  className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-accent"
                >
                  <CheckCircle className="h-3 w-3" /> 确认标记
                </button>
              </div>
            )}
          </div>
          <pre className="min-h-0 flex-1 overflow-auto rounded border border-border bg-muted/30 p-3 text-xs font-mono">
            {previewContent || '选择文件查看预览'}
          </pre>
        </div>
      </div>

      {/* ── Status bar ── */}
      <div className="flex items-center gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
        <FileText className="h-3 w-3" />
        <span>{status}</span>
      </div>
    </div>
  );
}
