/**
 * DrawioPreview — .drawio 框图预览容器（中间页 destination='drawio-diagram'）。
 *
 * 布局：
 *   - 顶栏：文件名 + 导出按钮组（PNG / SVG / PDF / JPG，走 draw.io desktop CLI）
 *   - 主体：DrawioViewer（官方 viewer-static.min.js，离线渲染）
 *
 * draw.io CLI 未安装时导出按钮禁用，显示引导条：
 *   - Windows / macOS：前往官网下载 draw.io Desktop（system.openExternal）
 *   - Linux：提示 `npm run download:drawio` 内置 CLI（Linux 打包已内置）
 */

import { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, FileDown, GitGraph, Loader2, RefreshCw } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from '@renderer/stores/toast';
import { cn } from '@renderer/lib/utils';
import { DrawioViewer } from './DrawioViewer';

export type DrawioPreviewProps = {
  filePath: string;
};

type ExportFormatId = 'png' | 'svg' | 'pdf' | 'jpg';

/** 导出按钮：格式 + CLI 参数默认值（与主进程 exporter 的格式规则对应） */
const EXPORT_BUTTONS: { id: ExportFormatId; label: string; scale?: number; crop?: boolean }[] = [
  { id: 'png', label: 'PNG', scale: 2 },
  { id: 'svg', label: 'SVG', crop: true },
  { id: 'pdf', label: 'PDF', crop: true },
  { id: 'jpg', label: 'JPG', scale: 2 },
];

type DiagramState =
  | { status: 'loading' }
  | { status: 'ok'; content: string }
  | { status: 'error'; message: string };

type InstallState =
  | { status: 'checking' }
  | { status: 'installed' }
  | { status: 'not-installed'; downloadUrl: string };

export function DrawioPreview({ filePath }: DrawioPreviewProps) {
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;

  const [diagramState, setDiagramState] = useState<DiagramState>({ status: 'loading' });
  const [installState, setInstallState] = useState<InstallState>({ status: 'checking' });
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

  // 检查 draw.io CLI
  const checkInstall = useCallback(() => {
    trpc.drawio.checkInstalled
      .query()
      .then((r) => {
        setInstallState(
          r.installed
            ? { status: 'installed' }
            : { status: 'not-installed', downloadUrl: r.downloadUrl },
        );
      })
      .catch(() => {
        setInstallState({
          status: 'not-installed',
          downloadUrl: 'https://github.com/jgraph/drawio-desktop/releases/latest',
        });
      });
  }, []);

  useEffect(() => {
    setInstallState({ status: 'checking' });
    checkInstall();
  }, [checkInstall]);

  const handleExport = useCallback(
    async (format: ExportFormatId, scale?: number, crop?: boolean) => {
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
          crop,
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

  const handleOpenDownloadPage = useCallback(async (url: string) => {
    try {
      await trpc.system.openExternal.mutate(url);
    } catch {
      useToastStore.getState().warning('打开下载页失败', url);
    }
  }, []);

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

  const isLinux = navigator.platform.toLowerCase().includes('linux');

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
              onClick={() => void handleExport(btn.id, btn.scale, btn.crop)}
              disabled={installState.status !== 'installed' || exportingFormat !== null}
              title={installState.status === 'installed' ? `导出为 ${btn.label}` : '需要 draw.io Desktop（未检测到）'}
              className={cn(
                'flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors',
                installState.status === 'installed'
                  ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  : 'cursor-not-allowed text-muted-foreground/40',
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

      {/* ── CLI 未安装引导条 ──────────────────────────── */}
      {installState.status === 'not-installed' && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-warning/10 px-3 py-1.5 text-[11px] text-warning-foreground">
          <Download className="h-3 w-3 shrink-0" />
          <span>
            未检测到 draw.io Desktop，导出功能不可用（预览不受影响）。{isLinux ? (
              <>Linux 打包版已内置 CLI；开发环境请运行 <code className="font-mono">npm run download:drawio</code>。</>
            ) : (
              <>安装 draw.io Desktop 后点击"重新检测"即可启用导出。</>
            )}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {!isLinux && (
              <button
                type="button"
                onClick={() => void handleOpenDownloadPage(installState.downloadUrl)}
                className="flex items-center gap-1 rounded border border-border bg-card px-2 py-0.5 transition-colors hover:bg-accent"
              >
                <ExternalLink className="h-3 w-3" />
                前往下载
              </button>
            )}
            <button
              type="button"
              onClick={checkInstall}
              className="flex items-center gap-1 rounded border border-border bg-card px-2 py-0.5 transition-colors hover:bg-accent"
            >
              <RefreshCw className="h-3 w-3" />
              重新检测
            </button>
          </div>
        </div>
      )}

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
