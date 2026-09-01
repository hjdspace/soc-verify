import { useEffect, useState } from 'react';
import { FlaskConical, RotateCcw } from 'lucide-react';
import { useSettingsStore } from '@renderer/stores/settings';
import { cn } from '@renderer/lib/utils';

/**
 * 仿真 Tab — 仿真执行偏好设置。
 *
 * 当前设置项：
 *  - 日志模式执行仿真（preferLogMode）：启用后仿真命令直接以 log-mode
 *    （`shell -c` 只读日志模式）执行，不再探测/依赖 node-pty。
 *    未启用时保持默认行为：交互式 PTY 终端，node-pty 不可用时自动回退
 *    到 log-mode。
 */
export function SimulationSettingsTab() {
  const preferLogMode = useSettingsStore((s) => s.preferLogMode);
  const loadPreferLogMode = useSettingsStore((s) => s.loadPreferLogMode);
  const setPreferLogMode = useSettingsStore((s) => s.setPreferLogMode);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    void loadPreferLogMode();
  }, [loadPreferLogMode]);

  const handleToggle = async () => {
    setToggling(true);
    try {
      await setPreferLogMode(!preferLogMode);
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
          <FlaskConical className="h-3 w-3" />
          仿真执行
        </div>

        <div className="rounded-md border border-border/50 bg-secondary/20 p-3">
          <div className="flex items-center gap-2">
            <button
              onClick={handleToggle}
              disabled={toggling}
              aria-label="启用日志模式执行仿真"
              className={cn(
                'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                preferLogMode ? 'bg-primary' : 'bg-muted',
              )}
            >
              <span
                className={cn(
                  'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-background transition-transform',
                  preferLogMode ? 'translate-x-4' : 'translate-x-0',
                )}
              />
            </button>
            <span className="text-xs font-medium">日志模式执行仿真（log mode）</span>
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
            {preferLogMode
              ? '已启用：仿真命令将以只读日志模式（shell -c）直接执行，输出流式展示在终端视图中，不创建交互式终端。'
              : '未启用（默认）：仿真在交互式终端中执行；当 node-pty 不可用时自动回退到日志模式。'}
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/60">
            适用场景：AppImage 等环境下 node-pty 原生模块无法加载，或希望仿真以纯日志方式运行时，可开启此选项。
          </p>
        </div>
      </div>

      {/* 恢复默认 */}
      <div className="flex justify-end border-t border-border/50 pt-3">
        <button
          onClick={handleToggle}
          disabled={toggling || !preferLogMode}
          className={cn(
            'flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors',
            preferLogMode && !toggling
              ? 'bg-muted text-foreground hover:bg-accent'
              : 'cursor-not-allowed bg-muted text-muted-foreground',
          )}
        >
          <RotateCcw className="h-3 w-3" />
          恢复默认（交互式终端）
        </button>
      </div>
    </div>
  );
}
