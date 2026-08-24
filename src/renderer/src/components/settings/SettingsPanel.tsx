import { useState } from 'react';
import { X, Key, Cpu, BookOpen, FileText, Wrench, Puzzle, Package, Server, Palette, Keyboard, Clock } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import { cn } from '@renderer/lib/utils';
import { PluginsTab } from './PluginsTab';
import { KbSettingsTab } from './KbSettingsTab';
import { AgentToolsTab } from './AgentToolsTab';
import { ShortcutsTab } from './ShortcutsTab';
import { PromptTab } from './PromptTab';
import { TimingViolationConfigTab } from './TimingViolationConfigTab';
import { AppearanceTab } from './AppearanceTab';
import { SkillsTab } from './SkillsTab';
import { CredentialsTab } from './CredentialsTab';
import { McpTab } from './McpTab';

type SettingsTab = 'credentials' | 'kb' | 'plugins' | 'skills' | 'mcp' | 'prompt' | 'agent-tools' | 'appearance' | 'shortcuts' | 'timing-violation';

export function SettingsPanel() {
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<SettingsTab>('credentials');
const sessions = useSessionCoreStore((s) => s.sessions);
const currentSessionId = useSessionCoreStore((s) => s.currentSessionId);
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const currentModel = currentSession?.model;

  if (!settingsOpen) return null;

  const navGroups: Array<{ label: string; items: Array<{ id: SettingsTab; label: string; icon: typeof Key }> }> = [
    {
      label: 'AI 能力',
      items: [
        { id: 'credentials', label: '模型配置', icon: Cpu },
        { id: 'kb', label: '知识库', icon: BookOpen },
        { id: 'prompt', label: '系统提示词', icon: FileText },
        { id: 'agent-tools', label: 'Agent 工具', icon: Wrench },
      ],
    },
    {
      label: '扩展',
      items: [
        { id: 'plugins', label: '插件管理', icon: Puzzle },
        { id: 'skills', label: 'Skill 管理', icon: Package },
        { id: 'mcp', label: 'MCP 配置', icon: Server },
      ],
    },
    {
      label: '环境',
      items: [
        { id: 'appearance', label: '外观', icon: Palette },
        { id: 'shortcuts', label: '快捷键', icon: Keyboard },
        { id: 'timing-violation', label: '时序违例', icon: Clock },
      ],
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex h-[620px] max-h-[calc(100vh-32px)] w-[960px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-semibold">设置</h2>
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">SoC Verify</span>
          </div>
          <button
            onClick={() => setSettingsOpen(false)}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左侧垂直导航（分组） */}
          <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r bg-accent/30 p-2">
            {navGroups.map((group) => (
              <div key={group.label}>
                <div className="px-2.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  {group.label}
                </div>
                {group.items.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-xs transition-colors',
                      tab === t.id
                        ? 'bg-primary/15 font-medium text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    <t.icon className="h-4 w-4 shrink-0" />
                    {t.label}
                  </button>
                ))}
              </div>
            ))}

            {/* 底部会话信息卡 */}
            <div className="mt-auto p-2 pt-4">
              <div className="rounded-md border border-border/50 bg-background/60 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
                当前模型：
                <span className="text-foreground">
                  {currentModel ? `${currentModel.provider} · ${currentModel.name || currentModel.id}` : '未设置'}
                </span>
                <br />
                会话数：<span className="text-foreground">{sessions.length}</span>
              </div>
            </div>
          </nav>

          {/* Content */}
          <div key={tab} className="min-w-0 flex-1 animate-in fade-in slide-in-from-bottom-1 duration-200 overflow-y-auto p-6">
            {tab === 'appearance' && <AppearanceTab />}
            {tab === 'shortcuts' && <ShortcutsTab />}
            {tab === 'credentials' && <CredentialsTab />}
            {tab === 'kb' && <KbSettingsTab />}
            {tab === 'plugins' && <PluginsTab />}
            {tab === 'skills' && <SkillsTab />}
            {tab === 'mcp' && <McpTab />}
            {tab === 'prompt' && <PromptTab />}
            {tab === 'agent-tools' && <AgentToolsTab />}
            {tab === 'timing-violation' && <TimingViolationConfigTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
