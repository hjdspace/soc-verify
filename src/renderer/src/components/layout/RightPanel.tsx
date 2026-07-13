import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Plus, Send, Square, Trash2, Loader2, Clock, X, Check, Paperclip, Compass, Search, FileText, Folder, Sparkles, History, ArrowLeft } from 'lucide-react';
import { useSessionStore, type ChatMessage, type AvailableModel, type SelectedSkill, type ContextFile, type HistorySession } from '@renderer/stores/session';
import { useSettingsStore } from '@renderer/stores/settings';
import { useProjectStore } from '@renderer/stores/project';
import { MarkdownRenderer } from '@renderer/components/chat/MarkdownRenderer';
import { ToolCard } from '@renderer/components/chat/ToolCard';
import { cn } from '@renderer/lib/utils';
import { trpc } from '@renderer/lib/trpc';

interface RightPanelProps {
  width: number;
}

export function RightPanel({ width }: RightPanelProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const createSession = useSessionStore((s) => s.createSession);
  const closeSession = useSessionStore((s) => s.closeSession);
  const switchSession = useSessionStore((s) => s.switchSession);
  const inputMessage = useSessionStore((s) => s.inputMessage);
  const setInputMessage = useSessionStore((s) => s.setInputMessage);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const abortSession = useSessionStore((s) => s.abortSession);
  const isSending = useSessionStore((s) => s.isSending);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const currentProject = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.currentProjectId),
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const skillListRef = useRef<HTMLDivElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [steerText, setSteerText] = useState('');
  const [showSteerInput, setShowSteerInput] = useState(false);

  // Skill & context state
  const [availableSkills, setAvailableSkills] = useState<SelectedSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillSearch, setSkillSearch] = useState('');
  const [showSkillDropdown, setShowSkillDropdown] = useState(false);
  const [skillHighlightIdx, setSkillHighlightIdx] = useState(0);

  const [fileSearchResults, setFileSearchResults] = useState<ContextFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [fileHighlightIdx, setFileHighlightIdx] = useState(0);

  const selectedSkills = useSessionStore((s) => s.selectedSkills);
  const contextFiles = useSessionStore((s) => s.contextFiles);
  const addSkill = useSessionStore((s) => s.addSkill);
  const removeSkill = useSessionStore((s) => s.removeSkill);
  const addContextFile = useSessionStore((s) => s.addContextFile);
  const removeContextFile = useSessionStore((s) => s.removeContextFile);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const steerSession = useSessionStore((s) => s.steerSession);
  const setModel = useSessionStore((s) => s.setModel);
  const fetchModelsFromApi = useSettingsStore((s) => s.fetchModels);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const isCurrentSessionCreating = currentSession?.status === 'creating';
  const renameSession = useSessionStore((s) => s.renameSession);
  const historySessions = useSessionStore((s) => s.historySessions);
  const historyLoading = useSessionStore((s) => s.historyLoading);
  const fetchHistorySessions = useSessionStore((s) => s.fetchHistorySessions);
  const loadHistorySession = useSessionStore((s) => s.loadHistorySession);
  const deleteHistorySession = useSessionStore((s) => s.deleteHistorySession);
  const currentHistorySessionId = currentSession?.persistedSessionId ?? currentSessionId;

  // Load history sessions when history view is opened
  useEffect(() => {
    if (showHistory && currentProjectId) {
      fetchHistorySessions(currentProjectId);
    }
  }, [showHistory, currentProjectId, fetchHistorySessions]);

  const handleOpenHistory = () => {
    setShowHistory(true);
  };

  const handleCloseHistory = () => {
    setShowHistory(false);
  };

  const handleLoadHistorySession = async (historySession: HistorySession) => {
    if (!currentProjectId || !currentProject) return;
    setShowHistory(false);
    await loadHistorySession(historySession, currentProjectId, currentProject.rootPath);
  };

  const handleDeleteHistorySession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (!currentProjectId) return;
    await deleteHistorySession(sessionId, currentProjectId);
  };

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentSession?.messages]);

  // Scroll highlighted skill into view
  useEffect(() => {
    if (!showSkillDropdown || !skillListRef.current) return;
    const item = skillListRef.current.children[skillHighlightIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [skillHighlightIdx, showSkillDropdown]);

  // Scroll highlighted file into view
  useEffect(() => {
    if (!showFileDropdown || !fileListRef.current) return;
    const item = fileListRef.current.children[fileHighlightIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [fileHighlightIdx, showFileDropdown]);

  const handleCreateSession = async () => {
    if (!currentProjectId || !currentProject) return;
    void createSession(currentProjectId, currentProject.rootPath);
  };

  const handleSend = async () => {
    if (!inputMessage.trim()) return;
    await sendMessage(inputMessage, attachedImages.length > 0 ? attachedImages : undefined);
    setAttachedImages([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle skill dropdown navigation
    if (showSkillDropdown && filteredSkills.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSkillHighlightIdx((prev) => Math.min(prev + 1, filteredSkills.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSkillHighlightIdx((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSelectSkill(filteredSkills[skillHighlightIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSkillDropdown(false);
        return;
      }
    }

    // Handle file dropdown navigation
    if (showFileDropdown && fileSearchResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFileHighlightIdx((prev) => Math.min(prev + 1, fileSearchResults.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFileHighlightIdx((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSelectFile(fileSearchResults[fileHighlightIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowFileDropdown(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleRenameStart = (e: React.MouseEvent, sessionId: string, currentName: string) => {
    e.stopPropagation();
    setEditingSessionId(sessionId);
    setEditingSessionName(currentName);
  };

  const handleRenameSave = async () => {
    if (!editingSessionId || !editingSessionName.trim() || !currentProjectId) {
      setEditingSessionId(null);
      setEditingSessionName('');
      return;
    }
    await renameSession(editingSessionId, currentProjectId, editingSessionName.trim());
    setEditingSessionId(null);
    setEditingSessionName('');
  };

  const handleRenameCancel = () => {
    setEditingSessionId(null);
    setEditingSessionName('');
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleRenameSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleRenameCancel();
    }
  };

  const handleImageSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newImages: string[] = [];
    for (const file of Array.from(files)) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === 'string') {
          const base64 = result.split(',')[1];
          if (base64) newImages.push(base64);
        }
        if (newImages.length === files.length) {
          setAttachedImages((prev) => [...prev, ...newImages]);
        }
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  };

  const removeImage = (idx: number) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleLoadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const models = await fetchModelsFromApi();
      setAvailableModels(models.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        description: m.description,
      })));
      setShowModelDropdown(true);
    } finally {
      setModelsLoading(false);
    }
  }, [fetchModelsFromApi]);

  const handleSetModel = async (provider: string, modelId: string, modelName?: string) => {
    if (!currentSessionId) return;
    await setModel(currentSessionId, provider, modelId, modelName);
    setShowModelDropdown(false);
  };

  const handleSteer = async () => {
    if (!steerText.trim()) return;
    await steerSession(steerText);
    setSteerText('');
    setShowSteerInput(false);
  };

  const handleSteerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSteer();
    } else if (e.key === 'Escape') {
      setShowSteerInput(false);
      setSteerText('');
    }
  };

  // ── Skill loading ──────────────────────────────────────
  useEffect(() => {
    if (!currentProjectId) return;
    setSkillsLoading(true);
    trpc.session.listSkills.query({ projectId: currentProjectId })
      .then((skills) => {
        setAvailableSkills(skills as SelectedSkill[]);
      })
      .catch(() => {
        setAvailableSkills([]);
      })
      .finally(() => setSkillsLoading(false));
  }, [currentProjectId]);

  // Filtered skills based on search text
  const filteredSkills = useMemo(() => {
    if (!skillSearch) return availableSkills;
    const q = skillSearch.toLowerCase();
    return availableSkills.filter((s) =>
      s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [availableSkills, skillSearch]);

  // ── File search (debounced) ────────────────────────────
  const fileSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const performFileSearch = useCallback((query: string) => {
    if (!currentProjectId || !query.trim()) {
      setFileSearchResults([]);
      return;
    }
    setFilesLoading(true);
    trpc.project.searchFiles.query({ projectId: currentProjectId, query, limit: 30 })
      .then((results) => {
        setFileSearchResults(results as ContextFile[]);
      })
      .catch(() => setFileSearchResults([]))
      .finally(() => setFilesLoading(false));
  }, [currentProjectId]);

  useEffect(() => {
    if (!showFileDropdown) return;
    if (fileSearchTimerRef.current) clearTimeout(fileSearchTimerRef.current);
    fileSearchTimerRef.current = setTimeout(() => {
      performFileSearch(fileSearch);
    }, 200);
    return () => {
      if (fileSearchTimerRef.current) clearTimeout(fileSearchTimerRef.current);
    };
  }, [fileSearch, showFileDropdown, performFileSearch]);

  // ── Input change with slash/@ detection ────────────────
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInputMessage(value);

    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = value.slice(0, cursorPos);

    // Check for slash command trigger: `/` at start or after whitespace
    const slashMatch = textBeforeCursor.match(/(?:^|\s)\/(\S*)$/);
    if (slashMatch) {
      setSkillSearch(slashMatch[1]);
      setShowSkillDropdown(true);
      setShowFileDropdown(false);
      setSkillHighlightIdx(0);
      return;
    }

    // Check for @ mention trigger: `@` at start or after whitespace
    const atMatch = textBeforeCursor.match(/(?:^|\s)@(\S*)$/);
    if (atMatch) {
      setFileSearch(atMatch[1]);
      setShowFileDropdown(true);
      setShowSkillDropdown(false);
      setFileHighlightIdx(0);
      return;
    }

    if (showSkillDropdown) setShowSkillDropdown(false);
    if (showFileDropdown) setShowFileDropdown(false);
  };

  // ── Skill selection ────────────────────────────────────
  const handleSelectSkill = (skill: SelectedSkill) => {
    addSkill(skill);
    const value = inputMessage;
    const cursorPos = textareaRef.current?.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const textAfterCursor = value.slice(cursorPos);
    const slashMatch = textBeforeCursor.match(/(?:^|\s)\/\S*$/);
    if (slashMatch) {
      const prefix = slashMatch[0].startsWith(' ') ? ' ' : '';
      const newText = textBeforeCursor.slice(0, slashMatch.index) + prefix + textAfterCursor;
      setInputMessage(newText);
    }
    setShowSkillDropdown(false);
    setSkillSearch('');
    textareaRef.current?.focus();
  };

  // ── File selection ─────────────────────────────────────
  const handleSelectFile = (file: ContextFile) => {
    addContextFile(file);
    const value = inputMessage;
    const cursorPos = textareaRef.current?.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const textAfterCursor = value.slice(cursorPos);
    const atMatch = textBeforeCursor.match(/(?:^|\s)@\S*$/);
    if (atMatch) {
      const prefix = atMatch[0].startsWith(' ') ? ' ' : '';
      const newText = textBeforeCursor.slice(0, atMatch.index) + prefix + textAfterCursor;
      setInputMessage(newText);
    }
    setShowFileDropdown(false);
    setFileSearch('');
    textareaRef.current?.focus();
  };

  return (
    <aside
      className="flex shrink-0 flex-col border-l bg-sidebar"
      style={{ width: `${width}px` }}
    >
      {/* ── 会话标签栏 ──────────────────────────────── */}
      <div className="flex items-center border-b">
        {/* Tabs — horizontally scrollable */}
        <div
          className="flex items-center gap-0.5 flex-1 overflow-x-auto px-1 py-1"
          style={{ scrollbarWidth: 'thin' }}
        >
          {sessions.map((sess) => {
            const isActive = sess.id === currentSessionId;
            const isEditing = editingSessionId === sess.id;
            const isSessionRunning = sess.status === 'streaming' || sess.status === 'tool_executing';
            return (
              <div
                key={sess.id}
                data-session-tab
                onClick={() => !isEditing && switchSession(sess.id)}
                className={cn(
                  'group flex items-center gap-1 rounded-md px-2 py-1 text-xs cursor-pointer transition-colors max-w-[160px] shrink-0',
                  isActive
                    ? 'bg-background text-foreground ring-1 ring-border'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                {isEditing ? (
                  <>
                    <input
                      type="text"
                      value={editingSessionName}
                      onChange={(e) => setEditingSessionName(e.target.value)}
                      onKeyDown={handleRenameKeyDown}
                      onClick={(e) => e.stopPropagation()}
                      className="min-w-0 flex-1 bg-background border border-border rounded px-1 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                      style={{ width: '80px' }}
                      autoFocus
                    />
                    <button
                      onClick={(e) => { e.stopPropagation(); void handleRenameSave(); }}
                      className="shrink-0 rounded p-0.5 text-green-500 hover:bg-green-500/10"
                      title="保存"
                    >
                      <Check className="h-2.5 w-2.5" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRenameCancel(); }}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
                      title="取消"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </>
                ) : (
                  <>
                    {isSessionRunning && (
                      <Loader2 aria-label="会话运行中" className="h-2.5 w-2.5 shrink-0 animate-spin" />
                    )}
                    <span
                      className="truncate"
                      onDoubleClick={(e) => handleRenameStart(e, sess.id, sess.name)}
                      title={sess.name}
                    >
                      {sess.name}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeSession(sess.id);
                      }}
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-60"
                      title="关闭会话"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-0.5 shrink-0 border-l border-border/50 px-1">
          <button
            onClick={handleCreateSession}
            disabled={!currentProjectId}
            title="新建会话"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleOpenHistory}
            disabled={!currentProjectId}
            title="历史会话"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            <History className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── 消息列表 / 历史会话 ────────────────────── */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {showHistory ? (
          <HistoryView
            sessions={historySessions}
            loading={historyLoading}
            activeSessionIds={new Set(sessions.map((s) => s.persistedSessionId ?? s.id))}
            currentSessionId={currentHistorySessionId}
            onLoadSession={handleLoadHistorySession}
            onDeleteSession={handleDeleteHistorySession}
            onClose={handleCloseHistory}
          />
        ) : !currentSession ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              {currentProjectId ? '点击 + 创建 AI 会话' : '请先打开项目'}
            </p>
          </div>
        ) : currentSession.messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              {isCurrentSessionCreating ? '正在创建 AI 会话...' : '开始与 AI Agent 对话，让它辅助你的验证工作'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {currentSession.messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* ── Steer 输入 ────────────────────────────── */}
      {isSending && showSteerInput && (
        <div className="border-t px-2 py-1.5">
          <div className="flex flex-col gap-1 rounded-md border border-primary/30 bg-primary/5 p-1.5">
            <div className="flex items-center gap-1 text-[10px] text-primary">
              <Compass className="h-3 w-3" />
              <span className="font-semibold">引导 AI（不中断当前流）</span>
            </div>
            <textarea
              value={steerText}
              onChange={(e) => setSteerText(e.target.value)}
              onKeyDown={handleSteerKeyDown}
              placeholder="输入引导消息..."
              rows={2}
              autoFocus
              className="resize-none bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
            <div className="flex justify-end gap-1">
              <button
                onClick={() => { setShowSteerInput(false); setSteerText(''); }}
                className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
              >
                取消
              </button>
              <button
                onClick={handleSteer}
                disabled={!steerText.trim()}
                className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-30"
              >
                发送
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 输入框 ──────────────────────────────────── */}
      <div className="border-t p-2">
        {/* 图片附件预览 */}
        {attachedImages.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {attachedImages.map((img, idx) => (
              <div key={idx} className="relative">
                <img
                  src={`data:image/png;base64,${img}`}
                  alt={`attachment-${idx}`}
                  className="h-12 w-12 rounded border border-border object-cover"
                />
                <button
                  onClick={() => removeImage(idx)}
                  className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-destructive-foreground"
                >
                  <X className="h-2 w-2" />
                </button>
              </div>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleImageChange}
          className="hidden"
        />

        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2 relative">
          {/* ── Chips: Skills & Context Files ─────────────── */}
          {(selectedSkills.length > 0 || contextFiles.length > 0) && (
            <div className="flex flex-wrap gap-1 pb-1">
              {selectedSkills.map((skill) => (
                <span
                  key={`skill-${skill.name}`}
                  className="inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary"
                >
                  <Sparkles className="h-2.5 w-2.5" />
                  <span className="max-w-[120px] truncate font-medium">{skill.name}</span>
                  <button
                    onClick={() => removeSkill(skill.name)}
                    className="rounded-sm hover:bg-primary/20"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
              {contextFiles.map((file) => (
                <span
                  key={`ctx-${file.path}`}
                  className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[10px] text-foreground"
                >
                  {file.type === 'directory' ? (
                    <Folder className="h-2.5 w-2.5 text-muted-foreground" />
                  ) : (
                    <FileText className="h-2.5 w-2.5 text-muted-foreground" />
                  )}
                  <span className="max-w-[150px] truncate font-medium">{file.name}</span>
                  <button
                    onClick={() => removeContextFile(file.path)}
                    className="rounded-sm hover:bg-accent/80"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* ── Skill dropdown ────────────────────────────── */}
          {showSkillDropdown && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowSkillDropdown(false)} />
              <div className="absolute bottom-full left-0 right-0 z-50 max-h-56 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
                <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-1.5">
                  <Search className="h-3 w-3 text-muted-foreground" />
                  <input
                    type="text"
                    value={skillSearch}
                    onChange={(e) => { setSkillSearch(e.target.value); setSkillHighlightIdx(0); }}
                    onKeyDown={handleKeyDown}
                    placeholder="搜索技能..."
                    tabIndex={-1}
                    className="flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                  />
                  {skillsLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                </div>
                <div ref={skillListRef} className="max-h-40 overflow-y-auto p-1">
                  {filteredSkills.length === 0 ? (
                    <div className="px-2 py-3 text-center text-[10px] text-muted-foreground">
                      {skillsLoading ? '加载中...' : '未找到技能'}
                    </div>
                  ) : (
                    filteredSkills.map((skill, idx) => (
                      <button
                        key={skill.name}
                        onClick={() => handleSelectSkill(skill)}
                        className={cn(
                          'flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left text-xs hover:bg-accent',
                          idx === skillHighlightIdx && 'bg-accent/50',
                        )}
                      >
                        <div className="flex items-center gap-1">
                          <Sparkles className="h-2.5 w-2.5 text-primary" />
                          <span className="font-medium text-foreground">{skill.name}</span>
                          <span className="text-[9px] text-muted-foreground/70">{skill.source}</span>
                        </div>
                        {skill.description && (
                          <span className="text-[9px] text-muted-foreground line-clamp-2">{skill.description}</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </>
          )}

          {/* ── File dropdown ─────────────────────────────── */}
          {showFileDropdown && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowFileDropdown(false)} />
              <div className="absolute bottom-full left-0 right-0 z-50 max-h-56 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
                <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-1.5">
                  <Search className="h-3 w-3 text-muted-foreground" />
                  <input
                    type="text"
                    value={fileSearch}
                    onChange={(e) => { setFileSearch(e.target.value); setFileHighlightIdx(0); }}
                    onKeyDown={handleKeyDown}
                    placeholder="搜索文件或文件夹..."
                    tabIndex={-1}
                    className="flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                  />
                  {filesLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                </div>
                <div ref={fileListRef} className="max-h-40 overflow-y-auto p-1">
                  {fileSearchResults.length === 0 ? (
                    <div className="px-2 py-3 text-center text-[10px] text-muted-foreground">
                      {filesLoading ? '搜索中...' : !fileSearch.trim() ? '输入关键词搜索文件' : '未找到文件'}
                    </div>
                  ) : (
                    fileSearchResults.map((file, idx) => (
                      <button
                        key={file.path}
                        onClick={() => handleSelectFile(file)}
                        className={cn(
                          'flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-accent',
                          idx === fileHighlightIdx && 'bg-accent/50',
                        )}
                      >
                        {file.type === 'directory' ? (
                          <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
                        ) : (
                          <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate font-medium text-foreground">{file.name}</span>
                        <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/70 truncate max-w-[120px]">
                          {file.path.replace(currentProject?.rootPath ?? '', '.')}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </>
          )}

          <textarea
            ref={textareaRef}
            value={inputMessage}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={currentSessionId ? '输入消息... (\"/" 加载技能, "@" 添加上下文)' : '请先创建会话'}
            disabled={!currentSessionId || isCurrentSessionCreating}
            rows={3}
            className="resize-none bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {/* 图片附件按钮 */}
              <button
                onClick={handleImageSelect}
                disabled={!currentSessionId || isCurrentSessionCreating}
                title="附加图片"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
              >
                <Paperclip className="h-3 w-3" />
              </button>
              {/* 模型选择器 */}
              <div className="relative">
                <button
                  onClick={handleLoadModels}
                  title="切换模型"
                  className="flex items-center gap-0.5 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {modelsLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <span className="max-w-[100px] truncate text-[10px] font-medium text-foreground/80">
                      {currentSession?.model?.name ?? '选择模型'}
                    </span>
                  )}
                </button>
                {showModelDropdown && availableModels.length > 0 && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowModelDropdown(false)} />
                    <div className="absolute bottom-7 left-0 z-50 max-h-48 w-56 overflow-y-auto rounded-md border border-border bg-popover shadow-xl">
                      {availableModels.map((m) => (
                        <button
                          key={`${m.provider}:${m.id}`}
                          onClick={() => handleSetModel(m.provider, m.id, m.name)}
                          className={cn(
                            'flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left text-xs hover:bg-accent',
                            currentSession?.model?.id === m.id && currentSession?.model?.provider === m.provider && 'bg-accent/50',
                          )}
                        >
                          <span className="font-medium text-foreground">{m.name}</span>
                          <span className="text-[9px] text-muted-foreground">{m.provider} · {m.id}</span>
                          {m.description && (
                            <span className="text-[9px] text-muted-foreground/70">{m.description}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {/* Steer 按钮 */}
              {isSending && !showSteerInput && (
                <button
                  onClick={() => setShowSteerInput(true)}
                  title="引导 AI"
                  className="rounded p-1 text-primary transition-colors hover:bg-primary/10"
                >
                  <Compass className="h-3 w-3" />
                </button>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground">
              Enter 发送 · Shift+Enter 换行
            </span>
            {isSending ? (
              <button
                onClick={abortSession}
                className="flex items-center gap-1 rounded bg-destructive/10 px-2 py-1 text-[10px] text-destructive transition-colors hover:bg-destructive/20"
              >
                <Square className="h-3 w-3" />
                中止
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!inputMessage.trim() || !currentSessionId || isCurrentSessionCreating}
                className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-30"
              >
                <Send className="h-3 w-3" />
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

// ── 消息渲染组件 ───────────────────────────────────────

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'tool') {
    return <ToolCard message={message} />;
  }

  const isUser = message.role === 'user';

  // User messages: right-aligned bubble
  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <div className="max-w-[85%] rounded-lg bg-primary/15 px-2.5 py-1.5 text-xs">
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        </div>
      </div>
    );
  }

  // Assistant messages: render directly without bubble wrapper
  return (
    <div className="flex flex-col gap-0.5">
      {message.content ? (
        <MarkdownRenderer content={message.content} />
      ) : (
        message.isStreaming && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="text-[10px]">思考中...</span>
          </div>
        )
      )}
      {message.isStreaming && message.content && (
        <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-foreground" />
      )}
    </div>
  );
}

// ToolCard is now imported from '@renderer/components/chat/ToolCard'

// ── 历史会话页面 ───────────────────────────────────────

interface HistoryViewProps {
  sessions: HistorySession[];
  loading: boolean;
  activeSessionIds: Set<string>;
  currentSessionId: string | null;
  onLoadSession: (session: HistorySession) => void;
  onDeleteSession: (e: React.MouseEvent, sessionId: string) => void;
  onClose: () => void;
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return '刚刚';
  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 7) return `${diffDays} 天前`;
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function HistoryView({
  sessions,
  loading,
  activeSessionIds,
  currentSessionId,
  onLoadSession,
  onDeleteSession,
  onClose,
}: HistoryViewProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      (s.model?.name ?? '').toLowerCase().includes(q),
    );
  }, [sessions, searchQuery]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/50 pb-2 mb-2">
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="返回"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-xs font-semibold text-foreground">历史会话</span>
        <span className="text-[10px] text-muted-foreground">
          ({sessions.length})
        </span>
      </div>

      {/* Search */}
      {sessions.length > 0 && (
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话..."
            className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
          />
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <p className="text-xs text-muted-foreground">加载中...</p>
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <History className="h-6 w-6 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">
              {sessions.length === 0 ? '暂无历史会话' : '未找到匹配的会话'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {filteredSessions.map((session) => {
              const isActive = activeSessionIds.has(session.sessionId);
              const isCurrent = currentSessionId === session.sessionId;
              return (
                <div
                  key={session.sessionId}
                  onClick={() => onLoadSession(session)}
                  className={cn(
                    'group flex cursor-pointer flex-col gap-0.5 rounded-md border p-2 transition-colors',
                    isCurrent
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border/40 hover:border-border hover:bg-accent/50',
                  )}
                >
                  <div className="flex items-start justify-between gap-1">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <span className="truncate text-xs font-medium text-foreground">
                          {session.name}
                        </span>
                        {isActive && (
                          <span className="shrink-0 rounded-full bg-green-500/15 px-1.5 py-0.5 text-[9px] font-medium text-green-600 dark:text-green-400">
                            活跃
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={(e) => onDeleteSession(e, session.sessionId)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-50"
                      title="删除"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-0.5">
                      <Clock className="h-2.5 w-2.5" />
                      {formatDateTime(session.lastActivityAt)}
                    </span>
                    {session.model && (
                      <>
                        <span className="text-muted-foreground/50">·</span>
                        <span className="truncate">{session.model.name}</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
