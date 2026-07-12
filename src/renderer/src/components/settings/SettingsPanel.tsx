import { useEffect, useState } from 'react';
import { X, Key, Package, Server, FileText, Plus, Trash2, Save, Download, Upload } from 'lucide-react';
import { useSettingsStore } from '@renderer/stores/settings';
import { useProjectStore } from '@renderer/stores/project';
import { useUiStore } from '@renderer/stores/ui';
import { cn } from '@renderer/lib/utils';
import type { CredentialEntry } from '@shared/types';

type SettingsTab = 'credentials' | 'skills' | 'mcp' | 'prompt';

export function SettingsPanel() {
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<SettingsTab>('credentials');

  if (!settingsOpen) return null;

  const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Key }> = [
    { id: 'credentials', label: '凭据管理', icon: Key },
    { id: 'skills', label: 'Skill 管理', icon: Package },
    { id: 'mcp', label: 'MCP 配置', icon: Server },
    { id: 'prompt', label: '系统提示词', icon: FileText },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex h-[480px] w-[640px] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
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
          {tab === 'credentials' && <CredentialsTab />}
          {tab === 'skills' && <SkillsTab />}
          {tab === 'mcp' && <McpTab />}
          {tab === 'prompt' && <PromptTab />}
        </div>
      </div>
    </div>
  );
}

// ── Credentials Tab ──────────────────────────────────────

function CredentialsTab() {
  const credentials = useSettingsStore((s) => s.credentials);
  const loadCredentials = useSettingsStore((s) => s.loadCredentials);
  const setCredential = useSettingsStore((s) => s.setCredential);
  const deleteCredential = useSettingsStore((s) => s.deleteCredential);

  const [providerId, setProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('');

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  const handleSave = async () => {
    if (!providerId.trim() || !apiKey.trim()) return;
    await setCredential({
      providerId: providerId.trim(),
      label: label.trim() || providerId.trim(),
      apiKey: apiKey.trim(),
      endpoint: endpoint.trim() || undefined,
    });
    setProviderId('');
    setLabel('');
    setApiKey('');
    setEndpoint('');
  };

  return (
    <div className="space-y-3">
      {/* Existing credentials */}
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">已存储凭据</div>
        {credentials.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无凭据</p>
        ) : (
          <div className="space-y-1">
            {credentials.map((c: CredentialEntry) => (
              <div key={c.providerId} className="flex items-center gap-2 rounded border border-border/50 bg-secondary/20 px-2 py-1.5">
                <Key className="h-3 w-3 text-muted-foreground" />
                <div className="flex-1">
                  <span className="text-xs font-medium">{c.label}</span>
                  <span className="ml-2 text-[10px] text-muted-foreground font-mono">{c.apiKeyMasked}</span>
                  {c.endpoint && <span className="ml-2 text-[10px] text-muted-foreground/70">{c.endpoint}</span>}
                </div>
                <button
                  onClick={() => deleteCredential(c.providerId)}
                  className="rounded p-0.5 text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
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
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="Endpoint（可选）"
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="mt-1.5 flex justify-end">
          <button
            onClick={handleSave}
            disabled={!providerId.trim() || !apiKey.trim()}
            className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-30"
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
            className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-30"
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
            className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-30"
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
          className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-30"
        >
          <Save className="h-3 w-3" />
          保存
        </button>
      </div>
    </div>
  );
}
