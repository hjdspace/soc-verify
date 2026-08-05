/**
 * RegressionListGen — generate regression list commands and execute.
 *
 * Ported from the Python `regression_list_gen_plugin` / `gen_regr_list_gui`.
 * Features: configure params, preview command, execute, history management.
 */

import { useState, useCallback, useEffect } from 'react';
import { FolderOpen, Save, Play, Terminal, History } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type Config = {
  block: string;
  base: string;
  tag: string;
  cfg: string;
  output: string;
  otherOptions: string;
};

type HistoryEntry = Config & { timestamp: string };

const EMPTY_CONFIG: Config = {
  block: '',
  base: '',
  tag: '',
  cfg: '',
  output: '',
  otherOptions: '',
};

export function RegressionListGen({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [config, setConfig] = useState<Config>(EMPTY_CONFIG);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [command, setCommand] = useState('');
  const [executing, setExecuting] = useState(false);
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState('就绪');

  const loadHistoryData = useCallback(async () => {
    try {
      const res = await trpc.tools.regressionListGen.loadHistory.query();
      setHistory(res.history as HistoryEntry[]);
      if (res.current) {
        setConfig(res.current as Config);
      }
    } catch {
      // Ignore — first run has no config
    }
  }, []);

  // Load history on mount
  useEffect(() => {
    void loadHistoryData();
  }, [loadHistoryData]);

  const updateCommand = useCallback(async () => {
    try {
      const res = await trpc.tools.regressionListGen.previewCommand.query({ config });
      setCommand(res.command);
    } catch {
      // Ignore
    }
  }, [config]);

  // Auto-update command preview when config changes
  useEffect(() => {
    void updateCommand();
  }, [config, updateCommand]);

  const handleBrowseCfg = useCallback(async () => {
    const res = await trpc.tools.selectFiles.mutate({
      title: '选择配置文件',
      filters: [
        { name: '配置文件', extensions: ['cfg'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      defaultPath: projectRoot ?? undefined,
    });
    if (res.paths.length > 0) {
      setConfig((prev) => ({ ...prev, cfg: res.paths[0] }));
    }
  }, [projectRoot]);

  const handleBrowseOutput = useCallback(async () => {
    const res = await trpc.tools.saveFileDialog.mutate({
      title: '选择输出文件',
      defaultPath: config.output || projectRoot || undefined,
      filters: [{ name: '列表文件', extensions: ['list'] }],
    });
    if (res.path) {
      setConfig((prev) => ({ ...prev, output: res.path }));
    }
  }, [config.output, projectRoot]);

  const handleGenerate = useCallback(async () => {
    try {
      const res = await trpc.tools.regressionListGen.previewCommand.query({ config });
      setCommand(res.command);
      setStatus('命令已生成');
    } catch (err) {
      setStatus(`生成失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [config]);

  const handleExecute = useCallback(async () => {
    if (!config.cfg) {
      setStatus('请选择配置文件路径');
      return;
    }
    if (!config.output) {
      setStatus('请选择输出文件路径');
      return;
    }

    setExecuting(true);
    setOutput('');
    setStatus('正在执行命令...');

    try {
      const res = await trpc.tools.regressionListGen.execute.mutate({
        config,
        cwd: projectRoot ?? undefined,
      });
      setOutput(res.logs.join('\n'));
      if (res.success) {
        setStatus('执行完成，回归列表生成成功');
        // Save to history
        await trpc.tools.regressionListGen.saveHistory.mutate({ config });
        await loadHistoryData();
      } else {
        setStatus(`执行失败${res.errorMessage ? `: ${res.errorMessage}` : ''}`);
      }
    } catch (err) {
      setStatus(`执行异常: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExecuting(false);
    }
  }, [config, projectRoot, loadHistoryData]);

  const handleSaveConfig = useCallback(async () => {
    try {
      await trpc.tools.regressionListGen.saveConfig.mutate({ config });
      setStatus('配置已保存');
    } catch (err) {
      setStatus(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [config]);

  const handleApplyHistory = useCallback((index: number) => {
    if (index < 0 || index >= history.length) return;
    const entry = history[index];
    setConfig({
      block: entry.block,
      base: entry.base,
      tag: entry.tag,
      cfg: entry.cfg,
      output: entry.output,
      otherOptions: entry.otherOptions,
    });
  }, [history]);

  const updateField = (field: keyof Config, value: string) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── History ── */}
      <div className="flex items-center gap-2">
        <History className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium whitespace-nowrap">历史配置:</span>
        <select
          onChange={(e) => handleApplyHistory(parseInt(e.target.value, 10))}
          defaultValue=""
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
        >
          <option value="" disabled>选择历史配置...</option>
          {history.map((h, i) => (
            <option key={i} value={i}>
              {i + 1}. {h.cfg ? h.cfg.split(/[/\\]/).pop() : 'N/A'} → {h.output ? h.output.split(/[/\\]/).pop() : 'N/A'} ({h.timestamp})
            </option>
          ))}
        </select>
      </div>

      {/* ── Config form ── */}
      <div className="rounded border border-border p-3">
        <div className="grid grid-cols-2 gap-3">
          {/* Block */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">环境 Block (-block)</label>
            <input
              type="text"
              value={config.block}
              onChange={(e) => updateField('block', e.target.value)}
              placeholder="请输入环境block名"
              className="rounded border border-border bg-background px-2 py-1.5 text-xs"
            />
          </div>

          {/* Base */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">Base 环境 (-base)</label>
            <input
              type="text"
              value={config.base}
              onChange={(e) => updateField('base', e.target.value)}
              placeholder="请输入base环境名"
              className="rounded border border-border bg-background px-2 py-1.5 text-xs"
            />
          </div>

          {/* Tag */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">TAG 名 (-tag)</label>
            <input
              type="text"
              value={config.tag}
              onChange={(e) => updateField('tag', e.target.value)}
              placeholder="请输入TAG名"
              className="rounded border border-border bg-background px-2 py-1.5 text-xs"
            />
          </div>

          {/* Other options */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">其他选项</label>
            <input
              type="text"
              value={config.otherOptions}
              onChange={(e) => updateField('otherOptions', e.target.value)}
              placeholder="其他命令行选项"
              className="rounded border border-border bg-background px-2 py-1.5 text-xs"
            />
          </div>

          {/* Cfg file */}
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-xs font-medium">配置文件 (-cfg)</label>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={config.cfg}
                onChange={(e) => updateField('cfg', e.target.value)}
                placeholder="请选择case配置文件路径"
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
              />
              <button onClick={handleBrowseCfg} className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent">
                <FolderOpen className="h-3 w-3" />
                浏览
              </button>
            </div>
          </div>

          {/* Output file */}
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-xs font-medium">输出路径 (-o)</label>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={config.output}
                onChange={(e) => updateField('output', e.target.value)}
                placeholder="请选择回归列表生成路径"
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
              />
              <button onClick={handleBrowseOutput} className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent">
                <FolderOpen className="h-3 w-3" />
                浏览
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Command preview ── */}
      <div className="rounded border border-border">
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
          <Terminal className="h-3 w-3" />
          <span className="text-xs font-semibold">命令预览</span>
        </div>
        <pre className="overflow-auto p-3 font-mono text-xs leading-relaxed text-foreground/80">
          {command || '(请填写参数生成命令)'}
        </pre>
      </div>

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {/* ── Output ── */}
      {output && (
        <div className="min-h-0 max-h-40 overflow-auto rounded border border-border bg-muted/30 p-2">
          <pre className="whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-foreground/70">{output}</pre>
        </div>
      )}

      {/* ── Buttons ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleGenerate}
          className="flex items-center gap-1.5 rounded border border-border px-4 py-1.5 text-xs font-medium hover:bg-accent"
        >
          <Terminal className="h-3 w-3" />
          生成命令
        </button>
        <button
          onClick={handleExecute}
          disabled={executing}
          className="flex items-center gap-1.5 rounded bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Play className={cn('h-3 w-3', executing && 'animate-pulse')} />
          {executing ? '执行中...' : '执行命令'}
        </button>
        <button
          onClick={handleSaveConfig}
          className="flex items-center gap-1.5 rounded border border-border px-4 py-1.5 text-xs font-medium hover:bg-accent"
        >
          <Save className="h-3 w-3" />
          保存配置
        </button>
      </div>
    </div>
  );
}
