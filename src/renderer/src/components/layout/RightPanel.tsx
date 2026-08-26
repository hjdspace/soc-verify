import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import { Plus, ArrowUp, Square, Trash2, Loader2, Clock, X, Check, Compass, Search, FileText, Folder, Sparkles, History, ArrowLeft, Image as ImageIcon, Shield, ShieldAlert, ShieldCheck, ChevronDown, ChevronRight, Info, PanelLeftClose, Key, Copy } from 'lucide-react';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import { useSessionMessagesStore } from '@renderer/stores/session-messages';
import { useSessionApprovalStore } from '@renderer/stores/session-approval';
import type { ChatMessage, SelectedSkill, ContextFile, HistorySession, SessionEntry } from '@renderer/stores/session-types';
import { useSettingsStore } from '@renderer/stores/settings';
import { useProjectStore } from '@renderer/stores/project';
import { MarkdownRenderer } from '@renderer/components/chat/MarkdownRenderer';
import { ToolCard } from '@renderer/components/chat/ToolCard';
import { ThinkingBlock } from '@renderer/components/chat/ThinkingBlock';
import { TVAISuggestionCard } from '@renderer/components/chat/TVAISuggestionCard';
import { cn } from '@renderer/lib/utils';
import { trpc } from '@renderer/lib/trpc';
import { PluginViewHost } from '@renderer/components/plugins/PluginViewHost';
import { ContextUsageIndicator } from '@renderer/components/chat/ContextUsageIndicator';
import { ApprovalCard } from '@renderer/components/chat/ApprovalCard';
import { AskQuestionCard } from '@renderer/components/chat/AskQuestionCard';
import { TodoPanel } from '@renderer/components/chat/TodoPanel';
import { ChangeSummaryBar } from '@renderer/components/chat/ChangeSummaryBar';
import { ErrorMessage } from '@renderer/components/chat/ErrorMessage';
import { getLatestTodoState } from '@renderer/components/chat/tool-helpers';
import { useTodoPanelStore } from '@renderer/stores/todo-panel';
import { ComposerEditor, type ChipData, type ComposerEditorApi } from './ComposerEditor';
import { useUiStore } from '@renderer/stores/ui';
import { ThinkingOrb, BorderBeam } from '@renderer/components/visual';

interface RightPanelProps {
  width: number;
}

/**
 * AI 会话面板内容（消息流 + 会话标签 + composer + 审批卡等）。
 * 外壳无关：docked 模式由 RightPanel 包固定侧栏，drawer 模式由 AiDrawer 包右抽屉。
 */
export function RightPanelContent() {
const sessions = useSessionCoreStore((s) => s.sessions);
const currentSessionId = useSessionCoreStore((s) => s.currentSessionId);
  const currentSession = sessions.find((session) => session.id === currentSessionId);
  const inputMessage = currentSession?.composer?.inputMessage ?? '';
  const selectedSkills = currentSession?.composer?.selectedSkills ?? [];
  const contextFiles = currentSession?.composer?.contextFiles ?? [];
  const isSending = currentSession?.status === 'streaming' || currentSession?.status === 'tool_executing';
const createSession = useSessionCoreStore((s) => s.createSession);
const closeSession = useSessionCoreStore((s) => s.closeSession);
const switchSession = useSessionCoreStore((s) => s.switchSession);
const setInputMessage = useSessionCoreStore((s) => s.setInputMessage);
const sendMessage = useSessionMessagesStore((s) => s.sendMessage);
const abortSession = useSessionMessagesStore((s) => s.abortSession);
const compactSession = useSessionMessagesStore((s) => s.compactSession);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const currentProject = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.currentProjectId),
  );
  // 只在 tab 栏中显示当前项目的会话，避免切换项目后旧项目的聊天记录残留
  const projectSessions = sessions.filter((s) => !currentProjectId || s.projectId === currentProjectId);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const skillListRef = useRef<HTMLDivElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isPinnedToBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [steerText, setSteerText] = useState('');
  const [showSteerInput, setShowSteerInput] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showAttachDropdown, setShowAttachDropdown] = useState(false);
  const [showApprovalDropdown, setShowApprovalDropdown] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);

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

const addSkill = useSessionCoreStore((s) => s.addSkill);
const removeSkill = useSessionCoreStore((s) => s.removeSkill);
const addContextFile = useSessionCoreStore((s) => s.addContextFile);
const removeContextFile = useSessionCoreStore((s) => s.removeContextFile);

  const editorApiRef = useRef<ComposerEditorApi | null>(null);

