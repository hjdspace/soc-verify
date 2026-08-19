import { useState, useEffect } from 'react';
import { onVimModeChange, getVimMode, type VimMode } from './vim-extension';
import { cn } from '@renderer/lib/utils';

// ── Vim 模式显示配置 ──────────────────────────────────────────

const MODE_DISPLAY: Record<VimMode, { label: string; colorClass: string }> = {
  normal: { label: 'NORMAL', colorClass: 'text-[var(--vim-normal)] bg-[color-mix(in_oklch,var(--vim-normal)_15%,transparent)]' },
  insert: { label: 'INSERT', colorClass: 'text-[var(--vim-insert)] bg-[color-mix(in_oklch,var(--vim-insert)_15%,transparent)]' },
  visual: { label: 'VISUAL', colorClass: 'text-[var(--vim-visual)] bg-[color-mix(in_oklch,var(--vim-visual)_15%,transparent)]' },
  command: { label: 'COMMAND', colorClass: 'text-[var(--vim-command)] bg-[color-mix(in_oklch,var(--vim-command)_15%,transparent)]' },
};

// ── VimStatusBar 组件 ─────────────────────────────────────────

interface VimStatusBarProps {
  /** 是否显示 Vim 状态栏（通常由 vimEnabled 决定） */
  visible: boolean;
}

export function VimStatusBar({ visible }: VimStatusBarProps) {
  const [mode, setMode] = useState<VimMode>(getVimMode());

  useEffect(() => {
    if (!visible) return;
    // 同步当前模式
    setMode(getVimMode());
    // 订阅模式变化
    const unsubscribe = onVimModeChange((newMode) => {
      setMode(newMode);
    });
    return unsubscribe;
  }, [visible]);

  if (!visible) return null;

  const display = MODE_DISPLAY[mode];

  return (
    <div
      className="flex items-center gap-2 border-t bg-secondary/30 px-3 py-0.5"
      data-testid="vim-status-bar"
    >
      <span
        className={cn(
          'inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold tracking-wider',
          display.colorClass,
        )}
        data-testid="vim-mode-badge"
        data-vim-mode={mode}
      >
        {display.label}
      </span>
    </div>
  );
}
