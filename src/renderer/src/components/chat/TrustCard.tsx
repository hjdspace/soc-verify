import { memo, useState } from 'react';
import { ShieldCheck, ShieldX, ShieldAlert, FolderGit2, Server, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { BorderBeam } from '@renderer/components/visual';
import type { TrustRequest } from '@renderer/stores/session-types';

interface TrustCardProps {
  request: TrustRequest;
  onResolve: (requestId: string, approved: boolean) => void;
}

/** 安全地格式化路径等信息 */
function formatDetail(request: TrustRequest): string {
  const lines: string[] = [];
  if (request.path) lines.push(request.path);
  return lines.join('\n');
}

/**
 * 信任卡（issue 04）：独立于审批模式的权限边界确认。
 * 项目 extension 首次加载 / MCP server 首次启动需用户信任确认。
 * 视觉形态与 ApprovalCard 对齐（DSH §10.3），琥珀警示条 + 圆角卡。
 */
export const TrustCard = memo(function TrustCard({ request, onResolve }: TrustCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [resolved, setResolved] = useState<'approved' | 'denied' | null>(null);
  const isMcp = request.kind === 'mcp-server';
  const kindLabel = isMcp ? 'MCP Server' : '项目扩展';
  const KindIcon = isMcp ? Server : FolderGit2;
  const detail = formatDetail(request);

  const handleResolve = (approved: boolean) => {
    setResolved(approved ? 'approved' : 'denied');
    onResolve(request.requestId, approved);
  };

  return (
    <BorderBeam size="pulse-outside" theme="dark" colorVariant="sunset" active={!resolved} className="block w-full">
      <div
        className={cn(
          'overflow-hidden rounded-xl border text-xs transition-colors',
          resolved === 'approved'
            ? 'border-status-pass/40 bg-status-pass/5'
            : resolved === 'denied'
              ? 'border-destructive/40 bg-destructive/5'
              : 'border-[var(--dsw-warn-secondary)] bg-[var(--dsw-input-major)] shadow-[var(--dsw-shadow-lv2)]',
        )}
      >
        {/* 琥珀警示条 / 决议结果条 */}
        <div
          className={cn(
            'flex items-center gap-1.5 px-3 py-1',
            resolved === 'approved' && 'bg-status-pass/10 text-status-pass-foreground',
            resolved === 'denied' && 'bg-destructive/10 text-destructive',
            !resolved && 'bg-[var(--dsw-warn-tertiary)] text-[var(--dsw-warn-label)]',
          )}
        >
          {resolved === 'approved' ? (
            <ShieldCheck className="h-3 w-3 shrink-0" />
          ) : resolved === 'denied' ? (
            <ShieldX className="h-3 w-3 shrink-0" />
          ) : (
            <>
              <span className={cn('h-2 w-2 shrink-0 rounded-full', 'bg-[var(--dsw-warn)]')} />
              <ShieldAlert className="h-3 w-3 shrink-0" />
            </>
          )}
          <span className="font-medium">
            {resolved === 'approved' ? '已信任' : resolved === 'denied' ? '已拒绝' : '等待信任确认'}
          </span>
          {!resolved && (
            <span className="ml-auto font-mono text-[9px] opacity-80">{kindLabel}</span>
          )}
        </div>

        {/* Body */}
        <div className="px-3 py-2">
          <div className="flex items-center gap-1.5 text-[12px] font-medium leading-[18px] text-foreground">
            <KindIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>
              AI 请求信任{isMcp ? ' MCP Server' : '项目扩展'} <span className="font-mono">{request.name}</span>
            </span>
          </div>
          <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {isMcp
              ? '信任后该 MCP Server 将随会话自动启动，其提供的工具对 AI 可用。'
              : '信任后该项目内的扩展与配置将随会话自动加载。'}
            {' '}此决定独立于审批模式，yolo 模式不会跳过此确认。
          </div>

          {/* Path 详情 */}
          {detail && (
            <div className="mt-1.5">
              <button
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              >
                {expanded ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
                <span>{expanded ? '收起路径' : '查看路径'}</span>
              </button>
              {expanded && (
                <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-[var(--dsw-border-l1)] bg-[var(--dsw-code-block)] p-1.5 font-mono text-[9px] leading-relaxed text-muted-foreground">
                  <code>{detail}</code>
                </pre>
              )}
            </div>
          )}
        </div>

        {/* Action buttons：右对齐 拒绝(outline) / 信任(primary) */}
        {!resolved && (
          <div className="flex items-center justify-end gap-2 px-3 pb-2.5">
            <button
              onClick={() => handleResolve(false)}
              className="rounded-lg border border-[var(--dsw-border-l2)] px-3 py-1 text-[11px] text-foreground transition-colors hover:border-destructive hover:bg-destructive/5 hover:text-destructive"
            >
              拒绝
            </button>
            <button
              onClick={() => handleResolve(true)}
              className="rounded-lg bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:opacity-90"
            >
              信任
            </button>
          </div>
        )}
      </div>
    </BorderBeam>
  );
});
