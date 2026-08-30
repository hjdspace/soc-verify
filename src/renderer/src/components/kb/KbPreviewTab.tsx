/**
 * KbPreviewTab — 预览 Tab（Markdown 渲染 + 元信息侧栏 + AI 摘要卡）。
 *
 * 功能：
 *   - Markdown 渲染（复用 ReactMarkdown + remark-gfm）
 *   - 右侧元信息侧栏：源文件名、分类、大小（源/md）、图片数、转换时间
 *   - AI 摘要卡：读取 index.md 中该文档条目的摘要
 *   - 手动改分类：移动分类操作 → 主进程移动文件 + 更新索引条目
 *
 * @see docs/prototypes/knowledge-base.html — UI 原型
 */

import { useEffect, useCallback, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, Image as ImageIcon, Clock, Folder, ArrowRightCircle, Bot, Loader2, Sparkles } from 'lucide-react';
import { useKbStore } from '@renderer/stores/kb';
import { parseIndexMd } from '@renderer/lib/kb-index-parser';
import { cn } from '@renderer/lib/utils';
import { ContextCard, deriveBadge, deriveExt, type ContextTone } from '@renderer/components/ui/ContextCard';

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

// ── KB 摘要 chunk 卡：来源文件名/badge/tone 派生 ──────────────

function basename(p: string | undefined): string {
  if (!p) return '';
  return p.split(/[/\\]/).pop() ?? p;
}

// 源文件类型→badge 语义色（pdf→red、表格→green、文档→orange，余 neutral）
const DOC_TONE: Record<string, ContextTone> = {
  pdf: 'red',
  csv: 'green',
  xlsx: 'green',
  xls: 'green',
  tsv: 'green',
  docx: 'orange',
  doc: 'orange',
  pptx: 'orange',
  ppt: 'orange',
};

function sourceTone(p: string | undefined): ContextTone {
  return DOC_TONE[deriveExt(p)] ?? 'neutral';
}

