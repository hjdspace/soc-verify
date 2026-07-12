import { useEffect, useState } from 'react';
import { FileText, Terminal as TerminalIcon, Sparkles, X } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

type CenterTab = {
  id: string;
  type: 'file' | 'terminal' | 'ai-artifacts';
  title: string;
  closable: boolean;
};

export function CenterArea() {
  const centerView = useUiStore((s) => s.centerView);
  const selectedFile = useUiStore((s) => s.selectedFile);
  const setCenterView = useUiStore((s) => s.setCenterView);
  const activeCenterTab = useUiStore((s) => s.activeCenterTab);
  const setActiveCenterTab = useUiStore((s) => s.setActiveCenterTab);

  const [tabs, setTabs] = useState<CenterTab[]>([]);
  const [fileContent, setFileContent] = useState<string>('');
  const [loadingContent, setLoadingContent] = useState(false);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  // Sync tabs with active center tab
  useEffect(() => {
    if (!activeCenterTab) return;

    if (activeCenterTab.startsWith('file:')) {
      const name = activeCenterTab.slice(5);
      if (!tabs.find((t) => t.id === activeCenterTab)) {
        setTabs((prev) => [...prev, { id: activeCenterTab, type: 'file', title: name, closable: true }]);
      }
      setCenterView('file');
    }
  }, [activeCenterTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load file content when selectedFile changes
  useEffect(() => {
    if (!selectedFile || !currentProjectId) return;
    let cancelled = false;
    setLoadingContent(true);
    trpc.project.readFile
      .query({ projectId: currentProjectId, filePath: selectedFile.path })
      .then((content) => {
        if (!cancelled) setFileContent(content);
      })
      .catch((err) => {
        if (!cancelled) setFileContent(`Error loading file: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingContent(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFile, currentProjectId]);

  const closeTab = (tabId: string) => {
    setTabs((prev) => {
      const filtered = prev.filter((t) => t.id !== tabId);
      if (activeCenterTab === tabId) {
        const next = filtered[filtered.length - 1];
        setActiveCenterTab(next?.id ?? null);
        setCenterView(next ? next.type : 'empty');
      }
      return filtered;
    });
  };

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      {/* ── Tab bar ────────────────────────────────── */}
      <div className="flex h-8 shrink-0 items-center border-b bg-secondary/30">
        {tabs.length === 0 ? (
          <div className="px-3 text-[10px] text-muted-foreground">
            多功能工作区 — 点击左栏文件或使用下方按钮
          </div>
        ) : (
          <div className="flex h-full flex-1 overflow-x-auto">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={cn(
                  'flex h-full shrink-0 items-center gap-1.5 border-r px-3 text-xs transition-colors',
                  activeCenterTab === tab.id
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:bg-background/50',
                )}
                onClick={() => {
                  setActiveCenterTab(tab.id);
                  setCenterView(tab.type);
                }}
              >
                {tab.type === 'file' && <FileText className="h-3 w-3 opacity-50" />}
                {tab.type === 'terminal' && <TerminalIcon className="h-3 w-3 opacity-50" />}
                {tab.type === 'ai-artifacts' && <Sparkles className="h-3 w-3 opacity-50" />}
                <span className="max-w-32 truncate">{tab.title}</span>
                {tab.closable && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className="ml-1 rounded p-0.5 opacity-50 transition-opacity hover:bg-foreground/10 hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Content area ─────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {centerView === 'file' && selectedFile ? (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b bg-secondary/20 px-3 py-1">
              <span className="text-xs text-muted-foreground">{selectedFile.path}</span>
            </div>
            <div className="flex-1 overflow-auto">
              {loadingContent ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  加载中...
                </div>
              ) : (
                <pre className="px-3 py-2 text-xs leading-relaxed">
                  <code>{fileContent}</code>
                </pre>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <div className="flex gap-2">
              <button
                onClick={() => setCenterView('terminal')}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
              >
                <TerminalIcon className="h-3.5 w-3.5" />
                终端
              </button>
              <button
                onClick={() => setCenterView('ai-artifacts')}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
              >
                <Sparkles className="h-3.5 w-3.5" />
                AI 产物
              </button>
            </div>
            <p className="text-[10px]">
              {activeCenterTab ? `活动页签：${activeCenterTab}` : '从左栏选择文件或在右栏与 AI 对话'}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
