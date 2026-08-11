/**
 * EnvChecker — verification environment force/wait statement checker.
 *
 * Ported from the Python `env_checker_one_touch` plugin.
 * Features: subsystem discovery from $PROJ_ENV, force/wait scanning,
 * code preview with context + syntax highlighting, gvim open,
 * confirmation marking, suspicious item marking, HTML report export.
 *
 * Layout: vertical split (file list on top, preview on bottom)
 * to ensure long file paths are always visible.
 */

import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react';
import {
  FolderOpen,
  Play,
  FileText,
  CheckCircle,
  PackageCheck,
  Download,
  ExternalLink,
  Flag,
  X,
} from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

// ── Types ──────────────────────────────────────────────────────────

type ScanMatch = { line: number; statement: string };

type FileResult = {
  path: string;
  count: number;
  lines: ScanMatch[];
};

type ScanResult = {
  force: FileResult[];
  wait: FileResult[];
};

type Tab = 'force' | 'wait';

type PreviewLine = {
  lineNo: number;
  content: string;
  isMatch: boolean;
};

type PreviewSection = {
  matchLine: number;
  lines: PreviewLine[];
};

type PreviewResult = {
  filePath: string;
  sections: PreviewSection[];
};

// ── Verilog syntax highlighting ────────────────────────────────────

const SV_KEYWORDS = new Set([
  'module', 'endmodule', 'begin', 'end', 'if', 'else', 'case', 'endcase',
  'casex', 'casez', 'always', 'assign', 'initial', 'wire', 'reg', 'logic',
  'input', 'output', 'inout', 'parameter', 'localparam', 'generate', 'endgenerate',
  'integer', 'real', 'time', 'function', 'endfunction', 'task', 'endtask',
  'for', 'while', 'repeat', 'forever', 'fork', 'join', 'join_any', 'join_none',
  'posedge', 'negedge', 'or', 'and', 'not', 'class', 'endclass', 'package',
  'endpackage', 'import', 'export', 'virtual', 'static', 'automatic',
  'typedef', 'struct', 'union', 'enum', 'return', 'break', 'continue',
  'force', 'wait', 'release', 'deassign', 'disable',
]);

const SV_TYPES = new Set([
  'bit', 'byte', 'shortint', 'int', 'longint', 'shortreal', 'string',
  'event', 'chandle', 'void',
]);

