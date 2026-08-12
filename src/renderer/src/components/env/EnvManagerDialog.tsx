/**
 * EnvManagerDialog — full-screen modal for managing SoC / EDA environment variables.
 *
 * Features:
 *  - Env vars grouped by category (SOC, Synopsys, Cadence, License, System)
 *  - Auto-detect values from current terminal/shell environment
 *  - Inline editing with system-value hints
 *  - Add / remove custom env vars
 *  - EDA tool detection status
 *  - Save to .socverify/env.json
 */

import { useEffect, useState, useCallback } from 'react';
import {
  X,
  Plus,
  Trash2,
  Save,
  Search,
  RefreshCw,
  SlidersHorizontal,
  Folder,
  Check,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useEnvStore } from '@renderer/stores/env';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';
import { getEnvVarCatalog } from '@shared/env-catalog';
import type { EnvVarCategory, EnvVarGroup } from '@shared/types';

/** Static catalog — available immediately, no async loading needed. */
const CATALOG = getEnvVarCatalog();

export function EnvManagerDialog() {
  const managerOpen = useEnvStore((s) => s.managerOpen);
  if (!managerOpen) return null;
  return <Dialog />;
}

function Dialog() {
  const config = useEnvStore((s) => s.config);
  const systemEnvVars = useEnvStore((s) => s.systemEnvVars);
  const loadSystemEnv = useEnvStore((s) => s.loadSystemEnv);
  const loadConfig = useEnvStore((s) => s.loadConfig);
  const detectTools = useEnvStore((s) => s.detectTools);
  const setManagerOpen = useEnvStore((s) => s.setManagerOpen);
  const saveConfig = useEnvStore((s) => s.saveConfig);
  const autoDetect = useEnvStore((s) => s.autoDetect);
  const detectingSystemEnv = useEnvStore((s) => s.detectingSystemEnv);
  const detecting = useEnvStore((s) => s.detecting);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const [search, setSearch] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<EnvVarCategory>>(
    new Set(['soc', 'synopsys', 'cadence', 'license', 'system']),
  );
  const [saving, setSaving] = useState(false);

  // Load system env and project config on open
  useEffect(() => {
    void loadSystemEnv();
    if (currentProjectId) {
      void loadConfig(currentProjectId);
      void detectTools();
    }
  }, [loadSystemEnv, loadConfig, detectTools, currentProjectId]);

  const envVars = config?.envVars ?? {};

  const handleSave = useCallback(async () => {
    if (!currentProjectId || !config) return;
    setSaving(true);
    await saveConfig(currentProjectId, config);
    setSaving(false);
    setManagerOpen(false);
  }, [currentProjectId, config, saveConfig, setManagerOpen]);

  const handleAutoDetect = useCallback(async () => {
    if (!currentProjectId) return;
    await autoDetect(currentProjectId);
    await loadSystemEnv();
  }, [currentProjectId, autoDetect, loadSystemEnv]);

  const handleRefreshSystemEnv = useCallback(async () => {
    await loadSystemEnv();
  }, [loadSystemEnv]);

  const toggleCategory = useCallback((cat: EnvVarCategory) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  // Filter catalog by search
  const filteredCatalog: EnvVarGroup[] = search
    ? CATALOG.map((group) => ({
        ...group,
        vars: group.vars.filter(
          (v) =>
            v.name.toLowerCase().includes(search.toLowerCase()) ||
            v.description.toLowerCase().includes(search.toLowerCase()),
        ),
      })).filter((g) => g.vars.length > 0)
    : CATALOG;

  // Custom env vars (not in catalog)
  const catalogVarNames = new Set(CATALOG.flatMap((g) => g.vars.map((v) => v.name)));
  const customVars = Object.entries(envVars).filter(([key]) => !catalogVarNames.has(key));

  const detectedCount = Object.keys(systemEnvVars).length;
  const configuredCount = Object.keys(envVars).length;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
      <div className="flex h-[85vh] w-[900px] max-w-[95vw] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
        {/* ── Header ─────────────────────────────────────── */}
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">环境变量管理</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {configuredCount} 已配置 · {detectedCount} 系统检测
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefreshSystemEnv}
              disabled={detectingSystemEnv}
              title="刷新系统环境变量"
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn('h-3 w-3', detectingSystemEnv && 'animate-spin')} />
              刷新系统变量
            </button>
            <button
              onClick={handleAutoDetect}
              disabled={detectingSystemEnv || !currentProjectId}
              className="flex items-center gap-1 rounded bg-primary/10 px-3 py-1 text-xs text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
            >
              {detectingSystemEnv ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Search className="h-3 w-3" />
              )}
              从终端自动检测
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !currentProjectId}
              className="flex items-center gap-1 rounded bg-status-pass/10 px-3 py-1 text-xs text-status-pass-foreground transition-colors hover:bg-status-pass/20 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              保存
            </button>
            <button
              onClick={() => setManagerOpen(false)}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ── Search bar ────────────────────────────────── */}
        <div className="flex items-center gap-2 border-b px-5 py-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索环境变量..."
              className="w-full rounded border border-border bg-background py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* ── Body: scrollable env var list ─────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {/* EDA Tools section */}
          {config?.tools && config.tools.length > 0 && (
            <EdaToolsSection tools={config.tools} detecting={detecting} />
          )}

          {/* Catalog groups */}
          {filteredCatalog.map((group) => (
            <CategorySection
              key={group.category}
              group={group}
              expanded={expandedCategories.has(group.category)}
              onToggle={() => toggleCategory(group.category)}
              envVars={envVars}
              systemEnvVars={systemEnvVars}
            />
          ))}

          {/* Custom env vars */}
          {customVars.length > 0 && (
            <div className="mb-2">
              <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left">
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="text-xs font-semibold">自定义环境变量</span>
                <span className="text-[10px] text-muted-foreground">非标准变量</span>
                <div className="ml-auto flex items-center gap-2 text-[10px]">
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-primary">
                    {customVars.length} 已配置
                  </span>
                </div>
              </button>
              <div className="ml-5 space-y-1.5 border-l border-border/50 pl-3">
                {customVars.map(([key, val]) => (
                  <EnvVarRow
                    key={key}
                    name={key}
                    description="自定义变量"
                    value={val}
                    systemValue={systemEnvVars[key]}
                    onRemove={() => useEnvStore.getState().removeEnvVar(key)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Add custom var */}
          <AddCustomVarSection catalogVarNames={catalogVarNames} />
        </div>

        {/* ── Footer ────────────────────────────────────── */}
        <div className="flex items-center justify-between border-t px-5 py-2">
          <div className="text-[10px] text-muted-foreground">
            配置保存至 .socverify/env.json，仿真运行时自动注入
          </div>
          <button
            onClick={() => setManagerOpen(false)}
            className="rounded px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Category Section ─────────────────────────────────────

interface CategorySectionProps {
  group: EnvVarGroup;
  expanded: boolean;
  onToggle: () => void;
  envVars: Record<string, string>;
  systemEnvVars: Record<string, string>;
}

function CategorySection({ group, expanded, onToggle, envVars, systemEnvVars }: CategorySectionProps) {
  const configuredInGroup = group.vars.filter((v) => envVars[v.name] !== undefined).length;
  const systemInGroup = group.vars.filter((v) => systemEnvVars[v.name] !== undefined).length;

  return (
    <div className="mb-2">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="text-xs font-semibold">{group.label}</span>
        <span className="text-[10px] text-muted-foreground">{group.description}</span>
        <div className="ml-auto flex items-center gap-2 text-[10px]">
          {configuredInGroup > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-primary">
              {configuredInGroup} 已配置
            </span>
          )}
          {systemInGroup > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-primary">
              {systemInGroup} 系统检测
            </span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="ml-5 space-y-1.5 border-l border-border/50 pl-3">
          {group.vars.map((def) => (
            <EnvVarRow
              key={def.name}
              name={def.name}
              description={def.description}
              isPath={def.isPath}
              value={envVars[def.name] ?? ''}
              systemValue={systemEnvVars[def.name]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Env Var Row ──────────────────────────────────────────

interface EnvVarRowProps {
  name: string;
  description: string;
  isPath?: boolean;
  value: string;
  systemValue?: string;
  onRemove?: () => void;
}

function EnvVarRow({ name, description, isPath, value, systemValue, onRemove }: EnvVarRowProps) {
  const setEnvVar = useEnvStore((s) => s.setEnvVar);
  const removeEnvVar = useEnvStore((s) => s.removeEnvVar);

  const hasSystemValue = systemValue !== undefined && systemValue !== '';
  const isUsingSystem = hasSystemValue && value === systemValue;

  return (
    <div className="flex items-start gap-2 rounded px-1 py-1 transition-colors hover:bg-accent/30">
      {/* Variable name + description */}
      <div className="w-44 shrink-0 pt-1">
        <div className="flex items-center gap-1">
          {isPath && <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />}
          <span className="truncate font-mono text-xs font-medium" title={name}>
            {name}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={description}>
          {description}
        </div>
      </div>

      {/* Value input */}
      <div className="flex-1">
        <input
          type="text"
          value={value}
          onChange={(e) => setEnvVar(name, e.target.value)}
          placeholder={hasSystemValue ? `系统: ${systemValue}` : '未设置'}
          className={cn(
            'w-full rounded border bg-background px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary',
            isUsingSystem ? 'border-primary/40 bg-primary/5' : 'border-border',
          )}
        />
        {/* System value hint */}
        {hasSystemValue && !isUsingSystem && value !== '' && (
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="text-primary">系统值:</span>
            <span className="truncate font-mono" title={systemValue}>
              {systemValue}
            </span>
            <button
              onClick={() => setEnvVar(name, systemValue!)}
              className="ml-1 rounded bg-primary/10 px-1 py-0.5 text-primary hover:bg-primary/20"
            >
              应用
            </button>
          </div>
        )}
        {hasSystemValue && isUsingSystem && (
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-primary">
            <Check className="h-2.5 w-2.5" />
            与系统值一致
          </div>
        )}
      </div>

      {/* Status badge */}
      <div className="flex shrink-0 items-center gap-1 pt-1">
        {value ? (
          <span className="rounded-full bg-status-pass/10 px-1.5 py-0.5 text-[10px] text-status-pass-foreground">
            已设置
          </span>
        ) : hasSystemValue ? (
          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
            可自动填充
          </span>
        ) : (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            未设置
          </span>
        )}
        {/* Remove button (for custom vars or to clear a value) */}
        {onRemove ? (
          <button
            onClick={onRemove}
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="删除"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ) : (
          value && (
            <button
              onClick={() => removeEnvVar(name)}
              className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="清除"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )
        )}
      </div>
    </div>
  );
}

// ── Add Custom Var Section ───────────────────────────────

function AddCustomVarSection({ catalogVarNames }: { catalogVarNames: Set<string> }) {
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const setEnvVar = useEnvStore((s) => s.setEnvVar);
  const knownEnvVars = useEnvStore((s) => s.knownEnvVars);
  const loadKnownEnvVars = useEnvStore((s) => s.loadKnownEnvVars);

  useEffect(() => {
    void loadKnownEnvVars();
  }, [loadKnownEnvVars]);

  const handleAdd = () => {
    const key = newKey.trim();
    if (!key) return;
    setEnvVar(key, newVal);
    setNewKey('');
    setNewVal('');
  };

  return (
    <div className="mt-4 border-t pt-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Plus className="h-3 w-3" />
        添加自定义环境变量
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          list="known-env-vars-manager"
          placeholder="变量名..."
          className="w-44 shrink-0 rounded border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        />
        <datalist id="known-env-vars-manager">
          {knownEnvVars.filter((v) => !catalogVarNames.has(v)).map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <input
          type="text"
          value={newVal}
          onChange={(e) => setNewVal(e.target.value)}
          placeholder="变量值..."
          className="flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        />
        <button
          onClick={handleAdd}
          disabled={!newKey.trim()}
          className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20 disabled:opacity-30"
        >
          <Plus className="h-3 w-3" />
          添加
        </button>
      </div>
    </div>
  );
}

// ── EDA Tools Section ────────────────────────────────────

function EdaToolsSection({
  tools,
  detecting,
}: {
  tools: Array<{ name: string; path: string; detected: boolean; version?: string }>;
  detecting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detected = tools.filter((t) => t.detected);
  const notDetected = tools.filter((t) => !t.detected);

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="text-xs font-semibold">EDA 工具检测</span>
        <span className="text-[10px] text-muted-foreground">扫描 PATH 中的 EDA 工具</span>
        <div className="ml-auto flex items-center gap-2 text-[10px]">
          {detecting ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              扫描中...
            </span>
          ) : (
            <>
              <span className="rounded-full bg-status-pass/10 px-1.5 py-0.5 text-status-pass-foreground">
                {detected.length} 已检测
              </span>
              {notDetected.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
                  {notDetected.length} 未检测
                </span>
              )}
            </>
          )}
        </div>
      </button>

      {expanded && !detecting && (
        <div className="ml-5 space-y-1.5 border-l border-border/50 pl-3">
          {detected.map((tool) => (
            <div
              key={tool.name}
              className="flex items-start gap-2 rounded border border-status-pass/30 bg-status-pass/5 px-1 py-1"
            >
              <div className="w-44 shrink-0 pt-1">
                <div className="flex items-center gap-1">
                  <Check className="h-3 w-3 shrink-0 text-status-pass-foreground" />
                  <span className="truncate text-xs font-medium" title={tool.name}>
                    {tool.name}
                  </span>
                </div>
                {tool.version && (
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={tool.version}>
                    {tool.version}
                  </div>
                )}
              </div>
              <div className="flex-1 pt-1">
                <span className="block truncate font-mono text-[10px] text-muted-foreground" title={tool.path}>
                  {tool.path}
                </span>
              </div>
              <div className="shrink-0 pt-1">
                <span className="rounded-full bg-status-pass/10 px-1.5 py-0.5 text-[10px] text-status-pass-foreground">
                  已检测
                </span>
              </div>
            </div>
          ))}
          {notDetected.map((tool) => (
            <div key={tool.name} className="flex items-start gap-2 rounded px-1 py-1 opacity-60">
              <div className="w-44 shrink-0 pt-1">
                <div className="flex items-center gap-1">
                  <X className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate text-xs font-medium" title={tool.name}>
                    {tool.name}
                  </span>
                </div>
              </div>
              <div className="flex-1 pt-1">
                <span className="text-[10px] text-muted-foreground">未检测到</span>
              </div>
              <div className="shrink-0 pt-1">
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  未检测
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
