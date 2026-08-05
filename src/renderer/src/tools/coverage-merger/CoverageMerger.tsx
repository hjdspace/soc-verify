/**
 * CoverageMerger — coverage database merge tool.
 *
 * Ported from the Python `coverage_merger` plugin.
 * Features: build merge commands, preview, execute with streaming output,
 * configuration history management.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { FolderOpen, Play, Plus, Trash2, Eye, History } from 'lucide-react';
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

  // Load history on mount
  useEffect(() => {
    trpc.tools.coverageMerger.loadHistory.query().then((res) => {
      setHistory(res.history);
    }).catch(() => {});
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

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

  const handleSelectFile = useCallback(async (key: 'mergeCfg') => {
    const res = await trpc.tools.saveFileDialog.mutate({
      title: '选择文件',
    });
    if (res.path) updateConfig(key, res.path);
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
    const model = config.initialModel === '自定义路径' ? customModel : config.initialModel;
    const fullConfig = { ...config, initialModel: model };
    try {
      const res = await trpc.tools.coverageMerger.previewCommand.query({ config: fullConfig });
      setCommandPreview(res.command);
    } catch (err) {
      setStatus(`预览失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [config, customModel]);

  const handleMerge = useCallback(async () => {
    const model = config.initialModel === '自定义路径' ? customModel : config.initialModel;
    const fullConfig = { ...config, initialModel: model };
    setMerging(true);
    setLogs([]);
    setStatus('合并中...');
    try {
      // Save to history first
      await trpc.tools.coverageMerger.saveHistory.mutate({ config: fullConfig });

      // Refresh history
      const histRes = await trpc.tools.coverageMerger.loadHistory.query();
      setHistory(histRes.history);

      // Execute merge
      const res = await trpc.tools.coverageMerger.execute.mutate({ config: fullConfig, cwd: projectRoot ?? process.cwd() });
      setLogs(res.logs);
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
  }, [config, customModel, projectRoot]);

  const handleLoadHistory = (entry: HistoryEntry) => {
    const { command: _command, timestamp: _timestamp, ...cfg } = entry;
    setConfig(cfg);
    if (!MODEL_OPTIONS.includes(cfg.initialModel)) {
      setCustomModel(cfg.initialModel);
      updateConfig('initialModel', '自定义路径');
    }
    setCommandPreview(entry.command);
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      {/* Hidden input for project root */}
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── History ── */}
      {history.length > 0 && (
        <div className="flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <select
            onChange={(e) => {
              const idx = parseInt(e.target.value, 10);
              if (idx >= 0) handleLoadHistory(history[idx]);
            }}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
            defaultValue=""
          >
            <option value="">新建配置</option>
            {history.map((h, i) => (
              <option key={i} value={i}>
                {new Date(h.timestamp).toLocaleString('zh-CN')} - {h.command.slice(0, 60)}...
              </option>
            ))}
          </select>
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
          onChange={(e) => updateConfig('initialModel', e.target.value)}
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
          <pre className="rounded bg-muted p-2 text-[10px] leading-relaxed overflow-auto">{commandPreview}</pre>
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
        <span className="text-xs text-muted-foreground">{status}</span>
      </div>

      {/* ── Execution logs ── */}
      {logs.length > 0 && (
        <div ref={logRef} className="min-h-[200px] max-h-[300px] overflow-auto rounded border border-border bg-muted/30 p-2">
          {logs.map((line, i) => (
            <div key={i} className="font-mono text-[10px] leading-relaxed text-foreground/80">{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
