/**
 * RegressionListGen — generate regression list natively (no Python dependency).
 *
 * Ported from Python `regression_list_gen_plugin` / `gen_regr_list_gui`.
 * Features:
 *   - Configure params with -cfg as the primary input (first field)
 *   - Auto-infer -block/-base from cfg file path (user can override)
 *   - Preview parsed cases from cfg file
 *   - Execute natively (TypeScript implementation, not subprocess)
 *   - History management
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { FolderOpen, Save, Play, Terminal, History, FileText, Wand2 } from 'lucide-react';
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

type CasePreview = {
  name: string;
  cfgDef: string;
};

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
  const [casePreview, setCasePreview] = useState<CasePreview[]>([]);
  const [casePreviewError, setCasePreviewError] = useState<string | null>(null);

  // Track whether user manually modified block/base (to prevent auto-fill overwriting)
  const userModified = useRef<{ block: boolean; base: boolean }>({ block: false, base: false });
  // Track whether we're applying history (to skip auto-fill)
  const applyingHistory = useRef(false);

  const loadHistoryData = useCallback(async () => {
    try {
      const res = await trpc.tools.regressionListGen.loadHistory.query();
      setHistory(res.history as HistoryEntry[]);
      if (res.current) {
        applyingHistory.current = true;
        setConfig(res.current as Config);
        // Reset modification flags since we're loading saved values
        userModified.current = { block: true, base: true };
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

  const loadCasePreview = useCallback(async (cfgPath: string) => {
    try {
      const res = await trpc.tools.regressionListGen.previewCases.query({ cfgPath });
      setCasePreview(res.cases as CasePreview[]);
      setCasePreviewError(res.error ?? null);
    } catch {
      setCasePreview([]);
      setCasePreviewError(null);
    }
  }, []);

  // Auto-infer base/block and preview cases when cfg path changes
  useEffect(() => {
    if (!config.cfg) {
      setCasePreview([]);
      setCasePreviewError(null);
      return;
    }

    // Skip auto-fill when applying history (values already set)
    if (applyingHistory.current) {
      applyingHistory.current = false;
      // Still load case preview
      void loadCasePreview(config.cfg);
      return;
    }

    // Infer base/block from cfg path
    void (async () => {
      try {
        const res = await trpc.tools.regressionListGen.inferBaseBlock.query({ cfgPath: config.cfg });
        setConfig((prev) => ({
          ...prev,
          // Only auto-fill if user hasn't manually modified the field
          block: userModified.current.block ? prev.block : res.block,
          base: userModified.current.base ? prev.base : res.base,
        }));
        if (!userModified.current.block && res.block) {
          setStatus(`已自动推断 Block=${res.block}`);
        }
        if (!userModified.current.base && res.base) {
          setStatus((prev) => `${prev}${res.base ? `, Base=${res.base}` : ''}`);
        }
      } catch {
        // Ignore inference errors
      }
    })();

    // Load case preview
    void loadCasePreview(config.cfg);
  }, [config.cfg, loadCasePreview]);

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
      // Reset modification flags so auto-fill can work
      userModified.current = { block: false, base: false };
      setConfig((prev) => ({ ...prev, cfg: res.paths[0] }));
    }
  }, [projectRoot]);

  const handleBrowseOutput = useCallback(async () => {
    const res = await trpc.tools.saveFileDialog.mutate({
      title: '选择输出文件',
      defaultPath: config.output || projectRoot || undefined,
      filters: [{ name: '列表文件', extensions: ['lst'] }],
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
    if (!config.block) {
      setStatus('请填写环境 block 名');
      return;
    }
    if (!config.output) {
      setStatus('请选择输出文件路径');
      return;
    }

    setExecuting(true);
    setOutput('');
    setStatus('正在生成回归列表...');

    try {
      const res = await trpc.tools.regressionListGen.execute.mutate({
        config,
        cwd: projectRoot ?? undefined,
      });
      setOutput(res.logs.join('\n'));
      if (res.success) {
        setStatus(`执行完成，回归列表已生成${res.output ? `: ${res.output}` : ''}`);
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
    applyingHistory.current = true;
    // When applying history, mark fields as user-modified (don't auto-fill)
    userModified.current = { block: true, base: true };
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
    // Track manual modification of block/base
    if (field === 'block') {
      userModified.current.block = true;
    } else if (field === 'base') {
      userModified.current.base = true;
    }
    setConfig((prev) => ({ ...prev, [field]: value }));
  };

  const handleReinfer = useCallback(async () => {
    if (!config.cfg) {
      setStatus('请先选择配置文件');
      return;
    }
    try {
      const res = await trpc.tools.regressionListGen.inferBaseBlock.query({ cfgPath: config.cfg });
      // Force re-inference regardless of user modification flags
      userModified.current = { block: false, base: false };
      setConfig((prev) => ({
        ...prev,
        block: res.block,
        base: res.base,
      }));
      setStatus(`已重新推断 Block=${res.block}${res.base ? `, Base=${res.base}` : ''}`);
    } catch (err) {
      setStatus(`推断失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [config.cfg]);

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
          {/* Cfg file — FIRST field (primary input) */}
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-xs font-medium">
              配置文件 (-cfg) <span className="text-destructive">*</span>
            </label>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={config.cfg}
                onChange={(e) => {
                  // Reset modification flags when cfg path is manually typed
                  userModified.current = { block: false, base: false };
                  updateField('cfg', e.target.value);
                }}
                placeholder="请选择 case 配置文件路径（选择后自动推断 Block/Base）"
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
              />
              <button onClick={handleBrowseCfg} className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent">
                <FolderOpen className="h-3 w-3" />
                浏览
              </button>
            </div>
          </div>

          {/* Block — auto-filled from cfg path */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium flex items-center gap-1">
              环境 Block (-block) <span className="text-destructive">*</span>
              {!userModified.current.block && config.block && (
                <span className="rounded bg-primary/10 px-1 text-[10px] text-primary">自动</span>
              )}
            </label>
            <input
              type="text"
              value={config.block}
              onChange={(e) => updateField('block', e.target.value)}
              placeholder="请输入环境 block 名"
              className="rounded border border-border bg-background px-2 py-1.5 text-xs"
            />
          </div>

          {/* Base — auto-filled from cfg path */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium flex items-center gap-1">
              Base 环境 (-base)
              {!userModified.current.base && config.base && (
                <span className="rounded bg-primary/10 px-1 text-[10px] text-primary">自动</span>
              )}
            </label>
            <input
              type="text"
              value={config.base}
              onChange={(e) => updateField('base', e.target.value)}
              placeholder="请输入 base 环境名"
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
              placeholder="请输入 TAG 名"
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

          {/* Output file */}
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-xs font-medium">
              输出路径 (-o) <span className="text-destructive">*</span>
            </label>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={config.output}
                onChange={(e) => updateField('output', e.target.value)}
                placeholder="请选择回归列表生成路径（目录或 .lst 文件）"
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
              />
              <button onClick={handleBrowseOutput} className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent">
                <FolderOpen className="h-3 w-3" />
                浏览
              </button>
            </div>
          </div>
        </div>

        {/* Re-infer button */}
        {config.cfg && (
          <div className="mt-2 flex justify-end">
            <button
              onClick={handleReinfer}
              className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Wand2 className="h-3 w-3" />
              重新推断 Block/Base
            </button>
          </div>
        )}
      </div>

      {/* ── Case preview ── */}
      {config.cfg && (
        <div className="rounded border border-border">
          <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
            <FileText className="h-3 w-3" />
            <span className="text-xs font-semibold">用例预览</span>
            {casePreview.length > 0 && (
              <span className="text-[10px] text-muted-foreground">({casePreview.length} 个用例)</span>
            )}
            {casePreviewError && (
              <span className="text-[10px] text-destructive">— {casePreviewError}</span>
            )}
          </div>
          <div className="max-h-32 overflow-auto p-2">
            {casePreview.length > 0 ? (
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="pb-1 pr-2 font-medium">#</th>
                    <th className="pb-1 pr-2 font-medium">用例名</th>
                    <th className="pb-1 font-medium">CFG_DEF</th>
                  </tr>
                </thead>
                <tbody>
                  {casePreview.map((c, i) => (
                    <tr key={i} className="border-b border-border/50 last:border-0">
                      <td className="py-0.5 pr-2 text-muted-foreground">{i + 1}</td>
                      <td className="py-0.5 pr-2 font-mono">{c.name}</td>
                      <td className="py-0.5 font-mono text-muted-foreground">{c.cfgDef}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="py-2 text-center text-[10px] text-muted-foreground">
                {casePreviewError ? casePreviewError : '解析中...'}
              </div>
            )}
          </div>
        </div>
      )}

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
