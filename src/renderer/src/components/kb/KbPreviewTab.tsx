/**
 * KbPreviewTab — 预览 Tab（Markdown 渲染 + 元信息侧栏）。
 *
 * 功能：
 *   - Markdown 渲染（复用 ReactMarkdown + remark-gfm）
 *   - 右侧元信息侧栏：源文件名、分类、大小（源/md）、图片数、转换时间
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, Image as ImageIcon, Clock, Loader2 } from 'lucide-react';
import { useKbStore } from '@renderer/stores/kb';

// ── 文件大小格式化 ──────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── 时间格式化 ──────────────────────────────────────────────

function formatTime(ms: number | undefined): string {
  if (!ms) return '-';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── 源文件信息已被简化，移除旧分类操作后不再需要这些辅助函数 ──
// 保留 formatSize 和 formatTime 供元信息侧栏使用

export function KbPreviewTab() {
  const previewDocName = useKbStore((s) => s.previewDocName);
  const previewContent = useKbStore((s) => s.previewContent);
  const previewLoading = useKbStore((s) => s.previewLoading);
  const documents = useKbStore((s) => s.documents);

  // 查找当前文档的元数据
  const doc = documents.find((d) => d.name === previewDocName);

  if (!previewDocName) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <FileText className="mb-2 h-10 w-10 text-muted-foreground/30" />
        <span className="text-xs text-muted-foreground">
          选择文档进行预览
        </span>
      </div>
    );
  }

  if (previewLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载文档...
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Markdown 渲染区 */}
      <div className="flex-1 overflow-y-auto bg-background p-6">
        <div className="mx-auto max-w-[900px] rounded-lg bg-card p-6 shadow-sm">
          {previewContent ? (
            <div className="kb-markdown max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {previewContent}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              文档内容为空或不存在
            </div>
          )}
        </div>
      </div>

      {/* 右侧元信息侧栏 */}
      <aside className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-card p-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          文档信息
        </h3>

        {/* 源文件名 */}
        <div className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">源文件</span>
          <span className="text-right font-mono text-[10px] break-all">
            {doc ? doc.sourcePath.split(/[/\\]/).pop() : '-'}
          </span>
        </div>

        {/* 分类 */}
        <div className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">分类</span>
          <span className="text-right">{doc?.category || '未分类'}</span>
        </div>

        {/* 大小 */}
        <div className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">大小</span>
          <span className="text-right">
            {doc ? `${formatSize(doc.sourceSize)} / md ${formatSize(doc.markdownSize)}` : '-'}
          </span>
        </div>

        {/* 图片数 */}
        <div className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 text-xs">
          <ImageIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="text-right">{doc?.assetCount ?? 0} 张已提取</span>
        </div>

        {/* 转换时间 */}
        <div className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1.5 text-xs">
          <Clock className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="text-right">{formatTime(doc?.convertedAt)}</span>
        </div>
      </aside>
    </div>
  );
}
