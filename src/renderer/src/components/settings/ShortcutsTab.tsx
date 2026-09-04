import { Keyboard } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

/**
 * 快捷键地图 Tab — 展示全局快捷键。
 *
 * 数据来源：SHORTCUT_GROUPS 静态常量，需与 CommandPalette / NavRail / FileEditor 实现保持同步。
 */

/** 快捷键地图（Issue #9：与实现保持同步——CommandPalette / NavRail / FileEditor） */
const SHORTCUT_GROUPS: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ keys: string[]; action: string; context?: string }>;
}> = [
  {
    label: '全局',
    items: [
      { keys: ['Ctrl', 'K'], action: '命令面板（Ctrl+P 同效）' },
      { keys: ['Ctrl', 'P'], action: '命令面板' },
      { keys: ['Ctrl', '1'], action: '前往 总览视图' },
      { keys: ['Ctrl', '2'], action: '前往 仿真视图' },
      { keys: ['Ctrl', '3'], action: '前往 覆盖率视图' },
      { keys: ['Ctrl', '4'], action: '前往 回归视图' },
      { keys: ['Esc'], action: '关闭命令面板 / 抽屉 / 对话框' },
    ],
  },
  {
    label: '编辑器',
    items: [
      { keys: ['Ctrl', 'S'], action: '保存文件', context: '文件编辑器' },
      { keys: ['Ctrl', 'H'], action: '查找替换', context: '文件编辑器' },
    ],
  },
  {
    label: '其他',
    items: [
      { keys: ['Ctrl', 'F'], action: '聚焦搜索框', context: '用例树' },
    ],
  },
];

export function ShortcutsTab() {
  return (
    <div className="space-y-5" data-testid="shortcuts-tab">
      <div>
        <h3 className="text-sm font-semibold text-foreground">快捷键</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          全局快捷键地图。命令面板（Ctrl+K）中可执行导航、动作与面板命令。
        </p>
      </div>
      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">
            <Keyboard className="h-3 w-3" />
            {group.label}
          </div>
          <div className="overflow-hidden rounded-md border border-border/60">
            {group.items.map((item, i) => (
              <div
                key={`${item.action}-${i}`}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 text-xs',
                  i % 2 === 0 ? 'bg-secondary/20' : 'bg-transparent',
                )}
              >
                <span className="flex w-36 shrink-0 items-center gap-1">
                  {item.keys.map((k) => (
                    <kbd
                      key={k}
                      className="rounded border border-border bg-accent/40 px-1.5 py-px font-mono text-[10px] text-muted-foreground"
                    >
                      {k}
                    </kbd>
                  ))}
                </span>
                <span className="flex-1 text-foreground">{item.action}</span>
                {item.context && (
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">{item.context}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
