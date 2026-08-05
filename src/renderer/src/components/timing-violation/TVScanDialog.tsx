/**
 * TVScanDialog — 回归扫描对话框
 *
 * 用户选择回归根目录，选择扫描模式（标准/通用），
 * 扫描结果显示分组列表，用户勾选文件后批量处理。
 */

import { useState, useMemo } from 'react';
import { X, FolderOpen, Loader2, ChevronDown, ChevronRight, CheckSquare, Square, Play } from 'lucide-react';
import { useTimingViolationStore, type RegressionFileInfo } from '@renderer/stores/timing-violation';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';

type ScanDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function TVScanDialog({ open, onClose }: ScanDialogProps) {
  const projectId = useProjectStore((s) => s.currentProjectId);

  const scanning = useTimingViolationStore((s) => s.scanning);
  const scanResult = useTimingViolationStore((s) => s.scanResult);
  const batchProcessing = useTimingViolationStore((s) => s.batchProcessing);
  const scanRegression = useTimingViolationStore((s) => s.scanRegression);
  const batchProcess = useTimingViolationStore((s) => s.batchProcess);
  const pickRegressionDir = useTimingViolationStore((s) => s.pickRegressionDir);

  const [regressionRoot, setRegressionRoot] = useState('');
  const [useStandard, setUseStandard] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  if (!open) return null;

  const handlePickDir = async () => {
    const dir = await pickRegressionDir();
    if (dir) setRegressionRoot(dir);
  };

  const handleScan = async () => {
    if (!projectId || !regressionRoot) return;
    setSelectedFiles(new Set());
    await scanRegression(projectId, regressionRoot, useStandard);
  };

  const handleBatchProcess = async () => {
    if (!projectId || selectedFiles.size === 0) return;
    const filePaths = Array.from(selectedFiles);
    await batchProcess(projectId, filePaths);
    onClose();
  };

  const toggleFile = (filePath: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const toggleGroup = (groupKey: string, files: RegressionFileInfo[]) => {
    const allSelected = files.every((f) => selectedFiles.has(f.filePath));
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const f of files) next.delete(f.filePath);
      } else {
        for (const f of files) next.add(f.filePath);
      }
      return next;
    });
  };

  const toggleExpand = (groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const subsysGroups = scanResult?.subsysGroups ?? {};
  const sortedSubsys = Object.keys(subsysGroups).sort();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[900px] flex-col rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">回归扫描</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 输入区 */}
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <button
            onClick={handlePickDir}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            选择目录
          </button>
          <input
            type="text"
            value={regressionRoot}
            onChange={(e) => setRegressionRoot(e.target.value)}
            placeholder="回归根目录路径..."
            className="flex-1 rounded-md border border-border bg-secondary/20 px-2 py-1.5 text-xs outline-none"
          />
          <select
            value={useStandard ? 'standard' : 'flexible'}
            onChange={(e) => setUseStandard(e.target.value === 'standard')}
            className="rounded-md border border-border bg-secondary/20 px-2 py-1.5 text-xs outline-none"
          >
            <option value="standard">标准模式</option>
            <option value="flexible">通用模式</option>
          </select>
          <button
            onClick={handleScan}
            disabled={!regressionRoot || scanning}
            className={cn(
              'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors',
              'hover:bg-accent hover:text-foreground',
              (!regressionRoot || scanning) && 'opacity-40 cursor-not-allowed',
            )}
          >
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            扫描
          </button>
        </div>

        {/* 结果区 */}
        <div className="flex-1 overflow-auto">
          {scanning ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              扫描中...
            </div>
          ) : !scanResult ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <p>选择回归目录并点击"扫描"</p>
              <p className="text-[11px]">标准模式: &lt;case&gt;_&lt;corner&gt;/&lt;case&gt;_&lt;seed&gt;/log/vio_summary.log</p>
              <p className="text-[11px]">通用模式: 任意/&lt;case&gt;_&lt;seed&gt;/log/vio_summary.log</p>
            </div>
          ) : scanResult.validFiles.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <p>未发现任何 vio_summary.log 文件</p>
              {scanResult.invalidPaths.length > 0 && (
                <p className="text-[11px]">{scanResult.invalidPaths.length} 个无效路径</p>
              )}
            </div>
          ) : (
            <div className="p-2">
              {/* 统计栏 */}
              <div className="mb-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                <span>共 {scanResult.totalFiles} 个文件</span>
                <span>有效 {scanResult.validFiles.length}</span>
                <span>耗时 {scanResult.scanTime.toFixed(2)}s</span>
                <span className="text-primary">已选 {selectedFiles.size}</span>
              </div>

              {/* 分组列表（按子系统） */}
              <div className="space-y-1">
                {sortedSubsys.map((subsys) => {
                  const files = subsysGroups[subsys];
                  const expanded = expandedGroups.has(subsys);
                  const allSelected = files.every((f) => selectedFiles.has(f.filePath));
                  const someSelected = files.some((f) => selectedFiles.has(f.filePath));

                  return (
                    <div key={subsys} className="rounded-md border border-border/30">
                      {/* 子系统行 */}
                      <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-accent/20">
                        <button onClick={() => toggleExpand(subsys)} className="p-0.5">
                          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        </button>
                        <button onClick={() => toggleGroup(subsys, files)} className="p-0.5">
                          {allSelected ? <CheckSquare className="h-3.5 w-3.5 text-primary" /> : <Square className="h-3.5 w-3.5 text-muted-foreground" />}
                        </button>
                        <span className="text-xs font-medium">{subsys}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {files.length} 个文件
                        </span>
                        {someSelected && !allSelected && (
                          <span className="text-[10px] text-primary">
                            ({files.filter((f) => selectedFiles.has(f.filePath)).length} 已选)
                          </span>
                        )}
                      </div>

                      {/* 文件列表 */}
                      {expanded && (
                        <div className="border-t border-border/20">
                          {/* 列标题栏 */}
                          <div className="flex items-center gap-2 px-6 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 border-b border-border/10">
                            <span className="w-3.5 shrink-0" />
                            <span className="flex-1 min-w-0">用例名</span>
                            <span className="w-24 shrink-0">Corner</span>
                            <span className="w-24 shrink-0">Seed</span>
                            <span className="w-14 shrink-0">状态</span>
                            <span className="w-20 shrink-0 text-right">大小</span>
                          </div>
                          {files.map((f) => (
                            <FileRow
                              key={f.filePath}
                              file={f}
                              selected={selectedFiles.has(f.filePath)}
                              onToggle={() => toggleFile(f.filePath)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        {scanResult && scanResult.validFiles.length > 0 && (
          <div className="flex items-center justify-between border-t px-4 py-3">
            <span className="text-[11px] text-muted-foreground">
              已选 {selectedFiles.size} / {scanResult.validFiles.length} 个文件
            </span>
            <button
              onClick={handleBatchProcess}
              disabled={selectedFiles.size === 0 || batchProcessing}
              className={cn(
                'flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-4 py-1.5 text-xs font-medium text-primary transition-colors',
                'hover:bg-primary/20',
                (selectedFiles.size === 0 || batchProcessing) && 'opacity-40 cursor-not-allowed',
              )}
            >
              {batchProcessing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              批量处理
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FileRow({
  file,
  selected,
  onToggle,
}: {
  file: RegressionFileInfo;
  selected: boolean;
  onToggle: () => void;
}) {
  const statusColor = file.caseStatus === 'PASS'
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400';

  const sizeStr = useMemo(() => {
    if (file.fileSize < 1024) return `${file.fileSize} B`;
    if (file.fileSize < 1024 * 1024) return `${(file.fileSize / 1024).toFixed(1)} KB`;
    return `${(file.fileSize / (1024 * 1024)).toFixed(1)} MB`;
  }, [file.fileSize]);

  return (
    <div
      className="flex items-center gap-2 px-6 py-1 text-xs hover:bg-accent/20 cursor-pointer"
      onClick={onToggle}
    >
      {selected ? <CheckSquare className="h-3 w-3 shrink-0 text-primary" /> : <Square className="h-3 w-3 shrink-0 text-muted-foreground" />}
      <span className="flex-1 min-w-0 truncate font-mono text-foreground">{file.caseName}</span>
      <span className="w-24 shrink-0 truncate text-muted-foreground">{file.cornerName}</span>
      <span className="w-24 shrink-0 truncate text-muted-foreground">seed:{file.seed}</span>
      <span className={cn('w-14 shrink-0 truncate font-medium', statusColor)}>{file.caseStatus}</span>
      <span className="w-20 shrink-0 text-right text-[10px] text-muted-foreground">{sizeStr}</span>
    </div>
  );
}
