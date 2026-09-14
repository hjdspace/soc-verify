/**
 * KbHeader — 知识库头部组件（库切换器 + 统计 + 上传按钮）。
 *
 * wiki 布局通过来源导入与编译队列生成知识页提案。
 */

import { BookOpen, ChevronDown, Upload, CheckCircle, CircleSlash } from 'lucide-react';
import { useKbStore } from '@renderer/stores/kb';
import { cn } from '@renderer/lib/utils';

export function KbHeader() {
  const kbStatus = useKbStore((s) => s.kbStatus);
  const documents = useKbStore((s) => s.documents);
  const wikiSources = useKbStore((s) => s.wikiSources);
  const categories = useKbStore((s) => s.categories);
  const uploading = useKbStore((s) => s.uploading);
  const setKbModalOpen = useKbStore((s) => s.setKbModalOpen);

  const mountedKb = kbStatus?.mounted;
  const isWikiFormat = mountedKb?.format === 'wiki';
  const docCount = isWikiFormat ? wikiSources.length : documents.length;
  const catCount = categories.length;
  // wiki 布局没有 index.md：用 manifest 就绪度替代索引导航提示
  const indexReady = isWikiFormat
    ? (kbStatus?.wikiHealth?.hasManifest ?? false)
    : (kbStatus?.health.hasIndex ?? false);

  return (
    <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2">
      {/* 库切换器 */}
      <button
        onClick={() => setKbModalOpen(true)}
        className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
      >
        <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
        {mountedKb?.name ?? '选择知识库'}
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>

      {/* 库路径 + 格式 */}
      {mountedKb && (
        <span className="font-mono text-[11px] text-muted-foreground">
          {mountedKb.path} · {mountedKb.format}
        </span>
      )}
      {mountedKb?.state === 'unreadable' && (
        <span className="text-[11px] text-status-warn-foreground">目录不可达（离线或权限不足）</span>
      )}
      {mountedKb?.state === 'structureChanged' && (
        <span className="text-[11px] text-status-warn-foreground">目录结构与登记不符</span>
      )}

      {/* 统计 */}
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-center">
          <span className="text-sm font-semibold leading-tight">{docCount}</span>
          <span className="text-[10px] text-muted-foreground">文档</span>
        </div>
        {!isWikiFormat && <div className="flex flex-col items-center">
          <span className="text-sm font-semibold leading-tight">{catCount}</span>
          <span className="text-[10px] text-muted-foreground">分类</span>
        </div>}
        <div className="flex flex-col items-center">
          {isWikiFormat ? (
            <CircleSlash
              className={cn(
                'h-3.5 w-3.5',
                indexReady ? 'text-status-pass-foreground' : 'text-muted-foreground/40',
              )}
            />
          ) : (
            <CheckCircle
              className={cn(
                'h-3.5 w-3.5',
                indexReady ? 'text-status-pass-foreground' : 'text-muted-foreground/40',
              )}
            />
          )}
          <span className="text-[10px] text-muted-foreground">{isWikiFormat ? '清单' : '索引'}</span>
        </div>
      </div>

      <div className="flex-1" />

      {/* 上传按钮 */}
      <button
        onClick={() => void useKbStore.getState().pickAndUpload()}
        disabled={uploading}
        className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Upload className="h-3.5 w-3.5" />
        {uploading ? '上传中...' : '上传文档'}
      </button>
    </div>
  );
}
