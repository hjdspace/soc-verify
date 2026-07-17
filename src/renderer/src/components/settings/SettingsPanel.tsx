import { useEffect, useState } from 'react';
import { X, Key, Package, Server, FileText, Plus, Trash2, Save, Download, Upload, Palette, Check, Cpu, RefreshCw, Zap } from 'lucide-react';
import { useSettingsStore } from '@renderer/stores/settings';
import { useProjectStore } from '@renderer/stores/project';
import { useUiStore } from '@renderer/stores/ui';
import { useThemeStore } from '@renderer/stores/theme';
import { useSessionStore } from '@renderer/stores/session';
import { cn } from '@renderer/lib/utils';
import type { CredentialEntry } from '@shared/types';

type SettingsTab = 'credentials' | 'skills' | 'mcp' | 'prompt' | 'appearance';

export function SettingsPanel() {
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<SettingsTab>('credentials');

  if (!settingsOpen) return null;

  const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Key }> = [
    { id: 'credentials', label: '模型配置', icon: Cpu },
    { id: 'skills', label: 'Skill 管理', icon: Package },
    { id: 'mcp', label: 'MCP 配置', icon: Server },
    { id: 'prompt', label: '系统提示词', icon: FileText },
    { id: 'appearance', label: '外观', icon: Palette },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex h-[520px] w-[680px] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">设置</h2>
          <button
            onClick={() => setSettingsOpen(false)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors',
                tab === t.id
                  ? 'border-b border-primary text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'credentials' && <CredentialsTab />}
          {tab === 'skills' && <SkillsTab />}
          {tab === 'mcp' && <McpTab />}
          {tab === 'prompt' && <PromptTab />}
        </div>
      </div>
    </div>
  );
}

// ── Appearance Tab ───────────────────────────────────────

