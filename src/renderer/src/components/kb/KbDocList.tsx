/**
 * KbDocList — 文档列表组件（拖拽上传区 + 文档表格 + 状态徽章 + 行内操作）。
 *
 * 支持的文档状态形态：
 *   - done（已转换）：✓ 绿色徽章
 *   - converting（转换中）：spinner + 蓝色
 *   - classifying（AI 分类中）：spinner + 蓝色
 *   - failed（失败）：✕ 红色 + 错误码明细
 *   - queued（已入队）：灰色等待
 *
 * 行内操作：重试（failed）、删除（所有状态）
 */

import { useCallback, useState } from 'react';
import { Upload, RotateCcw, Trash2, FileText, AlertCircle } from 'lucide-react';
import { useKbStore, type KbDocument } from '@renderer/stores/kb';
import { useToastStore } from '@renderer/stores/toast';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

// ── 文件类型图标 ────────────────────────────────────────────

function FileIcon({ ext }: { ext: string }) {
  const lower = ext.toLowerCase().replace(/^\./, '');
  const label =
    lower === 'pdf' ? 'PDF' :
    lower === 'doc' || lower === 'docx' ? 'DOC' :
    lower === 'ppt' || lower === 'pptx' ? 'PPT' :
    lower === 'xls' || lower === 'xlsx' ? 'XLS' :
    lower === 'csv' ? 'CSV' :
    'DOC';

  const colorClass =
    lower === 'pdf' ? 'bg-status-fail' :
    lower === 'doc' || lower === 'docx' ? 'bg-status-running' :
    lower === 'ppt' || lower === 'pptx' ? 'bg-warning-foreground' :
    lower === 'xls' || lower === 'xlsx' ? 'bg-status-pass' :
    'bg-muted-foreground';

  return (
    <span
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white',
        colorClass,
      )}
    >
      {label}
    </span>
  );
}

// ── 状态徽章 ────────────────────────────────────────────────

function StatusBadge({ doc }: { doc: KbDocument }) {
  switch (doc.status) {
    case 'done':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-status-pass/10 px-2.5 py-0.5 text-[11px] font-medium text-status-pass-foreground">
          ✓ 已转换
        </span>
      );
    case 'converting':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-status-running/10 px-2.5 py-0.5 text-[11px] font-medium text-status-running-foreground">
          <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-status-running-foreground border-t-transparent" />
          转换中
        </span>
      );
    case 'classifying':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-status-running/10 px-2.5 py-0.5 text-[11px] font-medium text-status-running-foreground">
          <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-status-running-foreground border-t-transparent" />
          AI 分类中
        </span>
      );
    case 'queued':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          等待中
        </span>
      );
    case 'failed':
      return (
        <div className="flex flex-col gap-0.5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-status-fail/10 px-2.5 py-0.5 text-[11px] font-medium text-status-fail-foreground">
            <AlertCircle className="h-3 w-3" />
            转换失败
          </span>
          {doc.errorCode && (
            <span className="font-mono text-[10px] text-status-fail-foreground">
              {doc.errorCode}
              {doc.errorMessage ? ` · ${doc.errorMessage}` : ''}
            </span>
          )}
        </div>
      );
  }
}

// ── 文件大小格式化 ──────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── 文档列表主组件 ──────────────────────────────────────────

