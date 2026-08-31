/**
 * DrawioPreview — .drawio 框图预览容器（中间页 destination='drawio-diagram'）。
 *
 * 布局：
 *   - 顶栏：文件名 + 导出按钮组（PNG / SVG / PDF / JPG）
 *   - 主体：DrawioViewer（官方 viewer-static.min.js，离线渲染）
 *
 * 导出与预览共用包内渲染内核（主进程隐藏窗口渲染，见主进程 viewer-exporter），
 * 不依赖 draw.io Desktop，无需安装检测。
 */

import { useCallback, useEffect, useState } from 'react';
import { FileDown, GitGraph, Loader2 } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from '@renderer/stores/toast';
import { cn } from '@renderer/lib/utils';
import { DrawioViewer } from './DrawioViewer';

export type DrawioPreviewProps = {
  filePath: string;
};

type ExportFormatId = 'png' | 'svg' | 'pdf' | 'jpg';

/** 导出按钮：格式 + 默认参数（与主进程 viewer-exporter 的格式规则对应） */
const EXPORT_BUTTONS: { id: ExportFormatId; label: string; scale?: number }[] = [
  { id: 'png', label: 'PNG', scale: 2 },
  { id: 'svg', label: 'SVG' },
  { id: 'pdf', label: 'PDF' },
  { id: 'jpg', label: 'JPG', scale: 2 },
];

type DiagramState =
  | { status: 'loading' }
  | { status: 'ok'; content: string }
  | { status: 'error'; message: string };

export function DrawioPreview({ filePath }: DrawioPreviewProps) {
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;

  const [diagramState, setDiagramState] = useState<DiagramState>({ status: 'loading' });
  const [exportingFormat, setExportingFormat] = useState<ExportFormatId | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  // 读取 .drawio XML
  useEffect(() => {
    let cancelled = false;
    setDiagramState({ status: 'loading' });
    setRenderError(null);
    trpc.drawio.readDiagram
      .query({ filePath })
      .then((r) => {
        if (!cancelled) setDiagramState({ status: 'ok', content: r.content });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDiagramState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const handleExport = useCallback(
    async (format: ExportFormatId, scale?: number) => {
      setExportingFormat(format);
      try {
        const picked = await trpc.drawio.pickExportPath.mutate({ sourcePath: filePath, format });
        if (!picked.outputPath) {
          return; // 用户取消保存对话框
        }
        const result = await trpc.drawio.export.mutate({
          inputPath: filePath,
          format,
          outputPath: picked.outputPath,
          scale,
        });
        useToastStore.getState().success(`已导出 ${format.toUpperCase()}`, result.outputPath);
      } catch (err) {
        useToastStore.getState().error(
          `导出 ${format.toUpperCase()} 失败`,
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        setExportingFormat(null);
      }
    },
    [filePath],
  );

  // ── 加载中 / 读取失败 ───────────────────────────────
  if (diagramState.status === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载框图...
      </div>
    );
  }

  if (diagramState.status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <GitGraph className="h-8 w-8 opacity-40" />
        <div className="font-medium text-foreground">无法读取框图文件</div>
        <p className="max-w-md text-xs">{diagramState.message}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* ── 顶栏：文件名 + 导出按钮 ───────────────────── */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-secondary/30 px-2">
        <GitGraph className="h-3.5 w-3.5 opacity-60" />
        <span className="max-w-64 truncate font-mono text-xs text-foreground">{fileName}</span>

        <div className="ml-auto flex items-center gap-1">
          {EXPORT_BUTTONS.map((btn) => (
            <button
              key={btn.id}
              type="button"
              onClick={() => void handleExport(btn.id, btn.scale)}
              disabled={exportingFormat !== null}
              title={`导出为 ${btn.label}`}
              className={cn(
                'flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors',
                'text-muted-foreground hover:bg-accent hover:text-foreground',
                'disabled:cursor-not-allowed disabled:text-muted-foreground/40',
              )}
            >
              {exportingFormat === btn.id ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <FileDown className="h-3 w-3" />
              )}
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── 渲染错误 / 框图主体 ──────────────────────── */}
      {renderError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <GitGraph className="h-8 w-8 opacity-40" />
          <div className="font-medium text-foreground">框图渲染失败</div>
          <p className="max-w-md font-mono text-xs">{renderError}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden bg-background p-2">
          <DrawioViewer xml={diagramState.content} onError={setRenderError} />
        </div>
      )}
    </div>
  );
}
