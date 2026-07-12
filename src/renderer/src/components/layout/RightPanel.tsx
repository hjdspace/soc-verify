import { useEffect, useRef, useState, useCallback } from 'react';
import { Plus, Send, Square, MessageSquare, Trash2, ChevronDown, Loader2, Clock, Pencil, X, Check, Paperclip, Cpu, Compass } from 'lucide-react';
import { useSessionStore, type ChatMessage, type AvailableModel } from '@renderer/stores/session';
import { useProjectStore } from '@renderer/stores/project';
import { MarkdownRenderer } from '@renderer/components/chat/MarkdownRenderer';
import { cn } from '@renderer/lib/utils';

interface RightPanelProps {
  width: number;
}

export function RightPanel({ width }: RightPanelProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const createSession = useSessionStore((s) => s.createSession);
  const destroySession = useSessionStore((s) => s.destroySession);
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
  const [showSessionList, setShowSessionList] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [hasRestored, setHasRestored] = useState(false);
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [steerText, setSteerText] = useState('');
  const [showSteerInput, setShowSteerInput] = useState(false);

  const steerSession = useSessionStore((s) => s.steerSession);
  const getAvailableModels = useSessionStore((s) => s.getAvailableModels);
  const setModel = useSessionStore((s) => s.setModel);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const restoreSessions = useSessionStore((s) => s.restoreSessions);
  const renameSession = useSessionStore((s) => s.renameSession);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentSession?.messages]);

  // Auto-restore sessions when project is loaded
  useEffect(() => {
    if (currentProjectId && currentProject && !hasRestored) {
      restoreSessions(currentProjectId, currentProject.rootPath);
      setHasRestored(true);
    }
    // Reset restore flag when project changes
    if (!currentProjectId) {
      setHasRestored(false);
    }
  }, [currentProjectId, currentProject?.rootPath, hasRestored, restoreSessions]);

  const handleCreateSession = async () => {
    if (!currentProjectId || !currentProject) return;
    await createSession(currentProjectId, currentProject.rootPath);
    setShowSessionList(false);
  };

  const handleSend = async () => {
    if (!inputMessage.trim()) return;
    await sendMessage(inputMessage, attachedImages.length > 0 ? attachedImages : undefined);
    setAttachedImages([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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

  const handleRenameSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!editingSessionId || !editingSessionName.trim() || !currentProjectId) {
      setEditingSessionId(null);
      setEditingSessionName('');
      return;
    }
    await renameSession(editingSessionId, currentProjectId, editingSessionName.trim());
    setEditingSessionId(null);
    setEditingSessionName('');
  };

  const handleRenameCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(null);
    setEditingSessionName('');
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSave(e as unknown as React.MouseEvent);
    } else if (e.key === 'Escape') {
      handleRenameCancel(e as unknown as React.MouseEvent);
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
    if (!currentSessionId) return;
    const models = await getAvailableModels(currentSessionId);
    setAvailableModels(models);
    setShowModelDropdown(true);
  }, [currentSessionId, getAvailableModels]);

  const handleSetModel = async (provider: string, modelId: string) => {
    if (!currentSessionId) return;
    await setModel(currentSessionId, provider, modelId);
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

  return (
    <aside
      className="flex shrink-0 flex-col border-l bg-sidebar"
      style={{ width: `${width}px` }}
    >
      {/* ── 会话管理栏 ──────────────────────────────── */}
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <div className="relative">
          <button
            onClick={() => setShowSessionList(!showSessionList)}
            className="flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-semibold transition-colors hover:bg-accent"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {currentSession?.name ?? 'AI Agent'}
            <ChevronDown className="h-3 w-3 opacity-50" />
          </button>

          {showSessionList && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowSessionList(false)}
              />
              <div className="absolute left-0 top-8 z-50 w-64 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
                {/* 会话列表 */}
                {sessions.length > 0 && (
                  <div className="max-h-64 overflow-y-auto p-1">
                    {sessions.map((sess) => (
                      <div
                        key={sess.id}
                        className={cn(
                          'flex items-center justify-between rounded px-3 py-1.5 text-xs transition-colors hover:bg-accent',
                          sess.id === currentSessionId && 'bg-accent/50',
                        )}
                      >
                        <div className="flex-1 min-w-0 flex items-center gap-1">
                          {editingSessionId === sess.id ? (
                            <input
                              type="text"
                              value={editingSessionName}
                              onChange={(e) => setEditingSessionName(e.target.value)}
                              onKeyDown={handleRenameKeyDown}
                              onClick={(e) => e.stopPropagation()}
                              className="flex-1 min-w-0 bg-background border border-border rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                              autoFocus
                            />
                          ) : (
                            <span
                              className="truncate cursor-pointer"
                              onClick={() => {
                                switchSession(sess.id);
                                setShowSessionList(false);
                              }}
                              onDoubleClick={(e) => handleRenameStart(e, sess.id, sess.name)}
                            >
                              {sess.name}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5 ml-2">
                          {editingSessionId === sess.id ? (
                            <>
                              <button
                                onClick={handleRenameSave}
                                className="rounded p-0.5 text-green-500 hover:bg-green-500/10"
                                title="保存"
                              >
                                <Check className="h-3 w-3" />
                              </button>
                              <button
                                onClick={handleRenameCancel}
                                className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                                title="取消"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={(e) => handleRenameStart(e, sess.id, sess.name)}
                                className="rounded p-0.5 text-muted-foreground opacity-50 hover:opacity-100 hover:bg-accent"
                                title="重命名"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  destroySession(sess.id, currentProjectId || undefined);
                                }}
                                className="rounded p-0.5 text-muted-foreground opacity-50 hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                                title="删除"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* 空状态提示 */}
                {sessions.length === 0 && (
                  <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                    暂无 AI 会话
                  </div>
                )}

                {/* 新建会话按钮 */}
                <div className="border-t border-border/50 p-1">
                  <button
                    onClick={handleCreateSession}
                    disabled={!currentProjectId}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-primary transition-colors hover:bg-accent disabled:opacity-30"
                  >
                    <Plus className="h-3 w-3" />
                    新建会话
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <button
          onClick={handleCreateSession}
          disabled={!currentProjectId}
          title="新建会话"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── 消息列表 ────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {!currentSession ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              {currentProjectId ? '点击 + 创建 AI 会话' : '请先打开项目'}
            </p>
          </div>
        ) : currentSession.messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              开始与 AI Agent 对话，让它辅助你的验证工作
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

        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2">
          <textarea
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={currentSessionId ? '输入消息...' : '请先创建会话'}
            disabled={!currentSessionId}
            rows={3}
            className="resize-none bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {/* 图片附件按钮 */}
              <button
                onClick={handleImageSelect}
                disabled={!currentSessionId}
                title="附加图片"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
              >
                <Paperclip className="h-3 w-3" />
              </button>
              {/* 模型选择器 */}
              <div className="relative">
                <button
                  onClick={handleLoadModels}
                  disabled={!currentSessionId}
                  title="切换模型"
                  className="flex items-center gap-0.5 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
                >
                  <Cpu className="h-3 w-3" />
                </button>
                {showModelDropdown && availableModels.length > 0 && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowModelDropdown(false)} />
                    <div className="absolute bottom-7 left-0 z-50 max-h-48 w-56 overflow-y-auto rounded-md border border-border bg-popover shadow-xl">
                      {availableModels.map((m) => (
                        <button
                          key={`${m.provider}:${m.id}`}
                          onClick={() => handleSetModel(m.provider, m.id)}
                          className="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left text-xs hover:bg-accent"
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
                disabled={!inputMessage.trim() || !currentSessionId}
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

// ── 消息气泡组件 ───────────────────────────────────────

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'tool') {
    return <ToolCard message={message} />;
  }

  const isUser = message.role === 'user';

  return (
    <div
      className={cn(
        'flex flex-col gap-0.5',
        isUser ? 'items-end' : 'items-start',
      )}
    >
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs',
          isUser
            ? 'bg-primary/15 text-foreground'
            : 'bg-background text-foreground',
        )}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}

// ── 工具调用卡片 ───────────────────────────────────────

function ToolCard({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const isExecuting = !message.toolResult;
  const duration = message.toolStartTime && message.toolEndTime
    ? message.toolEndTime - message.toolStartTime
    : message.toolStartTime && !message.toolResult
      ? Date.now() - message.toolStartTime
      : null;

  return (
    <div className="rounded-md border border-border/60 bg-secondary/30 p-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <div className={cn('flex h-5 w-5 items-center justify-center rounded', isExecuting ? 'bg-primary/10' : 'bg-green-500/10')}>
          {isExecuting ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin text-primary" />
          ) : (
            <Square className="h-2.5 w-2.5 text-green-500" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-semibold text-foreground">
            {message.toolName ?? 'tool'}
          </div>
        </div>
        {duration != null && (
          <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground">
            <Clock className="h-2.5 w-2.5" />
            {duration > 1000 ? `${(duration / 1000).toFixed(1)}s` : `${duration}ms`}
          </span>
        )}
        <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1 border-t border-border/40 pt-1.5">
          {message.toolArgs != null && (
            <div>
              <div className="text-[9px] uppercase text-muted-foreground">参数</div>
              <pre className="mt-0.5 overflow-x-auto rounded bg-background/50 p-1 text-[10px]">
                {JSON.stringify(message.toolArgs, null, 2)}
              </pre>
            </div>
          )}
          {message.toolResult != null && (
            <div>
              <div className="text-[9px] uppercase text-muted-foreground">结果</div>
              <pre className="mt-0.5 max-h-48 overflow-auto rounded bg-background/50 p-1 text-[10px]">
                {typeof message.toolResult === 'string'
                  ? message.toolResult
                  : JSON.stringify(message.toolResult, null, 2)}
              </pre>
            </div>
          )}
          {isExecuting && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              执行中...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