const steerSession = useSessionMessagesStore((s) => s.steerSession);
const setModel = useSessionCoreStore((s) => s.setModel);
  const credentials = useSettingsStore((s) => s.credentials);
  const loadCredentials = useSettingsStore((s) => s.loadCredentials);
const setApprovalMode = useSessionApprovalStore((s) => s.setApprovalMode);
const resolveApproval = useSessionApprovalStore((s) => s.resolveApproval);
const approvalRequests = useSessionApprovalStore((s) => s.approvalRequests);
const askRequests = useSessionApprovalStore((s) => s.askRequests);
const resolveAsk = useSessionApprovalStore((s) => s.resolveAsk);

  const isCurrentSessionCreating = currentSession?.status === 'creating';

  // ── Todo panel state ───────────────────────────────
  const currentMessages = currentSession?.messages;
  const todoState = useMemo(
    () => currentMessages ? getLatestTodoState(currentMessages) : null,
    [currentMessages],
  );
  const todoCollapsed = useTodoPanelStore((s) =>
    currentSessionId ? (s.collapsed[currentSessionId] ?? false) : false,
  );
  const toggleTodoCollapse = useTodoPanelStore((s) => s.toggleCollapse);

const renameSession = useSessionCoreStore((s) => s.renameSession);
const historySessions = useSessionCoreStore((s) => s.historySessions);
const historyLoading = useSessionCoreStore((s) => s.historyLoading);
const fetchHistorySessions = useSessionCoreStore((s) => s.fetchHistorySessions);
const loadHistorySession = useSessionCoreStore((s) => s.loadHistorySession);
const deleteHistorySession = useSessionCoreStore((s) => s.deleteHistorySession);
  const currentHistorySessionId = currentSession?.persistedSessionId ?? currentSessionId;

  // Load history sessions when history view is opened
  useEffect(() => {
    if (showHistory && currentProjectId) {
      fetchHistorySessions(currentProjectId);
    }
  }, [showHistory, currentProjectId, fetchHistorySessions]);

  // Load credentials on mount so the model dropdown has provider/model data
  useEffect(() => {
    void loadCredentials();
  }, [loadCredentials]);

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

  // ── Smart auto-scroll: only pin to bottom when user is already there ──
  // During streaming output, every token update fires this effect. If the
  // user has scrolled up to read history, we must NOT yank them back down.
  // isPinnedToBottomRef tracks whether the viewport is near the bottom; we
  // only auto-scroll when it's true. User-initiated "send" forces a re-pin.
  useEffect(() => {
    if (!isPinnedToBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentSession?.messages]);

  // Sync the button visibility whenever messages change (cheap state set).
  useEffect(() => {
    setShowScrollToBottom(!isPinnedToBottomRef.current);
  }, [currentSession?.messages]);

  // Scroll handler: detect whether user is near the bottom of the list.
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // 48 px threshold — roughly 3 lines of text — feels natural: minor
    // jitter from smooth-scroll won't unpin, but a deliberate scroll-up will.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    isPinnedToBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

  // Reset pin state when switching sessions (new session = always start at bottom).
  useEffect(() => {
    isPinnedToBottomRef.current = true;
    setShowScrollToBottom(false);
    // Defer scroll to next tick so DOM has updated for the new session's messages.
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    });
  }, [currentSessionId]);

  // When user sends a new message, force-scroll to bottom (re-pin).
  const prevMessageCountRef = useRef(currentSession?.messages.length ?? 0);
  useEffect(() => {
    const count = currentSession?.messages.length ?? 0;
    if (count > prevMessageCountRef.current) {
      const lastMsg = currentSession?.messages[count - 1];
      // A new user message means the user explicitly wants to see the latest.
      if (lastMsg?.role === 'user') {
        isPinnedToBottomRef.current = true;
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
    prevMessageCountRef.current = count;
  }, [currentSession?.messages]);

  const scrollToBottom = useCallback(() => {
    isPinnedToBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowScrollToBottom(false);
  }, []);

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
    // Capture and clear images immediately so the preview disappears without
    // waiting for the async sendMessage to resolve.
    const images = attachedImages.length > 0 ? attachedImages : undefined;
    setAttachedImages([]);
    const text = inputMessage;
    editorApiRef.current?.clear();
    await sendMessage(text, images);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // IME 组合中的按键（如中文选词的 Enter）不触发导航/发送
    if (e.nativeEvent.isComposing) return;
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
    setShowAttachDropdown(false);
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
          // Store the full data URL (data:image/png;base64,...) so the
          // correct MIME type is preserved for rendering.
          newImages.push(result);
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

  // ── File / folder attachment via native dialog ────────
  const handleFileAttach = async () => {
    setShowAttachDropdown(false);
    if (!currentProjectId) {
      console.error('[handleFileAttach] No current project');
      return;
    }
    try {
      console.log('[handleFileAttach] Calling pickFiles with projectId:', currentProjectId);
      const result = await trpc.project.pickFiles.mutate({ projectId: currentProjectId });
      console.log('[handleFileAttach] Result:', result);
      if (result.canceled) return;
      for (const file of result.files) {
        addContextFile(file);
      }
    } catch (err) {
      console.error('[handleFileAttach] Error:', err);
    }
  };

  const handleFolderAttach = async () => {
    setShowAttachDropdown(false);
    if (!currentProjectId) {
      console.error('[handleFolderAttach] No current project');
      return;
    }
    try {
      console.log('[handleFolderAttach] Calling pickFolder with projectId:', currentProjectId);
      const result = await trpc.project.pickFolder.mutate({ projectId: currentProjectId });
      console.log('[handleFolderAttach] Result:', result);
      if (result.canceled) return;
      addContextFile(result.folder);
    } catch (err) {
      console.error('[handleFolderAttach] Error:', err);
    }
  };

  // ── Drag-and-drop: accept files/folders dragged from the file tree ──
  const handleDragOver = (e: React.DragEvent) => {
    // Only accept drags that carry our JSON payload (from the file tree)
    if (!e.dataTransfer.types.includes('application/json')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (!related || !e.currentTarget.contains(related)) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    const data = e.dataTransfer.getData('application/json');
    if (!data) return;
    e.preventDefault();
    setIsDragOver(false);
    try {
      const file = JSON.parse(data) as ContextFile;
      addContextFile(file);
    } catch {
      // Invalid drag payload — ignore silently
    }
  };

  // ── Paste images via Ctrl-V ───────────────────────────────────
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems = Array.from(items).filter(
      (item) => item.type.startsWith('image/'),
    );

    if (imageItems.length === 0) return; // Let normal text paste proceed

    e.preventDefault();

    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === 'string') {
          // Store the full data URL (data:image/png;base64,...)
          setAttachedImages((prev) => [...prev, result]);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const toggleModelDropdown = useCallback(() => {
    setShowModelDropdown((prev) => !prev);
    // Auto-expand the current session's provider
    if (!showModelDropdown && currentSession?.model?.providerId) {
      setExpandedProviders(new Set([currentSession.model.providerId]));
    }
  }, [showModelDropdown, currentSession?.model?.providerId]);

  const toggleProvider = useCallback((providerId: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  }, []);

  const handleSetModel = async (provider: string, modelId: string, modelName?: string, providerId?: string) => {
    if (!currentSessionId) return;
    await setModel(currentSessionId, provider, modelId, modelName, providerId);
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
    return availableSkills.filter((s) => s.name.toLowerCase().includes(q));
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

  // ── Editor input with slash/@ detection ────────────────
  const handleEditorInput = (text: string, textBeforeCaret: string) => {
    setInputMessage(text);

    // Check for slash command trigger: `/` anywhere before caret
    const slashMatch = textBeforeCaret.match(/\/(\S*)$/);
    if (slashMatch) {
      setSkillSearch(slashMatch[1]);
      setShowSkillDropdown(true);
      setShowFileDropdown(false);
      setSkillHighlightIdx(0);
      return;
    }

    // Check for @ mention trigger: `@` anywhere before caret
    const atMatch = textBeforeCaret.match(/@(\S*)$/);
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

  // ── Chip set reconciliation (X 点击 / Backspace 删除 chip 时同步 store) ──
  const handleChipsChange = (chips: ChipData[]) => {
    const skillNames = new Set(chips.filter((c) => c.kind === 'skill').map((c) => c.name ?? c.label));
    const filePaths = new Set(chips.filter((c) => c.kind === 'file').map((c) => c.path ?? c.label));
    for (const s of selectedSkills) {
      if (!skillNames.has(s.name)) removeSkill(s.name);
    }
    for (const f of contextFiles) {
      if (!filePaths.has(f.path)) removeContextFile(f.path);
    }
  };

  // ── Session switch: restore editor content (snapshot 优先，保留 chip 行内位置) ──
  useEffect(() => {
    if (!currentSessionId) {
      // 无会话时清空编辑器（与会话快照无关，切回原会话仍可恢复草稿）
      editorApiRef.current?.clear();
      return;
    }
    const sess = useSessionCoreStore.getState().sessions.find((s) => s.id === currentSessionId);
    const composer = sess?.composer;
    const fallbackChips: ChipData[] = [
      ...(composer?.selectedSkills ?? []).map((s): ChipData => ({ kind: 'skill', label: s.name, name: s.name })),
      ...(composer?.contextFiles ?? []).map((f): ChipData => ({ kind: 'file', label: f.name, path: f.path, fileType: f.type })),
    ];
    editorApiRef.current?.restore(currentSessionId, composer?.inputMessage ?? '', fallbackChips);
  }, [currentSessionId]);

  // ── Skill selection ────────────────────────────────────
  const handleSelectSkill = (skill: SelectedSkill) => {
    editorApiRef.current?.insertChip({ kind: 'skill', label: skill.name, name: skill.name }, /\/\S*$/);
    addSkill(skill);
    setShowSkillDropdown(false);
    setSkillSearch('');
  };

  // ── File selection ─────────────────────────────────────
  const handleSelectFile = (file: ContextFile) => {
    editorApiRef.current?.insertChip({ kind: 'file', label: file.name, path: file.path, fileType: file.type }, /@\S*$/);
    addContextFile(file);
    setShowFileDropdown(false);
    setFileSearch('');
  };

  return (
    <div className="ai-panel flex min-h-0 flex-1 flex-col bg-sidebar">
      {/* ── 会话标签栏 ──────────────────────────────── */}
      <div className="flex h-9 shrink-0 items-stretch border-b px-2">
        {/* Tabs — horizontally scrollable；活动 tab = 主题蓝文字 + 底部 2px 圆角条 */}
        <div
          className="flex flex-1 items-stretch gap-3.5 overflow-x-auto"
          style={{ scrollbarWidth: 'thin' }}
        >
          {projectSessions.map((sess) => {
            const isActive = sess.id === currentSessionId;
            const isEditing = editingSessionId === sess.id;
            const isSessionRunning = sess.status === 'streaming' || sess.status === 'tool_executing';
            return (
              <div
                key={sess.id}
                data-session-tab
                onClick={() => !isEditing && switchSession(sess.id)}
                className={cn(
                  'group relative flex select-none items-center gap-1 px-0.5 text-xs cursor-pointer transition-colors max-w-[160px] shrink-0',
                  isActive
                    ? 'font-medium text-primary'
                    : 'text-muted-foreground hover:text-foreground/80',
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
                      className="shrink-0 rounded p-0.5 text-status-pass-foreground hover:bg-status-pass/10"
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
                      <Loader2 aria-label="会话运行中" className="h-2.5 w-2.5 shrink-0 animate-spin text-primary" />
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
                      className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/10 hover:opacity-100 group-hover:opacity-70 hover:text-destructive text-muted-foreground"
                      title="关闭会话"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </>
                )}
                {isActive && !isEditing && (
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded-t-sm bg-primary" />
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

      <PluginViewHost location="right" />

      {/* ── 消息列表 / 历史会话 ────────────────────── */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-y-auto px-3 py-3"
      >
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
              <MessageBubble key={msg.id} message={msg} session={currentSession} />
            ))}
            {/* Approval request cards */}
            {approvalRequests
              .filter((req) => {
                const sess = currentSession;
                return sess && (sess.id === req.sessionId || sess.runtimeSessionId === req.sessionId || sess.persistedSessionId === req.sessionId);
              })
              .map((req) => (
                <ApprovalCard
                  key={req.requestId}
                  request={req}
                  onResolve={resolveApproval}
                />
              ))}
            {/* Ask question cards */}
            {askRequests
              .filter((req) => {
                const sess = currentSession;
                return sess && (sess.id === req.sessionId || sess.runtimeSessionId === req.sessionId || sess.persistedSessionId === req.sessionId);
              })
              .map((req) => (
                <AskQuestionCard
                  key={req.requestId}
                  requestId={req.requestId}
                  questions={req.questions}
                  onResolve={resolveAsk}
                />
              ))}
            {/* AI waiting indicator: show when session is active but no
                streaming assistant message exists (e.g. gap between tool
                execution end and next message_start from the LLM) */}
            {isSending &&
              !currentSession.messages.some(
                (m) => m.role === 'assistant' && m.isStreaming,
              ) && <RunningIndicator />}
            <div ref={messagesEndRef} />
          </div>
        )}
        {/* Scroll-to-bottom floating button — shown when user has scrolled
            up during streaming output. Positioned relative to the scroll
            container so it stays pinned at the bottom-right. */}
        {showScrollToBottom && (
          <button
            onClick={scrollToBottom}
            title="回到底部"
            aria-label="回到底部"
            className="sticky bottom-2 ml-auto mr-1 mb-1 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--dsw-border-l2)] bg-card text-muted-foreground shadow-[var(--dsw-shadow-lv2)] backdrop-blur transition-colors hover:bg-[var(--dsw-hover-solid)] hover:text-foreground"
            style={{ marginLeft: 'auto', marginRight: '4px', marginBottom: '4px' }}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
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

      {/* ── Todo 面板（固定在输入框上方） ───────────── */}
      {todoState && currentSessionId && (
        <TodoPanel
          phases={todoState.phases}
          isExecuting={todoState.isExecuting}
          collapsed={todoCollapsed}
          onToggleCollapse={() => toggleTodoCollapse(currentSessionId)}
        />
      )}

      {/* ── 代码改动摘要条 ──────────────────────────────── */}
      <ChangeSummaryBar />

      {/* ── 输入框 ──────────────────────────────────── */}
      <div className="border-t p-2">
        {/* 图片附件预览 */}
        {attachedImages.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {attachedImages.map((img, idx) => (
              <div key={idx} className="relative">
                <img
                  src={img}
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

        <BorderBeam size="line" theme="dark" active={isComposerFocused} colorVariant="ocean" className="block w-full">
        <div
          className={cn(
            'relative flex flex-col gap-1.5 rounded-2xl border border-[var(--dsw-border-l2)] bg-[var(--dsw-input-major)] p-2 shadow-[var(--dsw-shadow-lv2)] transition-colors',
            isDragOver && 'border-primary/50 ring-2 ring-primary/30',
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onFocus={() => setIsComposerFocused(true)}
          onBlur={() => setIsComposerFocused(false)}
        >
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

          {/* ── 行内 chip 编辑器：技能/上下文 chip 嵌入文本流中光标位置 ── */}
          <ComposerEditor
            sessionId={currentSessionId ?? ''}
            disabled={!currentSessionId || isCurrentSessionCreating}
            placeholder={currentSessionId ? '输入消息... ("/" 加载技能, "@" 添加上下文)' : '请先创建会话'}
            className="composer-editor min-h-[60px] max-h-[140px] overflow-y-auto whitespace-pre-wrap break-words px-0.5 py-1 text-xs leading-4 text-foreground outline-none"
            onInput={handleEditorInput}
            onChipsChange={handleChipsChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            apiRef={editorApiRef}
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {/* 附件按钮（下拉菜单） */}
              <div className="relative">
                <button
                  onClick={() => setShowAttachDropdown((v) => !v)}
                  disabled={!currentSessionId || isCurrentSessionCreating}
                  title="添加附件"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--dsw-selector)] text-muted-foreground transition-colors hover:bg-[var(--dsw-hover-solid)] hover:text-foreground disabled:opacity-30"
                >
                  <Plus className="h-3 w-3" />
                </button>
                {showAttachDropdown && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowAttachDropdown(false)} />
                    <div className="absolute bottom-7 left-0 z-50 w-44 rounded-md border border-border bg-popover shadow-xl">
                      <button
                        onClick={handleImageSelect}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                      >
                        <ImageIcon className="h-3 w-3 text-muted-foreground" />
                        <span>添加图片</span>
                      </button>
                      <button
                        onClick={handleFileAttach}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                      >
                        <FileText className="h-3 w-3 text-muted-foreground" />
                        <span>附加文件</span>
                      </button>
                      <button
                        onClick={handleFolderAttach}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                      >
                        <Folder className="h-3 w-3 text-muted-foreground" />
                        <span>添加文件夹到上下文</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
              {/* 权限模式选择器 */}
              <div className="relative">
                <button
                  onClick={() => setShowApprovalDropdown((v) => !v)}
                  disabled={!currentSessionId || isCurrentSessionCreating}
                  title="权限审批模式"
                  className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-[var(--dsw-selector)] px-2 text-muted-foreground transition-colors hover:bg-[var(--dsw-hover-solid)] hover:text-foreground disabled:opacity-30"
                >
                  {(() => {
                    const mode = currentSession?.approvalMode ?? 'yolo';
                    if (mode === 'always-ask') return <ShieldAlert className="h-3 w-3 text-warning-foreground" />;
                    if (mode === 'write') return <Shield className="h-3 w-3 text-primary" />;
                    return <ShieldCheck className="h-3 w-3 text-status-pass-foreground" />;
                  })()}
                  <span className="text-[10px] font-medium text-foreground/80">
                    {(() => {
                      const mode = currentSession?.approvalMode ?? 'yolo';
                      if (mode === 'always-ask') return '总询问';
                      if (mode === 'write') return '自动编辑';
                      return '信任';
                    })()}
                  </span>
                </button>
                {showApprovalDropdown && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowApprovalDropdown(false)} />
                    <div className="absolute bottom-7 left-0 z-50 w-44 rounded-md border border-border bg-popover shadow-xl">
                      {([
                        { mode: 'always-ask' as const, label: '总询问', desc: '写入和执行均需确认', icon: ShieldAlert },
                        { mode: 'write' as const, label: '自动编辑', desc: '仅执行命令需确认', icon: Shield },
                        { mode: 'yolo' as const, label: '完全信任', desc: '自动批准所有操作', icon: ShieldCheck },
                      ]).map(({ mode, label, desc, icon: Icon }) => (
                        <button
                          key={mode}
                          onClick={() => {
                            setApprovalMode(mode);
                            setShowApprovalDropdown(false);
                          }}
                          className={cn(
                            'flex w-full items-start gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-accent',
                            (currentSession?.approvalMode ?? 'yolo') === mode && 'bg-accent/50',
                          )}
                        >
                          <Icon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium text-foreground">{label}</span>
                            <span className="text-[9px] text-muted-foreground">{desc}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {/* 模型选择器 */}
              <div className="relative">
                <button
                  onClick={toggleModelDropdown}
                  title="切换模型"
                  className="flex items-center gap-0.5 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <span className="max-w-[100px] truncate text-[10px] font-medium text-foreground/80">
                    {currentSession?.model?.name ?? '选择模型'}
                  </span>
                  <ChevronDown className="h-2.5 w-2.5" />
                </button>
                {showModelDropdown && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowModelDropdown(false)} />
                    <div className="absolute bottom-7 left-0 z-50 max-h-64 w-64 overflow-y-auto rounded-md border border-border bg-popover shadow-xl">
                      {credentials.length === 0 ? (
                        <div className="px-2 py-3 text-center text-[10px] text-muted-foreground">
                          暂无已配置凭据<br />
                          请在设置中添加 Provider 和模型
                        </div>
                      ) : (
                        credentials.map((cred) => {
                          const isExpanded = expandedProviders.has(cred.providerId);
                          const isCurrentProvider = currentSession?.model?.providerId === cred.providerId;
                          return (
                            <div key={cred.providerId}>
                              <button
                                onClick={() => toggleProvider(cred.providerId)}
                                className={cn(
                                  'flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-accent',
                                  isCurrentProvider && 'bg-accent/30',
                                )}
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                                )}
                                <Key className="h-3 w-3 shrink-0 text-muted-foreground" />
                                <span className="flex-1 truncate font-medium text-foreground">{cred.label}</span>
                                {cred.models.length > 0 && (
                                  <span className="text-[9px] text-muted-foreground">{cred.models.length}</span>
                                )}
                              </button>
                              {isExpanded && (
                                <div className="border-l border-border/30 ml-3">
                                  {cred.models.length === 0 ? (
                                    <div className="px-2 py-1 text-[9px] text-muted-foreground/70">
                                      未配置模型
                                    </div>
                                  ) : (
                                    cred.models.map((m) => {
                                      const isCurrentModel = isCurrentProvider &&
                                        currentSession?.model?.id === m.id;
                                      return (
                                        <button
                                          key={`${cred.providerId}:${m.id}`}
                                          onClick={() => handleSetModel(
                                            cred.providerId,
                                            m.id,
                                            m.name,
                                            cred.providerId,
                                          )}
                                          className={cn(
                                            'flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left text-xs hover:bg-accent',
                                            isCurrentModel && 'bg-accent/50',
                                          )}
                                        >
                                          <div className="flex items-center gap-1">
                                            {isCurrentModel && <Check className="h-2.5 w-2.5 text-primary" />}
                                            <span className="font-medium text-foreground">{m.name}</span>
                                          </div>
                                          <span className="text-[9px] text-muted-foreground">{m.id}</span>
                                          <span className="text-[9px] text-muted-foreground/70">
                                            上下文 {(m.contextWindow / 1000).toFixed(0)}k
                                          </span>
                                        </button>
                                      );
                                    })
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
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
            <div className="flex items-center gap-1">
              {currentSession && (
                <ContextUsageIndicator session={currentSession} onCompact={compactSession} />
              )}
              {isSending ? (
                <button
                  onClick={abortSession}
                  title="中止"
                  aria-label="中止"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                >
                  <Square className="h-3 w-3 fill-current" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!inputMessage.trim() || !currentSessionId || isCurrentSessionCreating}
                  title="发送"
                  aria-label="发送"
                  className="flex h-7 w-7 shrink-0 translate-y-[-1px] items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
        </BorderBeam>
      </div>
    </div>
  );
}

/**
 * AI 会话固定右栏（docked 模式外壳）：宽度可调，渲染在 workspace 视图右侧。
 * 内容复用 RightPanelContent。
 * 顶部提供「解除固定」按钮，切换回抽屉浮窗模式。
 */
export function RightPanel({ width }: RightPanelProps) {
  const setAiPanelMode = useUiStore((s) => s.setAiPanelMode);
  const toggleRightDrawer = useUiStore((s) => s.toggleRightDrawer);

  /** 解除固定：切回抽屉模式并自动打开右抽屉，保持 AI 面板内容不中断。 */
  const handleUnpin = () => {
    setAiPanelMode('drawer');
    // 延迟一帧打开抽屉，确保 mode 切换后 AiDrawer 已挂载
    requestAnimationFrame(() => toggleRightDrawer());
  };

  return (
    <aside
      className="flex shrink-0 flex-col border-l bg-sidebar"
      style={{ width: `${width}px` }}
    >
      {/* 解除固定栏 */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">AI 验证助手</span>
        <button
          type="button"
          onClick={handleUnpin}
          className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="解除固定，切换为侧滑浮窗模式"
          data-testid="ai-docked-unpin"
        >
          <PanelLeftClose className="size-3" />
          解除固定
        </button>
      </div>
      <RightPanelContent />
    </aside>
  );
}

// ── 消息渲染组件 ───────────────────────────────────────

/**
 * 流式输出光标。
 * 单独抽出并 memo 化：父组件 MessageBubble 在流式期间每次 content 更新都会重渲染，
 * 但 StreamingCursor 的 DOM 节点和 CSS 动画不应被重建——否则频繁重渲染会让
 * `animate-pulse` 不断从 0% 重启，看起来像「不闪烁」。memo + 稳定 className
 * 让 React 复用同一个 DOM 节点，动画持续运行而不被打断。
 */
const StreamingCursor = memo(function StreamingCursor() {
  return <span aria-hidden className="ap-cursor" />;
});

/** 用户消息悬停时间戳：同日 HH:mm / 同年 M月D日 HH:mm / 更早 Y年M月D日 HH:mm */
function formatMsgTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hm;
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/**
 * AI 等待响应指示器——品牌渐变流光文字 + 等宽计时器。
 *
 * 当 session 处于 streaming/tool_executing 但没有正在流式输出的 assistant 消息时
 * 显示在消息列表底部，让用户知道 AI 正在工作（例如工具执行完毕后
 * 等待 LLM 生成下一段回复的间隙）。
 */
const RunningIndicator = memo(function RunningIndicator() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  return (
    <div className="flex min-h-[26px] items-center gap-1.5" data-testid="running-indicator">
      <span className="flex size-6 shrink-0 items-center justify-center">
        <ThinkingOrb state="composing" size={20} theme="auto" />
      </span>
      <span className="ap-shimmer text-xs">深度思考中…</span>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{mm}:{ss}</span>
    </div>
  );
});

function MessageBubble({ message, session }: { message: ChatMessage; session?: SessionEntry }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  if (message.role === 'tool') {
    return <ToolCard message={message} />;
  }

  // System notices (MCP mounts, engine warnings): subtle centered chip that
  // stays in the transcript — never mixed into the assistant's reply text.
  if (message.role === 'system') {
    return (
      <div className="flex justify-center py-0.5">
        <span
          className="inline-flex max-w-[80%] items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
          title={message.content}
        >
          <Info className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{message.content}</span>
        </span>
      </div>
    );
  }

  const isUser = message.role === 'user';

  // Helper: normalise image src — handle both full data URLs (new) and
  // raw base64 strings (legacy persisted messages).
  const imgSrc = (img: string): string =>
    img.startsWith('data:') ? img : `data:image/png;base64,${img}`;

  // User messages: right-aligned DSH bubble with optional images + hover meta
  if (isUser) {
    return (
      <>
        <div className="group flex flex-col items-end gap-1">
          <div className="max-w-[88%] rounded-2xl bg-[var(--dsw-bubble)] px-3 py-2 text-xs leading-5 text-foreground">
            {message.skills && message.skills.length > 0 && (
              <div className="mb-1.5 flex flex-wrap justify-end gap-1">
                {message.skills.map((skill) => (
                  <span
                    key={`skill-${skill.name}`}
                    className="inline-flex items-center gap-1 rounded bg-[var(--dsw-blue-tertiary)] px-1.5 py-0.5 text-[10px] font-medium text-primary"
                  >
                    <Sparkles className="h-2.5 w-2.5" />
                    <span className="max-w-[120px] truncate">{skill.name}</span>
                  </span>
                ))}
              </div>
            )}
            {message.images && message.images.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {message.images.map((img, idx) => (
                  <img
                    key={idx}
                    src={imgSrc(img)}
                    alt={`image-${idx}`}
                    className="max-h-32 max-w-[200px] cursor-pointer rounded border border-border/50 object-cover transition-opacity hover:opacity-80"
                    onClick={() => setLightboxSrc(imgSrc(img))}
                  />
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          </div>
          {/* 悬停显现：复制 + 时间戳（DSH 用户消息操作行） */}
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              onClick={() => void navigator.clipboard.writeText(message.content)}
              title="复制"
              aria-label="复制消息"
              className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Copy className="h-2.5 w-2.5" />
            </button>
            <span
              title={formatMsgTime(message.timestamp)}
              className="flex h-5 w-5 items-center justify-center text-muted-foreground/70"
            >
              <Clock className="h-2.5 w-2.5" />
            </span>
          </div>
        </div>
        {lightboxSrc && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onClick={() => setLightboxSrc(null)}
          >
            <img
              src={lightboxSrc}
              alt="full-size"
              className="max-h-full max-w-full rounded-lg object-contain"
            />
          </div>
        )}
      </>
    );
  }

  // Assistant messages: render thinking block + content
  // TV AI sessions: detect JSON suggestion and render visual card
  const isTVSession = session?.tvViolationId !== undefined;
  const isStreaming = !!message.isStreaming;
  const canRenderTVCard = isTVSession && !isStreaming && message.role === 'assistant' && message.content.trim().length > 0;

  return (
    <div className="flex flex-col gap-0.5">
      {message.thinking && (
        <ThinkingBlock
          thinking={message.thinking}
          isStreaming={isStreaming}
          hasContent={!!message.content}
        />
      )}
      {canRenderTVCard ? (
        <TVAISuggestionCardRenderer content={message.content} violationId={session!.tvViolationId!} />
      ) : message.content?.trimStart().startsWith('[错误]') ? (
        <ErrorMessage content={message.content} />
      ) : message.content ? (
        <MarkdownRenderer content={message.content} />
      ) : (
        isStreaming && !message.thinking && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="text-[10px]">思考中...</span>
          </div>
        )
      )}
      {isStreaming && message.content && <StreamingCursor />}
    </div>
  );
}

// ToolCard is now imported from '@renderer/components/chat/ToolCard'

// ── TV AI Suggestion 渲染包装器 ────────────────────────────

/**
 * 尝试用 TVAISuggestionCard 渲染 TV AI 建议 JSON。
 * 如果内容不是有效的 TV 建议 JSON，回退到 MarkdownRenderer。
 */
function TVAISuggestionCardRenderer({ content, violationId }: { content: string; violationId: number }) {
  // 先尝试渲染卡片；如果 TVAISuggestionCard 返回 null（无法解析），回退到 Markdown
  return (
    <TVAISuggestionCardFallback content={content} violationId={violationId} />
  );
}

function TVAISuggestionCardFallback({ content, violationId }: { content: string; violationId: number }) {
  // TVAISuggestionCard 内部会尝试解析 JSON，失败时返回 null
  // 我们用一个隐藏的检测来决定是否回退
  const tryParse = (() => {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null && ('confirmer' in parsed || 'result' in parsed)) {
        return true;
      }
    } catch {
      // 尝试 markdown 代码块
      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        try {
          const parsed = JSON.parse(codeBlockMatch[1].trim());
          if (typeof parsed === 'object' && parsed !== null && ('confirmer' in parsed || 'result' in parsed)) {
            return true;
          }
        } catch {
          // 继续
        }
      }
      // 尝试 { ... } 块
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (typeof parsed === 'object' && parsed !== null && ('confirmer' in parsed || 'result' in parsed)) {
            return true;
          }
        } catch {
          // 解析失败
        }
      }
    }
    return false;
  })();

  if (tryParse) {
    return <TVAISuggestionCard content={content} violationId={violationId} />;
  }
  // 回退到普通 Markdown 渲染
  return <MarkdownRenderer content={content} />;
}

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
                          <span className="shrink-0 rounded-full bg-status-pass/15 px-1.5 py-0.5 text-[9px] font-medium text-status-pass-foreground">
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