export function KbPreviewTab() {
  const previewDocName = useKbStore((s) => s.previewDocName);
  const previewContent = useKbStore((s) => s.previewContent);
  const previewLoading = useKbStore((s) => s.previewLoading);
  const documents = useKbStore((s) => s.documents);
  const indexContent = useKbStore((s) => s.indexContent);
  const categories = useKbStore((s) => s.categories);
  const moveCategory = useKbStore((s) => s.moveCategory);
  const loadIndex = useKbStore((s) => s.loadIndex);
  const reclassifyDocument = useKbStore((s) => s.reclassifyDocument);

  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [moving, setMoving] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);

  // 挂载时加载索引内容（用于 AI 摘要）
  useEffect(() => {
    // 每次打开预览时刷新 index 内容，确保获取最新摘要
    void loadIndex();
  }, [loadIndex, previewDocName]);

  // 查找当前文档的元数据
  const doc = documents.find((d) => d.name === previewDocName);

  // 从 index.md 中解析该文档的 AI 摘要
  const indexEntries = indexContent ? parseIndexMd(indexContent).entries : [];
  const indexEntry = indexEntries.find((e) => {
    if (!previewDocName) return false;
    return e.path.endsWith(`/${previewDocName}.md`) || e.path === `${previewDocName}.md`;
  });

  // ── 移动分类 ─────────────────────────────────────────────
  const handleMoveCategory = useCallback(async (category: string) => {
    if (!previewDocName) return;
    setShowMoveMenu(false);
    setMoving(true);
    await moveCategory(previewDocName, category);
    setMoving(false);
  }, [previewDocName, moveCategory]);

  // ── AI 重新分类/摘要 ─────────────────────────────────────
  const handleReclassify = useCallback(async () => {
    if (!previewDocName) return;
    setReclassifying(true);
    await reclassifyDocument(previewDocName);
    setReclassifying(false);
  }, [previewDocName, reclassifyDocument]);

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
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
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

        {/* AI 摘要卡——chunk 卡形态（标题/字符数/摘要/来源 chip） */}
        {indexEntry && indexEntry.summary ? (
          <ContextCard
            className="mt-2"
            chunk={{
              key: previewDocName ?? 'kb-summary',
              icon: <FileText className="h-3 w-3 text-muted-foreground" />,
              title: indexEntry.title || previewDocName || 'AI 摘要',
              meta: `${indexEntry.summary.length} 字符`,
              body: indexEntry.summary,
              source: basename(doc?.sourcePath) || previewDocName || '',
              badge: deriveBadge(doc?.sourcePath),
              tone: sourceTone(doc?.sourcePath),
              action: (
                <button
                  type="button"
                  onClick={() => void handleReclassify()}
                  disabled={reclassifying}
                  title="AI 重新分类并重新生成摘要"
                  className="ap-ctx-regen"
                >
                  <Sparkles className={cn('h-3 w-3', reclassifying && 'animate-pulse')} />
                </button>
              ),
            }}
          />
        ) : (
          <div className="mt-2 rounded-lg border border-dashed border-border p-2.5 text-[11px] text-muted-foreground">
            <div className="mb-1 flex items-center gap-1.5">
              <Bot className="h-3 w-3" />
              AI 摘要
              <button
                type="button"
                onClick={() => void handleReclassify()}
                disabled={reclassifying}
                title="AI 重新分类并生成摘要"
                className="ml-auto rounded p-0.5 transition-colors hover:bg-accent disabled:opacity-50"
              >
                <Sparkles className={cn('h-3 w-3', reclassifying && 'animate-pulse')} />
              </button>
            </div>
            暂无摘要。请确保已在设置中配置 LLM 凭证（与 AI Agent 面板共用），点击右上角按钮让 AI 重新分类并生成摘要。
          </div>
        )}

        {/* 关键词标签 */}
        {indexEntry && indexEntry.keywords.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {indexEntry.keywords.map((kw) => (
              <span
                key={kw}
                className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                {kw}
              </span>
            ))}
          </div>
        )}

        {/* 手动改分类 */}
        <div className="mt-3">
          <button
            onClick={() => setShowMoveMenu(!showMoveMenu)}
            disabled={moving}
            className="flex w-full items-center gap-1.5 rounded border border-border px-2 py-1.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-50"
          >
            <ArrowRightCircle className="h-3 w-3" />
            {moving ? '移动中...' : '移动分类'}
          </button>

          {showMoveMenu && (
            <div className="mt-1 max-h-48 flex-col gap-0.5 overflow-y-auto rounded border border-border bg-card p-1">
              {categories.map((cat) => (
                <button
                  key={cat.name}
                  onClick={() => void handleMoveCategory(cat.name)}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors hover:bg-accent',
                    cat.name === doc?.category && 'bg-accent/50 text-primary',
                  )}
                >
                  <Folder className="h-3 w-3" />
                  {cat.name}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {cat.count}
                  </span>
                </button>
              ))}
              {/* 新分类输入 */}
              <NewCategoryInput onMove={handleMoveCategory} />
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// ── 新分类输入组件 ──────────────────────────────────────────

function NewCategoryInput({
  onMove,
}: {
  onMove: (category: string) => void;
}) {
  const [value, setValue] = useState('');
  const [active, setActive] = useState(false);

  if (!active) {
    return (
      <button
        onClick={() => setActive(true)}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent"
      >
        + 新分类
      </button>
    );
  }

  return (
    <div className="flex gap-1 px-1 py-0.5">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="新分类名"
        className="h-6 flex-1 rounded border border-border bg-background px-2 text-[11px] outline-none focus:border-primary"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) {
            onMove(value.trim());
          }
          if (e.key === 'Escape') {
            setActive(false);
          }
        }}
        onBlur={() => {
          if (!value.trim()) setActive(false);
        }}
      />
      <button
        onClick={() => value.trim() && onMove(value.trim())}
        className="rounded bg-primary px-1.5 text-[10px] text-primary-foreground"
      >
        ✓
      </button>
    </div>
  );
}