function AppearanceTab() {
  const currentTheme = useThemeStore((s) => s.currentTheme);
  const themes = useThemeStore((s) => s.themes);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <div className="space-y-3">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">主题</div>
      <div className="grid grid-cols-2 gap-2">
        {themes.map((theme) => (
          <button
            key={theme.id}
            onClick={() => setTheme(theme.id)}
            className={cn(
              'flex items-center gap-3 rounded-md border p-2.5 text-left transition-colors',
              currentTheme === theme.id
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-accent',
            )}
          >
            {/* 色板预览 */}
            <span
              className="h-8 w-8 shrink-0 rounded-md border border-border"
              style={{ backgroundColor: theme.swatch }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground">{theme.name}</div>
              <div className="truncate text-[10px] text-muted-foreground">
                {theme.description}
              </div>
            </div>
            {currentTheme === theme.id && (
              <Check className="h-4 w-4 shrink-0 text-primary" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Credentials Tab (with inline model switcher) ───────

function CredentialsTab() {
  const credentials = useSettingsStore((s) => s.credentials);
  const loadCredentials = useSettingsStore((s) => s.loadCredentials);
  const setCredential = useSettingsStore((s) => s.setCredential);
  const deleteCredential = useSettingsStore((s) => s.deleteCredential);

  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const currentSession = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === s.currentSessionId),
  );
  const applyCredential = useSessionStore((s) => s.applyCredential);
  const [applyingProviderId, setApplyingProviderId] = useState<string | null>(null);

  const [providerId, setProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  const canSave = providerId.trim().length > 0 && apiKey.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    await setCredential({
      providerId: providerId.trim(),
      label: label.trim() || providerId.trim(),
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim() || undefined,
    });
    setProviderId('');
    setLabel('');
    setApiKey('');
    setBaseUrl('');
  };

  const handleApplyCredential = async (providerIdToApply: string) => {
    if (!currentSessionId) {
      console.warn('[SettingsPanel] handleApplyCredential: no currentSessionId — button should have been disabled');
      return;
    }
    if (applyingProviderId) {
      console.warn(`[SettingsPanel] handleApplyCredential: already applying "${applyingProviderId}", ignoring click`);
      return;
    }
    console.log(`[SettingsPanel] applyCredential: sessionId=${currentSessionId}, providerId=${providerIdToApply}`);
    setApplyingProviderId(providerIdToApply);
    try {
      await applyCredential(currentSessionId, providerIdToApply);
      console.log(`[SettingsPanel] applyCredential succeeded: providerId=${providerIdToApply}`);
    } catch (err) {
      console.error(`[SettingsPanel] applyCredential failed:`, err);
    } finally {
      setApplyingProviderId(null);
    }
  };

  const handleDelete = (providerIdToDelete: string, e: React.MouseEvent) => {
    e.stopPropagation();
    void deleteCredential(providerIdToDelete);
  };

  return (
    <div className="space-y-3">
      {/* Existing credentials — click a card to apply the whole config */}
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">已存储凭据</div>
        {credentials.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无凭据，请先配置 API Key</p>
        ) : (
          <div className="space-y-1">
            {credentials.map((c: CredentialEntry) => {
              const isCurrent = currentSession?.model?.providerId === c.providerId;
              const isApplying = applyingProviderId === c.providerId;
              const disabled = !currentSessionId || !!applyingProviderId;
              return (
                <div
                  key={c.providerId}
                  className={cn(
                    'flex items-center gap-2 rounded border bg-secondary/20 px-2 py-1.5 transition-colors',
                    isCurrent ? 'border-primary/40 bg-primary/5' : 'border-border/50',
                    !disabled && !isCurrent && 'hover:bg-accent/30',
                  )}
                >
                  <Key className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium">{c.label}</span>
                    <span className="ml-2 text-[10px] text-muted-foreground font-mono">{c.apiKeyMasked}</span>
                    {c.baseUrl && (
                      <span className="ml-2 text-[10px] text-muted-foreground/70 truncate">{c.baseUrl}</span>
                    )}
                  </div>
                  {isCurrent ? (
                    <span className="flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                      <Check className="h-2.5 w-2.5" />
                      当前
                    </span>
                  ) : (
                    <button
                      onClick={() => handleApplyCredential(c.providerId)}
                      disabled={disabled}
                      title={disabled ? (currentSessionId ? '正在切换...' : '请先创建 AI 会话') : '整体应用到当前会话'}
                      className={cn(
                        'flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors',
                        disabled
                          ? 'cursor-not-allowed bg-muted text-muted-foreground'
                          : 'bg-primary/10 text-primary hover:bg-primary/20',
                      )}
                    >
                      {isApplying ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : <Zap className="h-2.5 w-2.5" />}
                      {isApplying ? '切换中' : '应用'}
                    </button>
                  )}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => handleDelete(c.providerId, e)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleDelete(c.providerId, e as unknown as React.MouseEvent);
                      }
                    }}
                    title="删除凭据"
                    className="shrink-0 rounded p-0.5 text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3 w-3" />
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {!currentSessionId && credentials.length > 0 && (
          <p className="mt-1 text-[9px] text-muted-foreground/70">
            请先创建 AI 会话后再应用凭据
          </p>
        )}
      </div>

      {/* Add new credential */}
      <div className="rounded-md border border-border/50 bg-secondary/20 p-2">
        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">添加凭据</div>
        <div className="grid grid-cols-2 gap-1.5">
          <input
            type="text"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            placeholder="Provider ID (如 openai)"
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="标签（可选）"
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API Key"
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="Base URL（可选）"
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="mt-1.5 flex justify-end">
          <button
            onClick={handleSave}
            disabled={!canSave}
            className={cn(
              'flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
              canSave
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'cursor-not-allowed bg-muted text-muted-foreground',
            )}
          >
            <Save className="h-3 w-3" />
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Skills Tab ───────────────────────────────────────────

function SkillsTab() {
  const skills = useSettingsStore((s) => s.skills);
  const loadSkills = useSettingsStore((s) => s.loadSkills);
  const installSkill = useSettingsStore((s) => s.installSkill);
  const uninstallSkill = useSettingsStore((s) => s.uninstallSkill);

  const [skillName, setSkillName] = useState('');

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const handleInstall = async () => {
    if (!skillName.trim()) return;
    await installSkill(skillName.trim());
    setSkillName('');
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">已安装 Skills</div>
        {skills.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无已安装的 Skill</p>
        ) : (
          <div className="space-y-1">
            {skills.map((s) => (
              <div key={s} className="flex items-center gap-2 rounded border border-border/50 bg-secondary/20 px-2 py-1.5">
                <Package className="h-3 w-3 text-muted-foreground" />
                <span className="flex-1 text-xs font-mono">{s}</span>
                <button
                  onClick={() => uninstallSkill(s)}
                  className="rounded p-0.5 text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-md border border-border/50 bg-secondary/20 p-2">
        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">安装 Skill</div>
        <div className="flex gap-1">
          <input
            type="text"
            value={skillName}
            onChange={(e) => setSkillName(e.target.value)}
            placeholder="Skill 名称"
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleInstall}
            disabled={!skillName.trim()}
            className={cn(
              'flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
              skillName.trim()
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'cursor-not-allowed bg-muted text-muted-foreground',
            )}
          >
            <Plus className="h-3 w-3" />
            安装
          </button>
        </div>
      </div>
    </div>
  );
}

// ── MCP Tab ──────────────────────────────────────────────

function McpTab() {
  const setMcpConfig = useSettingsStore((s) => s.setMcpConfig);
  const loadMcpServers = useSettingsStore((s) => s.loadMcpServers);
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const [configText, setConfigText] = useState('{\n  "servers": []\n}');

  useEffect(() => {
    loadMcpServers();
  }, [loadMcpServers]);

  const handleSave = async () => {
    if (!currentProjectId) return;
    try {
      const config = JSON.parse(configText);
      await setMcpConfig(currentProjectId, config);
    } catch {
      // JSON parse error handled by toast
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">已配置 MCP 服务器</div>
        {mcpServers.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无 MCP 服务器</p>
        ) : (
          <div className="space-y-1">
            {mcpServers.map((s) => (
              <div key={s} className="flex items-center gap-2 rounded border border-border/50 bg-secondary/20 px-2 py-1.5">
                <Server className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-mono">{s}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-md border border-border/50 bg-secondary/20 p-2">
        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">MCP 配置 (JSON)</div>
        <textarea
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          rows={8}
          className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-primary"
        />
        <div className="mt-1.5 flex justify-end">
          <button
            onClick={handleSave}
            disabled={!currentProjectId}
            className={cn(
              'flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
              currentProjectId
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'cursor-not-allowed bg-muted text-muted-foreground',
            )}
          >
            <Save className="h-3 w-3" />
            保存配置
          </button>
        </div>
      </div>
    </div>
  );
}

// ── System Prompt Tab ────────────────────────────────────

function PromptTab() {
  const systemPrompt = useSettingsStore((s) => s.systemPrompt);
  const loadSystemPrompt = useSettingsStore((s) => s.loadSystemPrompt);
  const setSystemPrompt = useSettingsStore((s) => s.setSystemPrompt);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const [promptText, setPromptText] = useState('');

  useEffect(() => {
    if (currentProjectId) {
      loadSystemPrompt(currentProjectId).then(() => {
        setPromptText(useSettingsStore.getState().systemPrompt);
      });
    }
  }, [currentProjectId, loadSystemPrompt]);

  useEffect(() => {
    setPromptText(systemPrompt);
  }, [systemPrompt]);

  const handleSave = async () => {
    if (!currentProjectId) return;
    await setSystemPrompt(currentProjectId, promptText);
  };

  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">自定义系统提示词</div>
      <p className="text-[10px] text-muted-foreground">
        此提示词将附加到每个 AI 会话的系统消息中，用于定制 AI 的行为和上下文。
      </p>
      <textarea
        value={promptText}
        onChange={(e) => setPromptText(e.target.value)}
        rows={12}
        placeholder="输入自定义系统提示词..."
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={!currentProjectId}
          className={cn(
            'flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
            currentProjectId
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'cursor-not-allowed bg-muted text-muted-foreground',
          )}
        >
          <Save className="h-3 w-3" />
          保存
        </button>
      </div>
    </div>
  );
}
