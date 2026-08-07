/**
 * CoverageMerger — coverage database merge tool.
 *
 * Ported from the Python `coverage_merger` plugin.
 * Features: build merge commands, preview, execute with streaming output,
 * configuration history management (load / save / delete / clear),
 * real-time log streaming via IPC events.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { FolderOpen, Play, Plus, Trash2, Eye, History, X } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';

type MergeConfig = {
  baseDir: string;
  databases: string[];
  mergeHier: string;
  initialModel: string;
  mergeWork: string;
  mergeCfg: string;
};

type HistoryEntry = MergeConfig & {
  command: string;
  timestamp: string;
};

const MODEL_OPTIONS = ['primary_run', 'empty', 'union_all:cov', '自定义路径'];

const DEFAULT_CONFIG: MergeConfig = {
  baseDir: '',
  databases: [],
  mergeHier: '',
  initialModel: 'primary_run',
  mergeWork: '',
  mergeCfg: '',
};

export function CoverageMerger({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [config, setConfig] = useState<MergeConfig>(DEFAULT_CONFIG);
  const [customModel, setCustomModel] = useState('');
  const [commandPreview, setCommandPreview] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [status, setStatus] = useState('就绪');
  const logRef = useRef<HTMLDivElement>(null);
  // Track the active history index for highlighting (-1 = new config)
  const [activeHistoryIndex, setActiveHistoryIndex] = useState(-1);

  // Load history on mount
  const refreshHistory = useCallback(async () => {
    try {
      const res = await trpc.tools.coverageMerger.loadHistory.query();
      setHistory(res.history);
    } catch {
      // Ignore errors
    }
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  // ── Real-time log streaming via IPC events (matches git-quick-pull pattern) ──
  useEffect(() => {
    if (!window.eventBridge) return;
    const unsubscribe = window.eventBridge.onCoverageMergerLog((event) => {
      if (event.type === 'start' && event.lines) {
        setLogs(event.lines);
      } else if (event.type === 'output' && event.line) {
        setLogs((prev) => [...prev, event.line!]);
      } else if (event.type === 'end' && event.lines) {
        setLogs((prev) => [...prev, ...event.lines!]);
      }
    });
    return unsubscribe;
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  // ── Auto-preview command when config changes ──
  const buildFullConfig = useCallback((): MergeConfig => {
    const model = config.initialModel === '自定义路径' ? customModel : config.initialModel;
    return { ...config, initialModel: model };
  }, [config, customModel]);

  const autoPreview = useCallback(async () => {
    const fullConfig = buildFullConfig();
    try {
      const res = await trpc.tools.coverageMerger.previewCommand.query({ config: fullConfig });
      setCommandPreview(res.command);
    } catch {
      // Ignore preview errors
    }
  }, [buildFullConfig]);

  // Debounced auto-preview on config/customModel changes
  useEffect(() => {
    const timer = setTimeout(() => {
      autoPreview();
    }, 300);
    return () => clearTimeout(timer);
  }, [config, customModel, autoPreview]);

  const updateConfig = (key: keyof MergeConfig, value: string | string[]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleSelectDir = useCallback(async (key: 'baseDir' | 'mergeWork') => {
    const res = await trpc.tools.selectDirectory.mutate({
      title: '选择目录',
      defaultPath: projectRoot ?? undefined,
    });
    if (res.path) updateConfig(key, res.path);
  }, [projectRoot]);

  // Fix: use selectFiles (open file dialog) instead of saveFileDialog for merge_cfg
  const handleSelectFile = useCallback(async (key: 'mergeCfg') => {
    const res = await trpc.tools.selectFiles.mutate({
      title: '选择配置文件',
    });
    if (res.paths && res.paths.length > 0) updateConfig(key, res.paths[0]);
  }, []);

  const handleAddDatabase = useCallback(async () => {
    const res = await trpc.tools.selectDirectory.mutate({
      title: '选择覆盖率数据库目录',
      defaultPath: projectRoot ?? undefined,
    });
    if (res.path) {
      setConfig((prev) => ({ ...prev, databases: [...prev.databases, res.path!] }));
    }
  }, [projectRoot]);

  const handleRemoveDatabase = (index: number) => {
    setConfig((prev) => ({ ...prev, databases: prev.databases.filter((_, i) => i !== index) }));
  };

  const handlePreview = useCallback(async () => {
    const fullConfig = buildFullConfig();
    try {
      const res = await trpc.tools.coverageMerger.previewCommand.query({ config: fullConfig });
      setCommandPreview(res.command);
    } catch (err) {
      setStatus(`预览失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [buildFullConfig]);

  const handleMerge = useCallback(async () => {
    const fullConfig = buildFullConfig();
    setMerging(true);
    setLogs([]);
    setStatus('合并中...');
    try {
      // Save to history first (matches Python: save before execute)
      await trpc.tools.coverageMerger.saveHistory.mutate({ config: fullConfig });

      // Refresh history
      const histRes = await trpc.tools.coverageMerger.loadHistory.query();
      setHistory(histRes.history);
      setActiveHistoryIndex(0); // The just-saved entry is now at index 0

      // Execute merge (real-time logs arrive via IPC events)
      const res = await trpc.tools.coverageMerger.execute.mutate({
        config: fullConfig,
        cwd: projectRoot ?? process.cwd(),
      });

      // Ensure final logs are set (IPC events may have already done this)
      if (res.logs.length > 0) {
        setLogs(res.logs);
      }

      if (res.success) {
        setStatus('合并成功完成');
      } else {
        setStatus(`合并失败: ${res.errorMessage ?? '未知错误'}`);
      }
    } catch (err) {
      setStatus(`合并失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setMerging(false);
    }
  }, [buildFullConfig, projectRoot]);

  // ── History actions ──

  const handleLoadHistory = (entry: HistoryEntry, index: number) => {
    const { command: _command, timestamp: _timestamp, ...cfg } = entry;
    setConfig(cfg);
    if (!MODEL_OPTIONS.includes(cfg.initialModel)) {
      setCustomModel(cfg.initialModel);
      updateConfig('initialModel', '自定义路径');
    } else {
      setCustomModel('');
    }
    setCommandPreview(entry.command);
    setActiveHistoryIndex(index);
  };

  const handleNewConfig = () => {
    setConfig(DEFAULT_CONFIG);
    setCustomModel('');
    setCommandPreview('');
    setActiveHistoryIndex(-1);
  };

  const handleDeleteHistory = async (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      const res = await trpc.tools.coverageMerger.deleteHistory.mutate({ index });
      setHistory(res.history);
      if (activeHistoryIndex === index) {
        setActiveHistoryIndex(-1);
      } else if (activeHistoryIndex > index) {
        setActiveHistoryIndex(activeHistoryIndex - 1);
      }
    } catch {
      // Ignore errors
    }
  };

  const handleClearHistory = async () => {
    try {
      await trpc.tools.coverageMerger.clearHistory.mutate();
      setHistory([]);
      setActiveHistoryIndex(-1);
    } catch {
      // Ignore errors
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      {/* Hidden input for project root */}
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── History (always visible, matches Python's always-shown dropdown) ── */}
      <div className="flex items-center gap-2">
        <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <select
          onChange={(e) => {
            const idx = parseInt(e.target.value, 10);
            if (idx === -1) {
              handleNewConfig();
            } else if (idx >= 0 && idx < history.length) {
              handleLoadHistory(history[idx], idx);
            }
          }}
          value={activeHistoryIndex}
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
        >
          <option value={-1}>新建配置</option>
          {history.map((h, i) => (
            <option key={i} value={i} title={h.command}>
              {new Date(h.timestamp).toLocaleString('zh-CN')} — {h.command.slice(0, 60)}
              {h.command.length > 60 ? '...' : ''}
            </option>
          ))}
        </select>
        {history.length > 0 && (
          <button
            onClick={handleClearHistory}
            title="清空所有历史记录"
            className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
            清空
          </button>
        )}
      </div>

      {/* ── History item list with delete buttons (when history exists) ── */}
      {history.length > 0 && activeHistoryIndex >= 0 && (
        <div className="rounded border border-border bg-muted/30 p-1.5">
          <div className="mb-1 text-[10px] font-medium text-muted-foreground">
            历史记录 ({history.length})
          </div>
          <div className="flex flex-wrap gap-1">
            {history.map((h, i) => (
              <div
                key={i}
                className={`group flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                  i === activeHistoryIndex ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                <button
                  onClick={() => handleLoadHistory(h, i)}
                  title={h.command}
                  className="max-w-[200px] truncate"
                >
                  {new Date(h.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  {' '}
                  {h.command.slice(0, 30)}{h.command.length > 30 ? '...' : ''}
                </button>
                <button
                  onClick={(e) => handleDeleteHistory(i, e)}
                  className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                  title="删除此记录"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Base dir ── */}
      <div className="flex items-center gap-2">
        <label className="w-32 shrink-0 text-xs font-medium text-muted-foreground">覆盖率基板路径</label>
        <input
          value={config.baseDir}
          onChange={(e) => updateConfig('baseDir', e.target.value)}
          placeholder="选择作为基板的覆盖率数据库路径"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
        />
        <button onClick={() => handleSelectDir('baseDir')} className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent">
          <FolderOpen className="h-3 w-3" />
        </button>
      </div>

      {/* ── Database list ── */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">覆盖率数据库列表</label>
        <div className="flex gap-2">
          <div className="min-w-0 flex-1 rounded border border-border">
            {config.databases.length === 0 ? (
              <div className="p-2 text-xs text-muted-foreground">无数据库，点击"添加"添加覆盖率数据库</div>
            ) : (
              config.databases.map((db, i) => (
                <div key={i} className="flex items-center gap-2 border-b border-border px-2 py-1 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate text-xs">{db}</span>
                  <button onClick={() => handleRemoveDatabase(i)} className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>
          <button onClick={handleAddDatabase} className="flex items-center gap-1 self-start rounded border border-border px-2 py-1.5 text-xs hover:bg-accent">
            <Plus className="h-3 w-3" />
            添加
          </button>
        </div>
      </div>

      {/* ── Merge hier ── */}
      <div className="flex items-center gap-2">
        <label className="w-32 shrink-0 text-xs font-medium text-muted-foreground">合并层级</label>
        <input
          value={config.mergeHier}
          onChange={(e) => updateConfig('mergeHier', e.target.value)}
          placeholder="tb_top.chip_top.dut"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
        />
      </div>

      {/* ── Initial model ── */}
      <div className="flex items-center gap-2">
        <label className="w-32 shrink-0 text-xs font-medium text-muted-foreground">Initial Model</label>
        <select
          value={config.initialModel}
          onChange={(e) => {
            updateConfig('initialModel', e.target.value);
            if (e.target.value !== '自定义路径') {
              setCustomModel('');
            }
          }}
          className="rounded border border-border bg-background px-2 py-1.5 text-xs"
        >
          {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {config.initialModel === '自定义路径' && (
          <input
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="输入自定义路径..."
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
          />
        )}
      </div>

      {/* ── Merge work ── */}
      <div className="flex items-center gap-2">
        <label className="w-32 shrink-0 text-xs font-medium text-muted-foreground">输出路径</label>
        <input
          value={config.mergeWork}
          onChange={(e) => updateConfig('mergeWork', e.target.value)}
          placeholder="不指定时默认 $PROJ_WORK/coverage_merge/..."
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
        />
        <button onClick={() => handleSelectDir('mergeWork')} className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent">
          <FolderOpen className="h-3 w-3" />
        </button>
      </div>

      {/* ── Merge cfg ── */}
      <div className="flex items-center gap-2">
        <label className="w-32 shrink-0 text-xs font-medium text-muted-foreground">配置文件</label>
        <input
          value={config.mergeCfg}
          onChange={(e) => updateConfig('mergeCfg', e.target.value)}
          placeholder="不同hier的cov merge时需要指定"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
        />
        <button onClick={() => handleSelectFile('mergeCfg')} className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent">
          <FolderOpen className="h-3 w-3" />
        </button>
      </div>

      {/* ── Command preview ── */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <button onClick={handlePreview} className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-accent">
            <Eye className="h-3.5 w-3.5" />
            预览命令
          </button>
        </div>
        {commandPreview && (
          <pre className="overflow-auto rounded bg-muted p-2 text-[10px] leading-relaxed">{commandPreview}</pre>
        )}
      </div>

      {/* ── Action buttons ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleMerge}
          disabled={merging}
          className="flex items-center gap-1.5 rounded bg-primary px-4 py-2 text-xs text-primary-foreground disabled:opacity-50"
        >
          <Play className="h-3.5 w-3.5" />
          {merging ? '合并中...' : '开始合并'}
        </button>
        <span className={`text-xs ${merging ? 'text-primary' : 'text-muted-foreground'}`}>{status}</span>
      </div>

      {/* ── Execution logs (always show during/after merge) ── */}
      {(logs.length > 0 || merging) && (
        <div ref={logRef} className="min-h-[200px] max-h-[400px] overflow-auto rounded border border-border bg-muted/30 p-2">
          {logs.length === 0 && merging && (
            <div className="text-[10px] text-muted-foreground">等待输出...</div>
          )}
          {logs.map((line, i) => (
            <div key={i} className={`font-mono text-[10px] leading-relaxed ${
              line.includes('失败') || line.includes('错误') || line.includes('error') ? 'text-destructive' :
              line.includes('成功') || line.includes('完成') ? 'text-primary' :
              'text-foreground/80'
            }`}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
