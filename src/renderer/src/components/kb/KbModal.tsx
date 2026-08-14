/**
 * KbModal — 知识库注册/挂载/卸载/切换对话框。
 *
 * 已注册库列表 + 挂载/卸载 + 注册新库的目录选择与结构提示。
 */

import { useState, useEffect, useCallback } from 'react';
import { BookOpen, X, Folder, Link2, Unlink, Check } from 'lucide-react';
import { useKbStore } from '@renderer/stores/kb';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

export function KbModal() {
  const kbList = useKbStore((s) => s.kbList);
  const kbStatus = useKbStore((s) => s.kbStatus);
  const setKbModalOpen = useKbStore((s) => s.setKbModalOpen);
  const mountKb = useKbStore((s) => s.mountKb);
  const unmountKb = useKbStore((s) => s.unmountKb);
  const registerKb = useKbStore((s) => s.registerKb);
  const loadKbList = useKbStore((s) => s.loadKbList);

  const [newKbName, setNewKbName] = useState('');
  const [newKbPath, setNewKbPath] = useState('');
  const [registering, setRegistering] = useState(false);

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

  // ── 注册新库 ─────────────────────────────────────────────
  const handleRegister = useCallback(async () => {
    if (!newKbName.trim() || !newKbPath.trim()) return;
    setRegistering(true);
    const success = await registerKb(newKbName.trim(), newKbPath.trim());
    setRegistering(false);
    if (success) {
      setNewKbName('');
      setNewKbPath('');
      await loadKbList();
    }
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
      <div className="w-[460px] rounded-[10px] bg-card p-5 shadow-2xl">
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
                        {kb.path} · {kb.documentCount} 文档
                      </span>
                    </div>
                    {isMounted ? (
                      <span className="flex shrink-0 items-center gap-1 text-[10px] text-status-pass-foreground">
                        <Check className="h-3 w-3" />
                        挂载中
                      </span>
                    ) : (
                      <button
                        onClick={() => void mountKb(kb.id)}
                        className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[10px] text-primary transition-colors hover:bg-accent"
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

        {/* 注册新库 */}
        <div className="mb-3">
          <label className="mb-1.5 block text-[11px] text-muted-foreground">
            注册新库（选择或输入目录，空目录将初始化结构）
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
              onChange={(e) => setNewKbPath(e.target.value)}
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

          {/* 结构提示 */}
          <div className="mt-2 rounded bg-secondary p-2.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
            &lt;kb&gt;/<br />
            ├── sources/&nbsp;&nbsp;&nbsp;# 原始文档副本（自包含，可整体迁移）<br />
            ├── docs/&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;# Markdown + assets/&lt;文档名&gt;/ 图片<br />
            └── index.md&nbsp;&nbsp;# AI 生成的目录索引（Agent 速查地图）
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
            onClick={handleRegister}
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
