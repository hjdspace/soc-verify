/**
 * OfficeDocumentView — Office 文档预览容器组件。
 *
 * 根据 destination 的 mode / previewMode / 文件扩展名分发到子组件：
 *   - mode='edit'（.xlsx）：显示"编辑能力将在后续版本提供"占位
 *   - mode='preview'：
 *     - .pdf：显示"PDF 预览即将支持"占位
 *     - .docx/.pptx：按 previewMode 分发到 Html/Screenshots/Watch 子组件
 *
 * 预览模式切换栏（HTML/Screenshots/Watch 按钮组）仅对 .docx/.pptx 显示。
 *
 * officecli 不可用（document.checkInstalled 返回 false）时：
 *   显示"officecli 未安装"提示 + 下载按钮（仅开发模式可见）。
 */
import { useEffect, useState } from 'react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import { FileText, Download } from 'lucide-react';
import { HtmlPreview } from './HtmlPreview';
import { ScreenshotsPreview } from './ScreenshotsPreview';
import { WatchPreview } from './WatchPreview';
import { PdfPreview } from './PdfPreview';
import { XlsxEditor } from './XlsxEditor';
import type { OfficePreviewMode } from '@renderer/stores/workbench';

export type OfficeDocumentViewProps = {
  filePath: string;
  mode: 'preview' | 'edit';
  previewMode?: OfficePreviewMode;
};

type InstalledState =
  | { status: 'checking' }
  | { status: 'installed' }
  | { status: 'not-installed' };

/** 从文件路径提取扩展名（小写，无前导点） */
function getExt(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return '';
  return filePath.slice(dot + 1).toLowerCase();
}

/** 预览模式切换栏选项 */
const PREVIEW_MODES: { id: OfficePreviewMode; label: string }[] = [
  { id: 'html', label: 'HTML' },
  { id: 'screenshots', label: 'Screenshots' },
  { id: 'watch', label: 'Watch' },
];

export function OfficeDocumentView({ filePath, mode, previewMode }: OfficeDocumentViewProps) {
  const ext = getExt(filePath);
  // PDF 与 .xlsx edit 模式不显示切换栏
  const showSwitchBar = ext === 'docx' || ext === 'pptx';

  // 预览模式本地状态：从 props 初始化，但允许通过切换栏动态修改
  const [activePreview, setActivePreview] = useState<OfficePreviewMode>(previewMode ?? 'html');

  // officecli 安装检查状态
  const [installState, setInstallState] = useState<InstalledState>({ status: 'checking' });

  useEffect(() => {
    let cancelled = false;
    setInstallState({ status: 'checking' });
    trpc.document.checkInstalled
      .query()
      .then((r) => {
        if (cancelled) return;
        setInstallState(r.installed ? { status: 'installed' } : { status: 'not-installed' });
      })
      .catch(() => {
        if (cancelled) return;
        // 查询失败保守视为不可用，避免误导
        setInstallState({ status: 'not-installed' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // officecli 不可用降级：显示提示 + 下载按钮（开发模式可见）
  if (installState.status === 'not-installed') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <FileText className="h-8 w-8 opacity-40" />
        <div className="font-medium text-foreground">officecli 未安装</div>
        <p className="max-w-md text-xs leading-relaxed">
          Office 文档预览依赖 officecli 二进制。请在终端运行下方命令下载并安装后重启应用。
        </p>
        {/* 仅开发模式可见下载提示按钮 */}
        {import.meta.env?.DEV && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-1.5 text-xs">
            <Download className="h-3.5 w-3.5 opacity-70" />
            <code className="font-mono">npm run download:officecli</code>
          </div>
        )}
      </div>
    );
  }

  // 检查中：避免闪烁
  if (installState.status === 'checking') {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        检查 officecli 可用性...
      </div>
    );
  }

  // PDF 预览：使用 react-pdf 渲染（Issue #4 实现）
  if (ext === 'pdf') {
    return <PdfPreview filePath={filePath} />;
  }

  // edit 模式：.xlsx 原地编辑（Issue #5 实现）
  if (mode === 'edit') {
    return <XlsxEditor filePath={filePath} />;
  }

  // preview 模式分发
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {showSwitchBar && (
        <div className="flex shrink-0 items-center gap-1 border-b bg-secondary/30 px-2 py-1">
          {PREVIEW_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setActivePreview(m.id)}
              className={cn(
                'rounded px-2 py-1 text-[11px] transition-colors',
                activePreview === m.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {activePreview === 'html' && <HtmlPreview filePath={filePath} />}
        {activePreview === 'screenshots' && <ScreenshotsPreview filePath={filePath} />}
        {activePreview === 'watch' && <WatchPreview filePath={filePath} />}
      </div>
    </div>
  );
}
