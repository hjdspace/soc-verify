import { useEffect, useState } from 'react';
import { X, Key, Package, Server, FileText, Plus, Trash2, Save, Download, Upload, Palette, Check, Cpu, RefreshCw, Zap, Info, BookOpen, Folder, ChevronDown, ChevronRight, Pencil, Terminal, Globe, Power, Loader2, Wrench } from 'lucide-react';
import { useSettingsStore } from '@renderer/stores/settings';
import { useProjectStore } from '@renderer/stores/project';
import { useUiStore } from '@renderer/stores/ui';
import { useThemeStore } from '@renderer/stores/theme';
import { useSessionStore } from '@renderer/stores/session';
import { cn } from '@renderer/lib/utils';
import { MarkdownRenderer } from '@renderer/components/chat/MarkdownRenderer';
import type { CredentialEntry, SkillInfo, CreateSkillInput, McpConfigFile, McpServerConfig, McpTransportType, McpServerInfo, McpToolInfo } from '@shared/types';

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
  const updateCredential = useSettingsStore((s) => s.updateCredential);
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
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  const isEditing = editingProviderId !== null;
  // In add mode: providerId + apiKey are required.
  // In edit mode: only providerId is required (apiKey optional — empty keeps existing).
  const canSave = isEditing
    ? providerId.trim().length > 0
    : providerId.trim().length > 0 && apiKey.trim().length > 0;

  const resetForm = () => {
    setProviderId('');
    setLabel('');
    setApiKey('');
    setBaseUrl('');
    setEditingProviderId(null);
  };

  const handleSave = async () => {
    if (!canSave) return;
    if (isEditing) {
      await updateCredential({
        providerId: providerId.trim(),
        label: label.trim(),
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
      });
    } else {
      await setCredential({
        providerId: providerId.trim(),
        label: label.trim() || providerId.trim(),
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
      });
    }
    resetForm();
  };

  const handleEdit = (c: CredentialEntry) => {
    setEditingProviderId(c.providerId);
    setProviderId(c.providerId);
    setLabel(c.label);
    setApiKey('');
    setBaseUrl(c.baseUrl ?? '');
  };

  const handleCancelEdit = () => {
    resetForm();
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
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEdit(c);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        handleEdit(c);
                      }
                    }}
                    title="编辑凭据"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="h-3 w-3" />
                  </span>
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

      {/* Add / Edit credential */}
      <div className="rounded-md border border-border/50 bg-secondary/20 p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase text-muted-foreground">
            {isEditing ? '编辑凭据' : '添加凭据'}
          </span>
          {isEditing && (
            <button
              onClick={handleCancelEdit}
              className="text-muted-foreground hover:text-foreground"
              title="取消编辑"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <input
            type="text"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            placeholder="Provider ID (如 openai)"
            disabled={isEditing}
            className={cn(
              'rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary',
              isEditing && 'cursor-not-allowed opacity-60',
            )}
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
            placeholder={isEditing ? 'API Key（留空保持不变）' : 'API Key'}
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
        <div className="mt-1.5 flex justify-end gap-1">
          {isEditing && (
            <button
              onClick={handleCancelEdit}
              className="rounded px-2.5 py-1 text-[10px] text-muted-foreground hover:bg-secondary/50"
            >
              取消
            </button>
          )}
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
            {isEditing ? '更新' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Skills Tab ───────────────────────────────────────────

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  builtin: { label: '内置', color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  user: { label: '用户级', color: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  project: { label: '项目级', color: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' },
};

function SkillSourceBadge({ source }: { source: string }) {
  const info = SOURCE_LABELS[source] ?? { label: source, color: 'bg-muted text-muted-foreground' };
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-medium', info.color)}>
      {info.label}
    </span>
  );
}

function SkillCard({ skill, onUninstall }: {
  skill: SkillInfo;
  onUninstall: (name: string) => void;
}) {
  const canDelete = skill.source === 'user';
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const readSkillContent = useSettingsStore((s) => s.readSkillContent);

  const handleToggle = async () => {
    if (!expanded && content === null) {
      setLoading(true);
      const text = await readSkillContent(skill.filePath);
      setContent(text);
      setLoading(false);
    }
    setExpanded(!expanded);
  };

  return (
    <div className="rounded border border-border/50 bg-secondary/20">
      <div
        className="flex cursor-pointer items-start gap-2 px-2 py-1.5 hover:bg-secondary/30"
        onClick={handleToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggle();
          }
        }}
      >
        <Package className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-mono font-medium">{skill.name}</span>
            <SkillSourceBadge source={skill.source} />
          </div>
          {skill.description && (
            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{skill.description}</p>
          )}
        </div>
        {loading && <RefreshCw className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
        {!loading && (
          <ChevronRight className={cn('mt-0.5 h-3 w-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
        )}
        {canDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onUninstall(skill.name);
            }}
            className="shrink-0 rounded p-0.5 text-destructive hover:bg-destructive/10"
            title="卸载技能"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      {expanded && content !== null && (
        <div className="border-t border-border/30 px-2 py-2">
          <div className="mb-1 flex items-center gap-1 text-[9px] text-muted-foreground/70">
            <FileText className="h-2.5 w-2.5" />
            <span className="font-mono">{skill.filePath}</span>
          </div>
          <div className="markdown-body max-h-64 overflow-auto text-[11px] leading-relaxed text-foreground/80">
            <MarkdownRenderer content={content} />
          </div>
        </div>
      )}
    </div>
  );
}

function CreateSkillForm({ onCreate }: {
  onCreate: (input: CreateSkillInput) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [expanded, setExpanded] = useState(false);

  const nameValid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name.trim());
  const canSubmit = nameValid && description.trim() && body.trim();

  const handleSubmit = async () => {
    if (!canSubmit) return;
    onCreate({ name: name.trim(), description: description.trim(), body: body.trim() });
    setName('');
    setDescription('');
    setBody('');
    setExpanded(false);
  };

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-1.5 rounded border border-dashed border-border/50 px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary/30"
      >
        <Pencil className="h-3 w-3" />
        创建新技能
      </button>
    );
  }

  return (
    <div className="space-y-1.5 rounded border border-border/50 bg-secondary/20 p-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase text-muted-foreground">创建新技能</span>
        <button
          onClick={() => setExpanded(false)}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="技能名称（kebab-case，如 my-skill）"
          className={cn(
            'w-full rounded border bg-background px-2 py-1 text-xs outline-none focus:ring-1',
            name && !nameValid
              ? 'border-destructive focus:ring-destructive'
              : 'border-border focus:ring-primary',
          )}
        />
        {name && !nameValid && (
          <p className="mt-0.5 text-[10px] text-destructive">
            仅允许小写字母、数字和连字符（1-64 字符，以字母或数字开头）
          </p>
        )}
      </div>
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="技能描述（一行，用于技能发现）"
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="技能内容（Markdown 格式，无需包含 frontmatter）"
        rows={4}
        className="w-full resize-y rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="flex justify-end gap-1">
        <button
          onClick={() => setExpanded(false)}
          className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-secondary/50"
        >
          取消
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={cn(
            'flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
            canSubmit
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'cursor-not-allowed bg-muted text-muted-foreground',
          )}
        >
          <Plus className="h-3 w-3" />
          创建
        </button>
      </div>
    </div>
  );
}

function SkillDirectoryList({ directories }: {
  directories: NonNullable<ReturnType<typeof useSettingsStore.getState>['skillInstallInfo']>['directories'];
}) {
  return (
    <div className="space-y-1">
      {directories.map((dir) => (
        <div key={dir.path} className="flex items-center gap-1.5 text-[11px]">
          <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">{dir.label}</span>
          <span
            className={cn(
              'ml-auto truncate font-mono text-[10px]',
              dir.exists ? 'text-foreground/70' : 'text-muted-foreground/50',
            )}
            title={dir.path}
          >
            {dir.path}
          </span>
          <span
            className={cn(
              'shrink-0 rounded px-1 py-0.5 text-[9px]',
              dir.exists
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {dir.exists ? '存在' : '不存在'}
          </span>
        </div>
      ))}
    </div>
  );
}

function SkillsTab() {
  const skills = useSettingsStore((s) => s.skills);
  const loadSkills = useSettingsStore((s) => s.loadSkills);
  const createSkill = useSettingsStore((s) => s.createSkill);
  const uninstallSkill = useSettingsStore((s) => s.uninstallSkill);
  const skillInstallInfo = useSettingsStore((s) => s.skillInstallInfo);
  const loadSkillInstallInfo = useSettingsStore((s) => s.loadSkillInstallInfo);

  const [showGuidance, setShowGuidance] = useState(false);

  useEffect(() => {
    loadSkills();
    loadSkillInstallInfo();
  }, [loadSkills, loadSkillInstallInfo]);

  // Group skills by source
  const builtinSkills = skills.filter((s) => s.source === 'builtin');
  const userSkills = skills.filter((s) => s.source === 'user');
  const projectSkills = skills.filter((s) => s.source === 'project');

  return (
    <div className="space-y-3">
      {/* Installed Skills */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase text-muted-foreground">
            已安装技能（{skills.length}）
          </span>
          <button
            onClick={() => { loadSkills(); loadSkillInstallInfo(); }}
            className="text-muted-foreground hover:text-foreground"
            title="刷新"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        {skills.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂未发现任何技能</p>
        ) : (
          <div className="space-y-2">
            {builtinSkills.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-muted-foreground/70">内置技能（{builtinSkills.length}）</div>
                {builtinSkills.map((s) => (
                  <SkillCard key={s.filePath} skill={s} onUninstall={uninstallSkill} />
                ))}
              </div>
            )}
            {userSkills.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-muted-foreground/70">用户级技能（{userSkills.length}）</div>
                {userSkills.map((s) => (
                  <SkillCard key={s.filePath} skill={s} onUninstall={uninstallSkill} />
                ))}
              </div>
            )}
            {projectSkills.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-muted-foreground/70">项目级技能（{projectSkills.length}）</div>
                {projectSkills.map((s) => (
                  <SkillCard key={s.filePath} skill={s} onUninstall={uninstallSkill} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create Skill */}
      <CreateSkillForm onCreate={createSkill} />

      {/* Guidance & Directory Info */}
      <div className="rounded-md border border-border/50 bg-secondary/20">
        <button
          onClick={() => setShowGuidance(!showGuidance)}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold uppercase text-muted-foreground hover:bg-secondary/30"
        >
          {showGuidance ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <Info className="h-3 w-3" />
          技能安装指南
        </button>
        {showGuidance && (
          <div className="space-y-2 border-t border-border/30 px-2 py-2">
            {skillInstallInfo && (
              <>
                <div>
                  <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                    <BookOpen className="h-3 w-3" />
                    如何安装技能
                  </div>
                  <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                    {skillInstallInfo.guidance}
                  </pre>
                </div>
                <div>
                  <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                    <Folder className="h-3 w-3" />
                    技能扫描目录
                  </div>
                  <SkillDirectoryList directories={skillInstallInfo.directories} />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── MCP Tab ──────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  connected: 'bg-green-500',
  connecting: 'bg-yellow-500 animate-pulse',
  disconnected: 'bg-red-500',
  not_running: 'bg-muted-foreground/40',
};

const STATUS_LABELS: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  disconnected: '已断开',
  not_running: '未运行',
};

/** Form state for editing a single MCP server. */
type ServerFormState = {
  name: string;
  transport: McpTransportType;
  command: string;
  args: string;
  url: string;
  enabled: boolean;
};

function serverToForm(name: string, config: McpServerConfig): ServerFormState {
  return {
    name,
    transport: config.type ?? (config.url ? 'http' : 'stdio'),
    command: config.command ?? '',
    args: (config.args ?? []).join(' '),
    url: config.url ?? '',
    enabled: config.enabled !== false,
  };
}

function formToServerConfig(form: ServerFormState): McpServerConfig {
  if (form.transport === 'stdio') {
    return {
      type: 'stdio',
      command: form.command || undefined,
      args: form.args.trim() ? form.args.trim().split(/\s+/) : undefined,
      enabled: form.enabled,
    };
  }
  return {
    type: form.transport,
    url: form.url || undefined,
    enabled: form.enabled,
  };
}

function McpTab() {
  const setMcpConfig = useSettingsStore((s) => s.setMcpConfig);
  const loadMcpServers = useSettingsStore((s) => s.loadMcpServers);
  const loadMcpConfig = useSettingsStore((s) => s.loadMcpConfig);
  const reloadMcp = useSettingsStore((s) => s.reloadMcp);
  const mcpReloading = useSettingsStore((s) => s.mcpReloading);
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const mcpConfig = useSettingsStore((s) => s.mcpConfig);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const [editing, setEditing] = useState(false);
  const [servers, setServers] = useState<Record<string, McpServerConfig>>({});
  const [newServer, setNewServer] = useState<ServerFormState | null>(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (currentProjectId) {
      loadMcpServers(currentProjectId);
      loadMcpConfig(currentProjectId);
    }
  }, [currentProjectId, loadMcpServers, loadMcpConfig]);

  // Sync config into local editing state when not editing
  useEffect(() => {
    if (!editing && mcpConfig) {
      setServers(mcpConfig.mcpServers ?? {});
    }
  }, [mcpConfig, editing]);

  const handleAddServer = () => {
    setNewServer({
      name: '',
      transport: 'stdio',
      command: '',
      args: '',
      url: '',
      enabled: true,
    });
  };

  const handleConfirmAdd = () => {
    if (!newServer || !newServer.name.trim()) return;
    setServers((prev) => ({
      ...prev,
      [newServer.name.trim()]: formToServerConfig(newServer),
    }));
    setNewServer(null);
    setEditing(true);
  };

  const handleRemoveServer = (name: string) => {
    setServers((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    setEditing(true);
  };

  const handleToggleEnabled = (name: string) => {
    setServers((prev) => ({
      ...prev,
      [name]: { ...prev[name], enabled: !prev[name]?.enabled },
    }));
    setEditing(true);
  };

  const handleUpdateServer = (name: string, config: McpServerConfig) => {
    setServers((prev) => ({ ...prev, [name]: config }));
    setEditing(true);
  };

  const handleSave = async () => {
    if (!currentProjectId) return;
    const config: McpConfigFile = { mcpServers: servers };
    await setMcpConfig(currentProjectId, config);
    setEditing(false);
  };

  const handleSaveJson = async () => {
    if (!currentProjectId) return;
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      // Accept two input shapes:
      //   1. { "mcpServers": { "name": {...} } }  ← canonical .mcp.json format
      //   2. { "name": {...}, ... }               ← bare server map (user-friendly)
      // If the top-level object has no `mcpServers` key but its values look
      // like server configs (plain objects), wrap them automatically.
      let config: McpConfigFile;
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        config = parsed as unknown as McpConfigFile;
      } else {
        // Treat the whole object as a server map
        const serverEntries = Object.entries(parsed).filter(
          ([k, v]) => k !== '$schema' && typeof v === 'object' && v !== null,
        );
        config = { mcpServers: Object.fromEntries(serverEntries) as Record<string, McpServerConfig> };
      }
      await setMcpConfig(currentProjectId, config);
      setJsonMode(false);
    } catch {
      // JSON parse error
    }
  };

  const handleLoadJson = () => {
    // Load in the user-friendly bare server map format so users can edit
    // servers directly without the `mcpServers` wrapper. handleSaveJson
    // accepts both shapes.
    setJsonText(JSON.stringify(servers, null, 2));
    setJsonMode(true);
  };

  const handleRefresh = () => {
    if (currentProjectId) loadMcpServers(currentProjectId);
  };

  const handleReloadMcp = () => {
    if (currentProjectId) reloadMcp(currentProjectId);
  };

  const toggleExpand = (name: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {/* Server List */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase text-muted-foreground">已配置 MCP 服务器</div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleReloadMcp}
              disabled={!currentProjectId || mcpReloading}
              className={cn(
                'flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                currentProjectId && !mcpReloading
                  ? 'text-primary hover:bg-primary/10'
                  : 'cursor-not-allowed text-muted-foreground/50',
              )}
              title="重载 MCP（让运行中的会话立即应用新配置）"
            >
              <RefreshCw className={cn('h-3 w-3', mcpReloading && 'animate-spin')} />
              {mcpReloading ? '重载中…' : '重载'}
            </button>
            <button
              onClick={handleRefresh}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="刷新列表"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
            <button
              onClick={handleAddServer}
              disabled={!currentProjectId}
              className={cn(
                'flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                currentProjectId
                  ? 'text-primary hover:bg-primary/10'
                  : 'cursor-not-allowed text-muted-foreground/50',
              )}
            >
              <Plus className="h-3 w-3" />
              添加
            </button>
          </div>
        </div>

        {mcpServers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            暂无 MCP 服务器。点击「添加」按钮配置，或编辑 JSON 配置。
          </p>
        ) : (
          <div className="space-y-1">
            {mcpServers.map((s) => (
              <McpServerRow
                key={s.name}
                server={s}
                projectId={currentProjectId}
                expanded={expandedServers.has(s.name)}
                onToggleExpand={() => toggleExpand(s.name)}
                onToggleEnabled={() => handleToggleEnabled(s.name)}
                onRemove={() => handleRemoveServer(s.name)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add new server form */}
      {newServer && (
        <div className="rounded-md border border-primary/30 bg-secondary/20 p-2.5 space-y-2">
          <div className="text-[10px] font-semibold uppercase text-primary">添加 MCP 服务器</div>
          <input
            value={newServer.name}
            onChange={(e) => setNewServer({ ...newServer, name: e.target.value })}
            placeholder="服务器名称（如 filesystem）"
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-muted-foreground">传输方式</label>
            <select
              value={newServer.transport}
              onChange={(e) => setNewServer({ ...newServer, transport: e.target.value as McpTransportType })}
              className="rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="stdio">stdio (本地命令)</option>
              <option value="http">http (HTTP 服务器)</option>
              <option value="sse">sse (SSE 服务器)</option>
            </select>
          </div>
          {newServer.transport === 'stdio' ? (
            <>
              <input
                value={newServer.command}
                onChange={(e) => setNewServer({ ...newServer, command: e.target.value })}
                placeholder="命令（如 npx）"
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
              />
              <input
                value={newServer.args}
                onChange={(e) => setNewServer({ ...newServer, args: e.target.value })}
                placeholder="参数（空格分隔，如 -y @modelcontextprotocol/server-filesystem /tmp）"
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
              />
            </>
          ) : (
            <input
              value={newServer.url}
              onChange={(e) => setNewServer({ ...newServer, url: e.target.value })}
              placeholder="URL（如 https://api.example.com/mcp）"
              className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
            />
          )}
          <div className="flex justify-end gap-1.5">
            <button
              onClick={() => setNewServer(null)}
              className="rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
            >
              取消
            </button>
            <button
              onClick={handleConfirmAdd}
              disabled={!newServer.name.trim()}
              className={cn(
                'flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                newServer.name.trim()
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'cursor-not-allowed bg-muted text-muted-foreground',
              )}
            >
              <Check className="h-3 w-3" />
              确认
            </button>
          </div>
        </div>
      )}

      {/* Inline editing of existing servers */}
      {editing && Object.keys(servers).length > 0 && (
        <div className="rounded-md border border-border/50 bg-secondary/20 p-2 space-y-1.5">
          <div className="text-[10px] font-semibold uppercase text-muted-foreground">编辑服务器配置</div>
          {Object.entries(servers).map(([name, config]) => (
            <ServerEditRow
              key={name}
              name={name}
              config={config}
              onChange={(c) => handleUpdateServer(name, c)}
            />
          ))}
        </div>
      )}

      {/* JSON mode editor / actions */}
      <div className="rounded-md border border-border/50 bg-secondary/20 p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase text-muted-foreground">
            {jsonMode ? 'JSON 配置编辑' : '高级操作'}
          </div>
          {!jsonMode && (
            <button
              onClick={handleLoadJson}
              disabled={!currentProjectId}
              className={cn(
                'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                currentProjectId
                  ? 'text-primary hover:bg-primary/10'
                  : 'cursor-not-allowed text-muted-foreground/50',
              )}
            >
              <FileText className="h-3 w-3" />
              JSON 模式
            </button>
          )}
        </div>

        {jsonMode ? (
          <>
            <p className="mb-1.5 text-[10px] text-muted-foreground">
              格式: <code className="font-mono">{'{ "mcpServers": { ... } }'}</code>
            </p>
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              rows={10}
              spellCheck={false}
              className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="mt-1.5 flex justify-end gap-1.5">
              <button
                onClick={() => setJsonMode(false)}
                className="rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
              >
                取消
              </button>
              <button
                onClick={handleSaveJson}
                disabled={!currentProjectId}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                  currentProjectId
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'cursor-not-allowed bg-muted text-muted-foreground',
                )}
              >
                <Save className="h-3 w-3" />
                保存 JSON
              </button>
            </div>
          </>
        ) : (
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={!currentProjectId || !editing}
              className={cn(
                'flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
                currentProjectId && editing
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'cursor-not-allowed bg-muted text-muted-foreground',
              )}
            >
              <Save className="h-3 w-3" />
              保存配置
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A single MCP server row with expandable tool list. */
function McpServerRow({
  server,
  projectId,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onRemove,
}: {
  server: McpServerInfo;
  projectId: string | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: () => void;
  onRemove: () => void;
}) {
  const getMcpServerTools = useSettingsStore((s) => s.getMcpServerTools);
  const tools = useSettingsStore((s) => s.mcpToolsByServer[server.name]);
  const toolsLoading = useSettingsStore((s) => s.mcpToolsLoading[server.name] ?? false);

  // Load tools on first expand (only if connected and we don't have them yet)
  useEffect(() => {
    if (expanded && projectId && server.status === 'connected' && tools === undefined && !toolsLoading) {
      getMcpServerTools(projectId, server.name);
    }
  }, [expanded, projectId, server.name, server.status, tools, toolsLoading, getMcpServerTools]);

  const canExpand = server.status === 'connected' && server.toolCount > 0;

  return (
    <div className="rounded border border-border/50 bg-secondary/20">
      <div className="flex items-center gap-2 px-2 py-1.5">
        {/* Expand toggle (only for connected servers with tools) */}
        {canExpand ? (
          <button
            onClick={onToggleExpand}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={expanded ? '折叠工具列表' : '展开工具列表'}
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : (
          <div className="w-4 shrink-0" />
        )}

        {/* Status indicator */}
        <div
          className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_COLORS[server.status])}
          title={STATUS_LABELS[server.status]}
        />

        {/* Transport icon */}
        {server.transport === 'stdio' ? (
          <Terminal className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}

        {/* Name + summary */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-xs font-medium">{server.name}</span>
            {!server.enabled && (
              <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">已禁用</span>
            )}
            <span className={cn(
              'rounded px-1 py-0.5 text-[9px] font-medium',
              server.status === 'connected'
                ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                : server.status === 'connecting'
                  ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
                  : 'bg-muted text-muted-foreground',
            )}>
              {STATUS_LABELS[server.status]}
            </span>
            {server.toolCount > 0 && (
              <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground">
                <Wrench className="h-2.5 w-2.5" />
                {server.toolCount}
              </span>
            )}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{server.summary}</div>
          {server.status === 'disconnected' && (
            <div className="text-[9px] text-destructive/70">
              连接失败
            </div>
          )}
        </div>

        {/* Source badge */}
        <span className={cn(
          'shrink-0 rounded px-1 py-0.5 text-[9px] font-medium',
          server.source === 'project' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}>
          {server.source === 'project' ? '项目' : '用户'}
        </span>

        {/* Toggle enabled */}
        <button
          onClick={onToggleEnabled}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={server.enabled ? '禁用' : '启用'}
        >
          <Power className={cn('h-3 w-3', server.enabled ? 'text-green-500' : 'text-muted-foreground/40')} />
        </button>

        {/* Remove (only for project-level servers) */}
        {server.source === 'project' && (
          <button
            onClick={onRemove}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="删除"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Expanded tool list */}
      {expanded && canExpand && (
        <div className="border-t border-border/30 bg-background/30 px-2 py-1.5">
          {toolsLoading ? (
            <div className="flex items-center gap-1.5 py-1 text-[10px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              加载工具列表…
            </div>
          ) : tools && tools.length > 0 ? (
            <div className="space-y-0.5">
              {tools.map((tool) => (
                <div key={tool.name} className="rounded px-1.5 py-1 hover:bg-accent/30">
                  <div className="flex items-center gap-1.5">
                    <Wrench className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                    <span className="font-mono text-[10px] font-medium text-foreground">{tool.name}</span>
                  </div>
                  {tool.description && (
                    <p className="ml-4 mt-0.5 text-[9px] leading-tight text-muted-foreground line-clamp-2">
                      {tool.description}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="py-1 text-[10px] text-muted-foreground">该服务器未暴露任何工具</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline editing row for a single MCP server. */
function ServerEditRow({
  name,
  config,
  onChange,
}: {
  name: string;
  config: McpServerConfig;
  onChange: (config: McpServerConfig) => void;
}) {
  const [form, setForm] = useState(() => serverToForm(name, config));

  const update = (patch: Partial<ServerFormState>) => {
    const next = { ...form, ...patch };
    setForm(next);
    onChange(formToServerConfig(next));
  };

  return (
    <div className="rounded border border-border/30 bg-background/50 p-1.5 space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] font-medium">{name}</span>
        <select
          value={form.transport}
          onChange={(e) => update({ transport: e.target.value as McpTransportType })}
          className="rounded border border-border bg-background px-1 py-0.5 text-[10px] outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="stdio">stdio</option>
          <option value="http">http</option>
          <option value="sse">sse</option>
        </select>
      </div>
      {form.transport === 'stdio' ? (
        <>
          <input
            value={form.command}
            onChange={(e) => update({ command: e.target.value })}
            placeholder="command"
            className="w-full rounded border border-border/50 bg-background px-1.5 py-0.5 font-mono text-[10px] outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            value={form.args}
            onChange={(e) => update({ args: e.target.value })}
            placeholder="args (space-separated)"
            className="w-full rounded border border-border/50 bg-background px-1.5 py-0.5 font-mono text-[10px] outline-none focus:ring-1 focus:ring-primary"
          />
        </>
      ) : (
        <input
          value={form.url}
          onChange={(e) => update({ url: e.target.value })}
          placeholder="url"
          className="w-full rounded border border-border/50 bg-background px-1.5 py-0.5 font-mono text-[10px] outline-none focus:ring-1 focus:ring-primary"
        />
      )}
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
