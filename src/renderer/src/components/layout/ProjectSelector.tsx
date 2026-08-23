/**
 * ProjectSelector — TitleBar 项目选择器（Issue #8）。
 *
 * 原型 .proj-selector：当前项目名 + 展开箭头，点击弹出已打开项目列表，
 * 复用 project store 的 switchProject（保存当前项目状态 → 切换 → 重载）。
 * 功能上取代旧面包屑「项目 › 子系统 › 用例」的上下文展示。
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderOpen } from 'lucide-react';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';

export function ProjectSelector() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const projects = useProjectStore((s) => s.projects);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const switchProject = useProjectStore((s) => s.switchProject);

  const current = projects.find((p) => p.id === currentProjectId);

  // 点击面板外关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelect = (projectId: string) => {
    setOpen(false);
    if (projectId !== currentProjectId) {
      void switchProject(projectId);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="切换项目"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          'titlebar-no-drag',
          'flex h-7 items-center gap-1.5 rounded px-2.5 text-xs transition-colors',
          'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
          open && 'bg-foreground/10 text-foreground',
        )}
      >
        <span className="size-2 shrink-0 rounded-full bg-status-pass" />
        <span className="max-w-[180px] truncate">{current?.name ?? '未打开项目'}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-[70] mt-1.5 w-64 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
          <div className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">已打开项目</div>
          {projects.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              暂无已打开项目，请先打开一个项目
            </div>
          ) : (
            projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelect(p.id)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
                  p.id === currentProjectId
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <FolderOpen className="size-3.5 shrink-0 opacity-70" />
                <span className="truncate">{p.name}</span>
                {p.id === currentProjectId && (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">当前</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
