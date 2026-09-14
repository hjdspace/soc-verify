/**
 * KbModal — 知识库注册/挂载/卸载/切换对话框。
 *
 * 已注册库列表（含格式与可达性状态）+ 挂载/卸载 + 注册新库。
 * 复制库冲突（kbIdConflict）时提供「注册为副本」入口（asCopy）；
 * 旧格式处置记录在此展示并可移除记录（不触碰库目录）。
 *
 * @see ADR 0034 — 知识库重构为 LLM Wiki 双层架构
 */

import { useState, useEffect, useCallback } from 'react';
import { BookOpen, X, Folder, Link2, Unlink, Check, AlertTriangle, ArchiveX } from 'lucide-react';
import { useKbStore } from '@renderer/stores/kb';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

export function KbModal() {
  const kbList = useKbStore((s) => s.kbList);
  const kbStatus = useKbStore((s) => s.kbStatus);
  const kbDisposals = useKbStore((s) => s.kbDisposals);
  const loadDisposals = useKbStore((s) => s.loadDisposals);
  const dismissDisposal = useKbStore((s) => s.dismissDisposal);
  const setKbModalOpen = useKbStore((s) => s.setKbModalOpen);
  const mountKb = useKbStore((s) => s.mountKb);
  const unmountKb = useKbStore((s) => s.unmountKb);
  const registerKb = useKbStore((s) => s.registerKb);
  const loadKbList = useKbStore((s) => s.loadKbList);

  const [newKbName, setNewKbName] = useState('');
  const [newKbPath, setNewKbPath] = useState('');
  const [registering, setRegistering] = useState(false);
  /** 复制库冲突提示（可注册为副本） */
  const [copyConflictHint, setCopyConflictHint] = useState<string | null>(null);

  // ── 打开时加载处置记录 ───────────────────────────────────
  useEffect(() => {
    void loadDisposals();
  }, [loadDisposals]);

  // ── 点击遮罩关闭 ─────────────────────────────────────────
  const handleMaskClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setKbModalOpen(false);
    }
  }, [setKbModalOpen]);

  // ── 选择目录 ─────────────────────────────────────────────
  const handleBrowse = useCallback(async () => {
    try {
      const result = await trpc.scan.pickDirectory.mutate({ defaultPath: undefined });
      if (!result.canceled && result.path) {
        setNewKbPath(result.path);
        setCopyConflictHint(null);
        // 如果没有输入库名，用目录名填充
        if (!newKbName) {
          const parts = result.path.split(/[/\\]/);
          setNewKbName(parts[parts.length - 1] || '知识库');
        }
      }
    } catch {
      // best-effort
    }
  }, [newKbName]);

  // ── 注册新库（冲突时可注册为副本） ────────────────────────
  const handleRegister = useCallback(async (asCopy = false) => {
    if (!newKbName.trim() || !newKbPath.trim()) return;
    setRegistering(true);
    const outcome = await registerKb(newKbName.trim(), newKbPath.trim(), asCopy);
    setRegistering(false);
    if (outcome.ok) {
      setNewKbName('');
      setNewKbPath('');
      setCopyConflictHint(null);
      await loadKbList();
      return;
    }
    setCopyConflictHint(outcome.errorCode === 'kbIdConflict' ? (outcome.message ?? null) : null);
  }, [newKbName, newKbPath, registerKb, loadKbList]);

  // ── ESC 关闭 ──────────────────────────────────────────────
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setKbModalOpen(false);
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [setKbModalOpen]);

  const mountedKbId = kbStatus?.mounted?.kbId;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35"
      onClick={handleMaskClick}
    >
      <div className="max-h-[85vh] w-[500px] overflow-y-auto rounded-[10px] bg-card p-5 shadow-2xl">
        {/* 标题 */}
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">知识库</h2>
          <button
            onClick={() => setKbModalOpen(false)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mb-4 text-[11px] text-muted-foreground">
          应用级注册，项目设置中选择挂载；v1 单库挂载
        </p>

        {/* 已注册的库列表 */}
        <div className="mb-3">
          <label className="mb-1.5 block text-[11px] text-muted-foreground">已注册的库</label>
          {kbList.length === 0 ? (
            <div className="rounded border border-border px-3 py-2 text-[11px] text-muted-foreground">
              暂无已注册的知识库
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {kbList.map((kb) => {
                const isMounted = kb.id === mountedKbId;
                const unreachable = kb.state === 'unreadable';
                const structureChanged = kb.state === 'structureChanged';
                return (
                  <div
                    key={kb.id}
                    className={cn(
                      'flex items-center justify-between rounded border border-border px-3 py-2 text-xs',
                      isMounted && 'border-primary/30 bg-primary/5',
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">{kb.name}</span>
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {kb.path}
                      </span>
                      {unreachable && (
                        <span
                          title={kb.stateReason ? `不可访问（${kb.stateReason}）：磁盘离线或权限不足，登记已保留` : '目录不可访问，登记已保留'}
                          className="flex shrink-0 items-center gap-0.5 text-[10px] text-status-warn-foreground"
                        >
                          <AlertTriangle className="h-3 w-3" />
                          不可达
                        </span>
                      )}
                      {structureChanged && (
                        <span
                          title="目录内容与登记格式不符（可能被替换或清空）"
                          className="flex shrink-0 items-center gap-0.5 text-[10px] text-status-warn-foreground"
                        >
                          <AlertTriangle className="h-3 w-3" />
                          结构异常
                        </span>
                      )}
                    </div>
                    {isMounted ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="flex items-center gap-1 text-[10px] text-status-pass-foreground">
                          <Check className="h-3 w-3" />
                          挂载中
                        </span>
                        <button
                          onClick={() => void unmountKb(kb.id)}
                          title="卸载"
                          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <Unlink className="h-3 w-3" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => void mountKb(kb.id)}
                        disabled={unreachable || structureChanged}
                        title={unreachable ? '目录不可访问，无法挂载' : structureChanged ? '目录结构与登记不符，无法挂载' : '挂载'}
                        className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[10px] text-primary transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Link2 className="h-3 w-3" />
                        挂载
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 已挂载库的卸载按钮 */}
        {mountedKbId && (
          <div className="mb-3">
            <button
              onClick={() => void unmountKb(mountedKbId)}
              className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Unlink className="h-3 w-3" />
              卸载当前知识库
            </button>
          </div>
        )}

        {/* 旧格式处置记录 */}
        {kbDisposals.length > 0 && (
          <div className="mb-3">
            <label className="mb-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <ArchiveX className="h-3 w-3" />
              旧格式库处置记录（已停用，文件未被删除）
            </label>
            <div className="flex flex-col gap-1">
              {kbDisposals.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between rounded border border-border/60 bg-secondary/40 px-3 py-1.5 text-[11px]"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{d.name}</div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">{d.path}</div>
                  </div>
                  <button
                    onClick={() => void dismissDisposal(d.id)}
                    title="仅移除处置记录，不触碰库目录"
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    移除记录
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 注册新库 */}
        <div className="mb-3">
          <label className="mb-1.5 block text-[11px] text-muted-foreground">
            注册新库（选择或输入目录，将自动初始化知识库结构）
          </label>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={newKbName}
              onChange={(e) => setNewKbName(e.target.value)}
              placeholder="库名称"
              className="h-7 w-28 rounded border border-border bg-background px-2 text-xs outline-none focus:border-primary"
            />
            <input
              type="text"
              value={newKbPath}
              onChange={(e) => {
                setNewKbPath(e.target.value);
                setCopyConflictHint(null);
              }}
              placeholder="目录路径"
              className="h-7 flex-1 rounded border border-border bg-background px-2 font-mono text-xs outline-none focus:border-primary"
            />
            <button
              onClick={handleBrowse}
              className="flex h-7 items-center gap-1 rounded border border-border bg-background px-2 text-xs transition-colors hover:bg-accent"
            >
              <Folder className="h-3 w-3" />
              浏览
            </button>
          </div>

          {/* 复制库冲突提示 + 注册为副本入口 */}
          {copyConflictHint && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded border border-status-warn-foreground/30 bg-status-warn-foreground/5 px-2.5 py-2 text-[11px]">
              <span className="min-w-0 flex-1">{copyConflictHint}</span>
              <button
                onClick={() => void handleRegister(true)}
                disabled={registering}
                className="shrink-0 rounded bg-primary px-2 py-1 text-[10px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                注册为副本
              </button>
            </div>
          )}

          {/* 布局提示 */}
          <div className="mt-2 rounded bg-secondary p-2.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
            &lt;kb&gt;/<br />
            ├── schema.md&nbsp;&nbsp;&nbsp;# 写作规则 + Page Types 路由<br />
            ├── purpose.md&nbsp;&nbsp;&nbsp;# 库目标描述<br />
            ├── raw/&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;# sources/ revisions/ parsed/ assets/<br />
            ├── wiki/&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;# 知识页（编译发布）<br />
            └── .kb/&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;# manifest.json（库身份）+ 元数据
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={() => setKbModalOpen(false)}
            className="rounded border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
          >
            关闭
          </button>
          <button
            onClick={() => void handleRegister(false)}
            disabled={registering || !newKbName.trim() || !newKbPath.trim()}
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {registering ? '注册中...' : '注册'}
          </button>
        </div>
      </div>
    </div>
  );
}