export function KbDocList() {
  const documents = useKbStore((s) => s.documents);
  const selectedCategory = useKbStore((s) => s.selectedCategory);
  const loading = useKbStore((s) => s.documentsLoading);
  const retryDocument = useKbStore((s) => s.retryDocument);
  const deleteDocument = useKbStore((s) => s.deleteDocument);
  const uploadFiles = useKbStore((s) => s.uploadFiles);
  const openPreview = useKbStore((s) => s.openPreview);
  const [dragOver, setDragOver] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // ── 分类筛选 ─────────────────────────────────────────────
  const filteredDocs = selectedCategory
    ? documents.filter((d) => d.category === selectedCategory)
    : documents;

  // ── 拖拽上传 ─────────────────────────────────────────────
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      // 获取文件路径 — Electron 的 File 对象有 path 属性
      const filePaths = files
        .map((f) => (f as File & { path?: string }).path)
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
      if (filePaths.length > 0) {
        await uploadFiles(filePaths);
      } else {
        // 在浏览器环境中 path 可能不可用，使用文件名提示
        useToastStore.getState().warning('拖拽上传需要在桌面环境中使用');
      }
    }
  }, [uploadFiles]);

  // ── 按钮上传 ─────────────────────────────────────────────
  const handleButtonClick = useCallback(async () => {
    try {
      const result = await trpc.project.pickFiles.mutate({ projectId: 'default' });
      if (!result.canceled && result.files.length > 0) {
        const filePaths = result.files.map((f) => f.path);
        await uploadFiles(filePaths);
      }
    } catch {
      // best-effort
    }
  }, [uploadFiles]);

  // ── 重试 ─────────────────────────────────────────────────
  const handleRetry = useCallback((name: string) => {
    void retryDocument(name);
  }, [retryDocument]);

  // ── 删除（带确认） ───────────────────────────────────────
  const handleDelete = useCallback((name: string) => {
    if (confirmDelete === name) {
      void deleteDocument(name);
      setConfirmDelete(null);
    } else {
      setConfirmDelete(name);
    }
  }, [confirmDelete, deleteDocument]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        加载文档列表...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {/* 拖拽上传区 */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleButtonClick}
        className={cn(
          'mb-4 cursor-pointer rounded-lg border-2 border-dashed p-4 text-center transition-all',
          dragOver
            ? 'border-primary bg-accent text-primary'
            : 'border-border bg-card text-muted-foreground hover:border-primary/50',
        )}
      >
        <Upload className="mx-auto mb-1 h-5 w-5" />
        <div className="text-xs font-medium">拖拽文档到此处，或点击选择文件</div>
        <div className="mt-1 text-[11px]">上传后自动转换 Markdown → AI 自动分类 → 更新索引</div>
        <div className="mt-1.5 text-[10px] tracking-wide">
          pdf · doc/docx · ppt/pptx · xls/xlsx · odt · rtf · epub · csv
        </div>
      </div>

      {/* 文档表格 */}
      {filteredDocs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
          <FileText className="h-8 w-8 text-muted-foreground/30" />
          <p className="text-xs text-muted-foreground">
            {selectedCategory ? `「${selectedCategory}」分类下暂无文档` : '暂无文档，上传开始使用知识库'}
          </p>
        </div>
      ) : (
        <table className="w-full overflow-hidden rounded-lg border border-border bg-card text-xs shadow-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2" style={{ width: '32%' }}>文档</th>
              <th className="px-3 py-2">分类</th>
              <th className="px-3 py-2">大小</th>
              <th className="px-3 py-2">状态</th>
              <th className="px-3 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredDocs.map((doc) => (
              <tr
                key={doc.name}
                onClick={() => {
                  if (doc.status === 'done') {
                    openPreview(doc.name);
                  }
                }}
                className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-accent/30"
              >
                {/* 文档名 + 路径 */}
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <FileIcon ext={doc.sourceExt} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{doc.name}</div>
                      {doc.markdownPath && (
                        <div className="truncate font-mono text-[10px] text-muted-foreground">
                          {doc.sourcePath.split(/[/\\]/).pop()} → {doc.markdownPath.split(/[/\\]/).slice(-2).join('/')}
                        </div>
                      )}
                    </div>
                  </div>
                </td>

                {/* 分类 */}
                <td className="px-3 py-2">
                  {doc.category ? (
                    <span className="rounded-full bg-violet/10 px-2 py-0.5 text-[11px] text-violet-foreground">
                      {doc.category}
                    </span>
                  ) : (
                    <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] text-warning-foreground">
                      未分类
                    </span>
                  )}
                </td>

                {/* 大小 */}
                <td className="px-3 py-2 text-muted-foreground">
                  {formatSize(doc.sourceSize)}
                </td>

                {/* 状态 */}
                <td className="px-3 py-2">
                  <StatusBadge doc={doc} />
                </td>

                {/* 行内操作 */}
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    {doc.status === 'failed' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRetry(doc.name);
                        }}
                        title="重试"
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {doc.status !== 'converting' && doc.status !== 'classifying' && doc.status !== 'queued' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(doc.name);
                        }}
                        title={confirmDelete === doc.name ? '再次点击确认删除' : '删除'}
                        className={cn(
                          'rounded p-1 transition-colors hover:bg-accent',
                          confirmDelete === doc.name
                            ? 'text-status-fail-foreground'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
