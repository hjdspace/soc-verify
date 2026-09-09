/**
 * 解析回归指令对话框。
 *
 * 复刻 Python GUI（runsim_r3p0）`controllers/config_controller.py` 的
 * `parse_regr_command()` + `do_parse_command()`：粘贴从网页复制的完整
 * 回归指令（可能含前后噪音文本/HTML 标签/换行），解析提取 runsim
 * 命令参数后填入仿真 Option 面板。
 *
 * 解析本身由 `parseRunsimCommand()`（runsim-command.ts Part 1c）完成，
 * 对话框只负责文本输入与触发。
 */

import { Wand2, X } from 'lucide-react';

export type ParseCommandDialogProps = {
  text: string;
  onChange: (value: string) => void;
  onParse: () => void;
  onClose: () => void;
};

export function ParseCommandDialog({
  text,
  onChange,
  onParse,
  onClose,
}: ParseCommandDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={onClose}
      data-testid="sim-parse-dialog"
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-border bg-popover p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Dialog header */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">解析回归指令</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Hint */}
        <p className="mb-2 text-xs text-muted-foreground">
          请粘贴回归用例指令（支持从网页直接复制粘贴，系统会自动提取 runsim 命令）
        </p>

        {/* Textarea */}
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            '可以直接粘贴从网页复制的完整回归指令，系统会自动提取 runsim 命令部分\n\n示例:\n1. 完整指令: [其他文本] runsim -base top -block udtb/usvp -case apcpu_hello_world ...\n2. 简化指令: runsim -base top -block udtb/usvp -case apcpu_hello_world ...'
          }
          className="h-32 w-full resize-y rounded border border-border bg-background/60 px-2.5 py-2 font-mono text-[11px] outline-none transition-colors focus:border-primary"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              onParse();
            }
          }}
        />

        {/* Dialog footer */}
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/60">Ctrl+Enter 解析</span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              取消
            </button>
            <button
              onClick={onParse}
              disabled={!text.trim()}
              className="flex items-center gap-1.5 rounded bg-primary px-4 py-1 text-xs font-semibold text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Wand2 className="h-3 w-3" />
              解析
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