/** Tokenize a single line of Verilog/SystemVerilog and return highlighted React nodes. */
function highlightVerilog(line: string, isMatchLine: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < line.length) {
    // Line comment
    if (line[i] === '/' && line[i + 1] === '/') {
      nodes.push(
        <span key={key++} className="text-muted-foreground/60 italic">
          {line.slice(i)}
        </span>,
      );
      break;
    }

    // String literal
    if (line[i] === '"') {
      let end = i + 1;
      while (end < line.length && line[end] !== '"') {
        if (line[end] === '\\') end++;
        end++;
      }
      end++;
      nodes.push(
        <span key={key++} className="text-green-600 dark:text-green-400">
          {line.slice(i, end)}
        </span>,
      );
      i = end;
      continue;
    }

    // Number (including sized literals like 8'hFF, 'b1010)
    if (/[0-9']/.test(line[i]) && (i === 0 || /[\s;,:(]/.test(line[i - 1]))) {
      let end = i;
      // Check for sized literal: size 'base value
      const sizedMatch = line.slice(i).match(/^(\d+)\s*'[bdhBDH][0-9a-fA-FxXzZ_]+/);
      if (sizedMatch) {
        end = i + sizedMatch[0].length;
      } else {
        const numMatch = line.slice(i).match(/^[0-9][0-9a-fA-FxXzZ_]*h/);
        if (numMatch) {
          end = i + numMatch[0].length;
        } else {
          while (end < line.length && /[0-9a-fA-FxXzZ_]/.test(line[end])) end++;
        }
      }
      nodes.push(
        <span key={key++} className="text-orange-600 dark:text-orange-400">
          {line.slice(i, end)}
        </span>,
      );
      i = end;
      continue;
    }

    // Identifier / keyword
    if (/[a-zA-Z_]/.test(line[i])) {
      let end = i;
      while (end < line.length && /[a-zA-Z0-9_$]/.test(line[end])) end++;
      const word = line.slice(i, end);

      if (SV_KEYWORDS.has(word)) {
        nodes.push(
          <span
            key={key++}
            className={cn(
              'font-semibold',
              isMatchLine && (word === 'force' || word === 'wait')
                ? 'text-red-600 dark:text-red-400 underline'
                : 'text-blue-600 dark:text-blue-400',
            )}
          >
            {word}
          </span>,
        );
      } else if (SV_TYPES.has(word)) {
        nodes.push(
          <span key={key++} className="text-purple-600 dark:text-purple-400">
            {word}
          </span>,
        );
      } else if (/^\$/.test(word)) {
        // System task/function call like $display
        nodes.push(
          <span key={key++} className="text-cyan-600 dark:text-cyan-400">
            {word}
          </span>,
        );
      } else {
        nodes.push(<span key={key++}>{word}</span>);
      }
      i = end;
      continue;
    }

    // Operator or punctuation
    if (/[{}[\]();,]/.test(line[i])) {
      nodes.push(
        <span key={key++} className="text-muted-foreground">
          {line[i]}
        </span>,
      );
      i++;
      continue;
    }

    // Default: single character
    nodes.push(<span key={key++}>{line[i]}</span>);
    i++;
  }

  return nodes;
}

// ── Prompt dialog (replaces window.prompt which doesn't work in Electron) ──

function PromptDialog({
  title,
  label,
  defaultValue,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      onSubmit(value);
    },
    [value, onSubmit],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-96 rounded-lg border border-border bg-background p-4 shadow-xl"
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mb-3 w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            取消
          </button>
          <button
            type="submit"
            className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
          >
            确认
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────

export function EnvChecker({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [resolvedProjEnv, setResolvedProjEnv] = useState<string | null>(null);
  const [effectiveRoot, setEffectiveRoot] = useState<string | null>(projectRoot);
  const [subsystems, setSubsystems] = useState<string[]>([]);
  const [selectedSubsys, setSelectedSubsys] = useState('');
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<ScanResult>({ force: [], wait: [] });
  const [activeTab, setActiveTab] = useState<Tab>('force');
  const [selectedFile, setSelectedFile] = useState<FileResult | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [status, setStatus] = useState('就绪');

  // Track confirmed files and suspicious marks (per check type: force/wait)
  const [confirmedFiles, setConfirmedFiles] = useState<Set<string>>(new Set());
  const [suspiciousMarks, setSuspiciousMarks] = useState<{ force: Set<string>; wait: Set<string> }>({
    force: new Set(),
    wait: new Set(),
  });

  // Scan results cache: keyed by subsys name, allows switching between subsystems
  // without re-scanning every time.
  const [scanCache, setScanCache] = useState<Map<string, ScanResult>>(new Map());

  // Preview request race-condition guard: only the latest request updates UI.
  const previewRequestId = useRef(0);
  // Debounce timer for preview requests.
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist suspicious marks to the backend (fire-and-forget)
  const persistMarks = useCallback((marks: { force: Set<string>; wait: Set<string> }) => {
    trpc.tools.envChecker.saveSuspiciousMarks
      .mutate({
        marks: {
          force: [...marks.force],
          wait: [...marks.wait],
        },
      })
      .catch(() => {});
  }, []);

  // Load suspicious marks from the backend
  const loadMarks = useCallback(async () => {
    try {
      const res = await trpc.tools.envChecker.loadSuspiciousMarks.query();
      setSuspiciousMarks({
        force: new Set(res.force),
        wait: new Set(res.wait),
      });
    } catch {
      // ignore
    }
  }, []);

  // Prompt dialog state
  const [promptConfig, setPromptConfig] = useState<{
    title: string;
    label: string;
    onSubmit: (value: string) => void;
  } | null>(null);

  // Resolve $PROJ_ENV on mount — $PROJ_ENV takes priority over projectRoot prop
  // because this tool scans verification environments which live under $PROJ_ENV.
  // Fall back to projectRoot only when $PROJ_ENV is not available.
  useEffect(() => {
    trpc.tools.envChecker.resolveProjEnv
      .query({ projectDir: projectRoot ?? '' })
      .then((res) => {
        if (res.path) {
          setResolvedProjEnv(res.path);
          setEffectiveRoot(res.path);
        } else if (projectRoot) {
          setEffectiveRoot(projectRoot);
        }
      })
      .catch(() => {
        if (projectRoot) {
          setEffectiveRoot(projectRoot);
        }
      });
    // Load persisted suspicious marks
    loadMarks();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Discover subsystems when effective root changes
  useEffect(() => {
    if (!effectiveRoot) {
      setSubsystems([]);
      return;
    }
    trpc.tools.envChecker.discoverSubsystems
      .query({ projectRoot: effectiveRoot })
      .then((res) => {
        setSubsystems(res.subsystems);
        if (res.subsystems.length > 0 && !selectedSubsys) {
          setSelectedSubsys(res.subsystems[0]);
        }
      })
      .catch(() => setSubsystems([]));
  }, [effectiveRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayPath = effectiveRoot ?? resolvedProjEnv ?? projectRoot ?? '未设置';

  const handleSelectDirectory = useCallback(async () => {
    const result = await trpc.tools.selectDirectory.mutate({
      title: '选择项目根目录',
      defaultPath: effectiveRoot ?? undefined,
    });
    if (result.path) {
      setEffectiveRoot(result.path);
      onProjectRootChange(result.path);
      setSelectedSubsys('');
    }
  }, [effectiveRoot, onProjectRootChange]);

  const handleScan = useCallback(async () => {
    if (!effectiveRoot || !selectedSubsys) return;
    setScanning(true);
    setStatus('扫描中...');
    setResults({ force: [], wait: [] });
    setSelectedFile(null);
    setPreview(null);
    setConfirmedFiles(new Set());
    // Reload suspicious marks from persistence (sync with backend)
    await loadMarks();
    try {
      const res = await trpc.tools.envChecker.scan.mutate({
        projectRoot: effectiveRoot,
        subsys: selectedSubsys,
      });
      setResults(res);
      // Cache results for this subsystem (both in-memory and backend persistence)
      setScanCache((prev) => {
        const next = new Map(prev);
        next.set(selectedSubsys, res);
        return next;
      });
      trpc.tools.envChecker.saveScanCache
        .mutate({ projectRoot: effectiveRoot, subsys: selectedSubsys, results: res })
        .catch(() => {});
      setStatus(`扫描完成：Force ${res.force.length} 个文件，Wait ${res.wait.length} 个文件`);
    } catch (err) {
      setStatus(`扫描失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScanning(false);
    }
  }, [effectiveRoot, selectedSubsys, loadMarks]);

  // When switching subsystem, restore cached scan results (memory first, then backend).
  useEffect(() => {
    if (!selectedSubsys || !effectiveRoot) return;
    const memCached = scanCache.get(selectedSubsys);
    if (memCached) {
      setResults(memCached);
      setSelectedFile(null);
      setPreview(null);
      setConfirmedFiles(new Set());
      setStatus(`已加载缓存结果：Force ${memCached.force.length} 个文件，Wait ${memCached.wait.length} 个文件`);
      return;
    }
    // Try loading from backend persistence
    trpc.tools.envChecker.loadScanCache
      .query({ projectRoot: effectiveRoot, subsys: selectedSubsys })
      .then((res) => {
        if (res.cached) {
          setResults(res.cached);
          setScanCache((prev) => {
            const next = new Map(prev);
            next.set(selectedSubsys, res.cached as ScanResult);
            return next;
          });
          setStatus(`已加载持久化结果：Force ${(res.cached as ScanResult).force.length} 个文件，Wait ${(res.cached as ScanResult).wait.length} 个文件`);
        } else {
          setResults({ force: [], wait: [] });
        }
      })
      .catch(() => setResults({ force: [], wait: [] }));
  }, [selectedSubsys, scanCache, effectiveRoot]);

  // Preview file with context (debounced + race-condition guarded)
  const handlePreview = useCallback((file: FileResult) => {
    setSelectedFile(file);
    setPreviewLoading(true);
    setPreview(null);

    // Cancel any pending debounce
    if (previewDebounceRef.current) {
      clearTimeout(previewDebounceRef.current);
    }

    previewDebounceRef.current = setTimeout(async () => {
      const requestId = ++previewRequestId.current;
      try {
        const res = await trpc.tools.envChecker.previewFile.query({
          filePath: file.path,
          matches: file.lines,
        });
        // Only update if this is still the latest request
        if (requestId !== previewRequestId.current) return;
        setPreview(res);
      } catch (err) {
        if (requestId !== previewRequestId.current) return;
        setStatus(`预览失败: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (requestId === previewRequestId.current) {
          setPreviewLoading(false);
        }
      }
    }, 150);
  }, []);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (previewDebounceRef.current) {
        clearTimeout(previewDebounceRef.current);
      }
    };
  }, []);

  // Open file in gvim
  const handleOpenFile = useCallback(
    async (filePath: string, lineNumber?: number) => {
      try {
        await trpc.tools.envChecker.openFile.mutate({
          filePath,
          lineNumber: lineNumber ?? null,
        });
        setStatus(`已打开文件: ${filePath.split(/[/\\]/).pop()}`);
      } catch (err) {
        setStatus(`打开文件失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [],
  );

  // Memoized preview rendering to avoid re-processing highlightVerilog on every render.
  const previewContent = useMemo(() => {
    if (!preview) return null;
    return (
      <div className="p-2">
        {preview.sections.map((section, si) => (
          <div key={si} className="mb-3">
            <div className="mb-1 border-b border-border/50 pb-0.5 text-[10px] font-semibold text-muted-foreground">
              ──── 匹配行 {section.matchLine} ────
            </div>
            {section.lines.map((ln) => (
              <div
                key={ln.lineNo}
                className={cn(
                  'flex items-start hover:bg-accent/20',
                  ln.isMatch && 'bg-red-500/10',
                )}
              >
                <button
                  onClick={() => handleOpenFile(preview.filePath, ln.lineNo)}
                  className="w-12 shrink-0 select-none py-0.5 pr-2 text-right text-[10px] text-muted-foreground/60 hover:text-primary hover:underline"
                  title="用 gvim 打开并跳转到此行"
                >
                  {ln.isMatch ? `>${ln.lineNo}` : ` ${ln.lineNo}`}
                </button>
                <span className="select-none py-0.5 pr-2 text-muted-foreground/30">
                  {'│'}
                </span>
                <code className="whitespace-pre-wrap break-all py-0.5 pr-2">
                  {highlightVerilog(ln.content, ln.isMatch)}
                </code>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }, [preview, handleOpenFile]);

  // Confirm marking (replaces window.prompt with custom dialog)
  const handleConfirm = useCallback(
    (file: FileResult) => {
      setPromptConfig({
        title: '确认标记',
        label: '请输入确认信息 (如: Confirmed by xxx):',
        onSubmit: async (comment: string) => {
          setPromptConfig(null);
          try {
            await trpc.tools.envChecker.confirm.mutate({
              filePath: file.path,
              checkType: activeTab,
              comment,
            });
            setConfirmedFiles((prev) => new Set(prev).add(file.path));
            // Clear suspicious mark on confirm and persist
            setSuspiciousMarks((prev) => {
              const next = { force: new Set(prev.force), wait: new Set(prev.wait) };
              next[activeTab].delete(file.path);
              persistMarks(next);
              return next;
            });
            setStatus(`已标记 ${file.path.split(/[/\\]/).pop()}`);
          } catch (err) {
            setStatus(`标记失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      });
    },
    [activeTab, persistMarks],
  );

  // Batch confirm
  const handleBatchConfirm = useCallback(() => {
    setPromptConfig({
      title: '批量确认',
      label: '请输入确认信息 (如: Confirmed by xxx):',
      onSubmit: async (comment: string) => {
        setPromptConfig(null);
        const files = results[activeTab];
        const newConfirmed = new Set(confirmedFiles);
        for (const file of files) {
          if (confirmedFiles.has(file.path)) continue;
          try {
            await trpc.tools.envChecker.confirm.mutate({
              filePath: file.path,
              checkType: activeTab,
              comment,
            });
            newConfirmed.add(file.path);
          } catch (err) {
            console.error(`Failed to confirm ${file.path}:`, err);
          }
        }
        setConfirmedFiles(newConfirmed);
        // Clear suspicious marks for all confirmed files and persist
        setSuspiciousMarks((prev) => {
          const next = { force: new Set(prev.force), wait: new Set(prev.wait) };
          for (const file of files) {
            next[activeTab].delete(file.path);
          }
          persistMarks(next);
          return next;
        });
        setStatus(`批量标记完成: ${files.length} 个文件`);
      },
    });
  }, [results, activeTab, confirmedFiles, persistMarks]);

  // Toggle suspicious marking (per check type) and persist
  const handleToggleSuspicious = useCallback(
    (filePath: string) => {
      setSuspiciousMarks((prev) => {
        const next = { force: new Set(prev.force), wait: new Set(prev.wait) };
        const set = next[activeTab];
        if (set.has(filePath)) {
          set.delete(filePath);
        } else {
          set.add(filePath);
        }
        persistMarks(next);
        return next;
      });
    },
    [activeTab, persistMarks],
  );

  // Export report
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
  const suspiciousSet = suspiciousMarks[activeTab];
  const totalSuspicious = suspiciousMarks.force.size + suspiciousMarks.wait.size;

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {/* Prompt dialog */}
      {promptConfig && (
        <PromptDialog
          title={promptConfig.title}
          label={promptConfig.label}
          defaultValue=""
          onSubmit={promptConfig.onSubmit}
          onCancel={() => setPromptConfig(null)}
        />
      )}

      {/* ── Header: project path + subsystem + scan ── */}
      <div className="flex flex-wrap items-center gap-3 rounded border border-border p-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">项目路径:</span>
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium"
            title={displayPath}
          >
            {displayPath}
          </span>
          <button
            onClick={handleSelectDirectory}
            className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            <FolderOpen className="h-3 w-3" /> 选择
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">子系统:</span>
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
          disabled={scanning || !selectedSubsys || !effectiveRoot}
          className="flex shrink-0 items-center gap-1 rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          <Play className="h-3 w-3" />
          {scanning ? '扫描中...' : scanCache.has(selectedSubsys) ? '重新扫描' : '扫描'}
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

      {/* ── Main content: vertical split (file list on top, preview on bottom) ── */}
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* Top: File list */}
        <div className="flex min-h-0 flex-1 flex-col rounded border border-border">
          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-2 py-1">
            <span className="text-xs font-medium text-muted-foreground">文件列表</span>
            <div className="flex gap-1">
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
          <div className="min-h-0 flex-1 overflow-auto">
            {currentResults.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {scanning ? '扫描中...' : '暂无数据'}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/50">
                  <tr className="text-left">
                    <th className="px-2 py-1 w-10 text-center" title="标记可疑">标记</th>
                    <th className="px-2 py-1">文件路径</th>
                    <th className="px-2 py-1 text-center w-16">数量</th>
                    <th className="px-2 py-1 text-center w-20">状态</th>
                    <th className="px-2 py-1 text-center w-16">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {currentResults.map((file) => {
                    const isConfirmed = confirmedFiles.has(file.path);
                    const isSuspicious = suspiciousSet.has(file.path);
                    return (
                      <tr
                        key={file.path}
                        onClick={() => handlePreview(file)}
                        className={cn(
                          'cursor-pointer border-b border-border/50 hover:bg-accent/30',
                          selectedFile?.path === file.path && 'bg-accent/50',
                          isConfirmed && 'opacity-50',
                        )}
                      >
                        <td className="px-2 py-1 text-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleSuspicious(file.path);
                            }}
                            title={isSuspicious ? '取消可疑标记' : '标记为可疑'}
                            className={cn(
                              'inline-flex h-5 w-5 items-center justify-center rounded transition-colors',
                              isSuspicious
                                ? 'text-red-500'
                                : 'text-muted-foreground hover:text-red-500 hover:bg-red-500/10',
                            )}
                          >
                            <Flag className="h-3.5 w-3.5" fill={isSuspicious ? 'currentColor' : 'none'} />
                          </button>
                        </td>
                        <td className="px-2 py-1">
                          <span
                            className={cn(
                              'block truncate',
                              isConfirmed && 'text-muted-foreground line-through',
                              isSuspicious && !isConfirmed && 'text-red-600 dark:text-red-400 font-medium',
                            )}
                            title={file.path}
                          >
                            {file.path}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-center">
                          <span
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[10px]',
                              isSuspicious
                                ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                                : 'bg-muted',
                            )}
                          >
                            {file.count} 处
                          </span>
                        </td>
                        <td className="px-2 py-1 text-center">
                          {isConfirmed && (
                            <span className="text-[10px] text-green-600 dark:text-green-400">已确认</span>
                          )}
                          {isSuspicious && !isConfirmed && (
                            <span className="text-[10px] text-red-600 dark:text-red-400">可疑</span>
                          )}
                          {!isConfirmed && !isSuspicious && (
                            <span className="text-[10px] text-muted-foreground">待处理</span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleConfirm(file);
                            }}
                            disabled={isConfirmed}
                            title="确认标记"
                            className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
                          >
                            <CheckCircle className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Bottom: Code preview with context + syntax highlighting */}
        <div className="flex min-h-0 flex-1 flex-col rounded border border-border">
          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-2 py-1">
            <span className="text-xs font-medium text-muted-foreground">
              代码预览
              {selectedFile && (
                <span className="ml-2 text-foreground/70" title={selectedFile.path}>
                  {selectedFile.path.split(/[/\\]/).pop()}
                </span>
              )}
            </span>
            {selectedFile && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleOpenFile(selectedFile.path, selectedFile.lines[0]?.line)}
                  className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-accent"
                  title={selectedFile.lines.length > 0 ? `用 gvim 打开并跳转到第 ${selectedFile.lines[0].line} 行` : '用 gvim 打开文件'}
                >
                  <ExternalLink className="h-3 w-3" /> gvim 打开
                </button>
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-muted/10 font-mono text-xs">
            {!selectedFile && (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                选择文件查看预览
              </div>
            )}
            {selectedFile && previewLoading && (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                加载中...
              </div>
            )}
            {selectedFile && preview && !previewLoading && previewContent}
          </div>
        </div>
      </div>

      {/* ── Status bar ── */}
      <div className="flex items-center gap-2 border-t border-border pt-1 text-xs text-muted-foreground">
        <FileText className="h-3 w-3" />
        <span>{status}</span>
        {totalSuspicious > 0 && (
          <span className="ml-auto flex items-center gap-1 text-red-500">
            <Flag className="h-3 w-3" fill="currentColor" />
            可疑项: {totalSuspicious}
          </span>
        )}
      </div>
    </div>
  );
}
