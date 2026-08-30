/**
 * 仿真视图下方运行列表面板（Issue #4）。
 *
 * 从 SimulationView 中抽取运行列表表格逻辑为独立组件。
 * 包含分段筛选器（全部/运行中/失败/通过/队列/已停止，含计数）、
 * 关键字过滤（用例名/seed）、运行表格行（状态点/用例名+seed/子系统/
 * 进度条/耗时/ETA）、骨架屏、空状态、无匹配状态、停止全部按钮。
 * 行点击跳转到运行详情 Tab（workbench.open）。
 * 运行中仿真秒级刷新实时耗时。
 *
 * 行内 Debug 按钮（UI 方案 C，对齐原型 sim-debug-buttons-c-row-actions.html）：
 * hover 浮现图标组（Verdi/Verisium/编译日志/仿真日志/反汇编）+ ⋮ 菜单
 *（打开 Verdi/Verisium、各产物内置编辑器/gvim 打开方式、打开用例目录）；
 * 产物缺失时禁用（保留 title 提示与外点关闭）。
 *
 * 性能优化：
 *   - 虚拟滚动：仅渲染可见区域内的行，支持万级用例流畅滚动
 *   - React.memo：RunRow 缓存，避免 now 秒级刷新导致全部行重渲染
 *   - 行级产物解析仅对可见行发起（虚拟滚动天然限量）
 *
 * 布局对齐原型 sim-page-01-left-tree-right-options.html：
 *   .rla（flex-1 flex-col overflow-hidden）
 *     .lh → 筛选栏（标题 + 分段 + 搜索 + 停止全部）
 *     .rh → 表头行（sticky 不可滚动）
 *     .table → 行体（flex-1 overflow-y-auto，虚拟滚动）
 */

import { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import {
  Search,
  Square,
  Waves,
  Boxes,
  FileCode,
  FileText,
  Binary,
  MoreVertical,
  FolderOpen,
  Edit3,
} from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { type DebugArtifacts, baseName } from '@renderer/lib/sim-debug';
import { useSimulationStore, type SimulationRunRecord } from '@renderer/stores/simulation';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { useToastStore } from '@renderer/stores/toast';
import { FilterStatusPill, type FilterStatusPillTone } from '@renderer/components/ui/FilterTable';
import { cn } from '@renderer/lib/utils';

/** 分段筛选器：fail 段聚合 fail 与 error；dot 为 chip 彩色圆点（语义状态变量） */
type SegKey = 'all' | 'running' | 'fail' | 'pass' | 'queued' | 'stopped';

const SEGMENTS: ReadonlyArray<{ key: SegKey; label: string; dot?: string; match: (r: SimulationRunRecord) => boolean }> = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'running', label: '运行中', dot: 'var(--status-running)', match: (r) => r.status === 'running' },
  { key: 'fail', label: '失败', dot: 'var(--status-fail)', match: (r) => r.status === 'fail' || r.status === 'error' },
  { key: 'pass', label: '通过', dot: 'var(--status-pass)', match: (r) => r.status === 'pass' },
  { key: 'queued', label: '队列', dot: 'var(--muted-foreground)', match: (r) => r.status === 'pending' },
  { key: 'stopped', label: '已停止', dot: 'var(--status-aborted)', match: (r) => r.status === 'aborted' },
];

/** 状态点颜色（与总览视图 RunningSimStream 一致） */
function dotClass(status: SimulationRunRecord['status']): string {
  switch (status) {
    case 'running': return 'bg-status-running animate-pulse';
    case 'pass': return 'bg-status-pass';
    case 'fail':
    case 'error': return 'bg-status-fail';
    case 'pending': return 'bg-muted-foreground/40';
    default: return 'bg-status-aborted';
  }
}

/** 终态 ETA 列文案：显示状态而非伪造 ETA（FilterStatusPill 承载）；
 * 运行中/队列无数据源显示占位（不成 pill，避免空 pill） */
function etaCell(status: SimulationRunRecord['status']): { label: string; tone: FilterStatusPillTone | null } {
  switch (status) {
    case 'pass': return { label: '通过', tone: 'pass' };
    case 'fail':
    case 'error': return { label: '失败', tone: 'fail' };
    case 'aborted': return { label: '已停止', tone: 'aborted' };
    default: return { label: '—', tone: null };
  }
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m ${s % 60}s`;
}

/** 进度列从 1fr 收窄为固定 120px，为行内 Debug 按钮组留出空间（方案 C） */
const ROW_GRID = 'grid grid-cols-[18px_1.4fr_100px_120px_80px_70px_116px]';

/** 行内 Debug 图标按钮通用样式（对齐原型 sim-debug-buttons-c-row-actions.html）
 *
 * 24x24 圆角按钮，按功能分组使用不同语义色 hover：
 * - wave（Verdi/Verisium）：紫色调
 * - log（编译日志/仿真日志）：绿色调
 * - asm（反汇编）：琥珀色调
 * - more（⋮ 菜单）：默认 accent
 *
 * 禁用态保留 pointer-events（不隐藏 title 提示），仅降透明度 + not-allowed；
 * hover 反馈用 enabled:hover 限定，避免禁用态出现可点击错觉。
 */
const DBG_BTN_BASE =
  'flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-30';
const DBG_BTN_WAVE = 'enabled:hover:bg-primary/20 enabled:hover:text-primary';
const DBG_BTN_LOG = 'enabled:hover:bg-status-pass/20 enabled:hover:text-status-pass-foreground';
const DBG_BTN_ASM = 'enabled:hover:bg-status-running/20 enabled:hover:text-status-running-foreground';
const DBG_BTN_MORE = 'hover:bg-accent hover:text-foreground';

/** ⋮ 菜单项通用样式（对齐原型 .rm-item；禁用项保留 hover 区域以显示 title） */
const MENU_ITEM =
  'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-primary disabled:cursor-not-allowed disabled:opacity-40';
/** 菜单项右侧打开方式子标签（run_verdi / 内置编辑器 / gvim） */
const MENU_SUB = 'ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60';

/** 状态标签（⋮ 菜单头部，对齐原型「用例名 · FAIL」） */
function statusBadge(status: SimulationRunRecord['status']): { label: string; className: string } {
  switch (status) {
    case 'running': return { label: 'RUNNING', className: 'text-status-running-foreground' };
    case 'pass': return { label: 'PASS', className: 'text-status-pass-foreground' };
    case 'fail': return { label: 'FAIL', className: 'text-status-fail-foreground' };
    case 'error': return { label: 'ERROR', className: 'text-status-fail-foreground' };
    case 'pending': return { label: 'QUEUED', className: 'text-muted-foreground' };
    default: return { label: 'STOPPED', className: 'text-status-aborted-foreground' };
  }
}

// ─── 虚拟滚动常量 ────────────────────────────────────────────────

const ROW_HEIGHT = 40; // px — RunRow 的预估高度（px-3 py-1.5 + 内容）
const OVERSCAN = 8;   // 额外渲染的行数（上下各 overscan）

const RunRow = memo(function RunRow({ run, now, onOpen }: {
  run: SimulationRunRecord;
  now: number;
  onOpen: () => void;
}) {
  const open = useWorkbenchStore((s) => s.open);
  const isRunning = run.status === 'running' || run.status === 'pending';
  const duration = isRunning
    ? now - run.startTime
    : run.endTime
      ? run.endTime - run.startTime
      : 0;
  const eta = etaCell(run.status);

  // ── 行内 Debug 按钮（方案 C）：产物解析 ──────────
  // 仅对携带 command/cwd 的运行记录解析（终端运行实时记录）；
  // 虚拟滚动只渲染可见行，查询量天然受限。
  const [artifacts, setArtifacts] = useState<DebugArtifacts | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // ⋮ 菜单外点关闭（点击 ⋮ 本身交给按钮 toggle，避免关了又开）
  useEffect(() => {
    if (!menuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (moreRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [menuOpen]);

  const command = run.command;
  const cwd = run.cwd;
  const caseName = run.caseName;
  useEffect(() => {
    if (!command || !cwd) return;
    let cancelled = false;
    void trpc.simulation.resolveDebugArtifacts
      .query({ cwd, caseName: caseName ?? undefined, command })
      .then((result) => {
        if (!cancelled) setArtifacts(result);
      })
      .catch(() => {
        if (!cancelled) setArtifacts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [command, cwd, caseName]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onOpen();
  }, [onOpen]);

  // Verdi / Verisium：隐藏子进程启动（不占终端 Tab）
  const launchTool = useCallback(
    async (tool: 'verdi' | 'verisium') => {
      if (!command || !cwd) return;
      try {
        if (tool === 'verdi') {
          const result = await trpc.simulation.launchVerdi.mutate({
            cwd,
            caseName: caseName ?? undefined,
            command,
          });
          useToastStore.getState().info(
            `Verdi 已启动（${result.mode === 'vcs' ? 'VCS' : 'Xcelium'} 波形）`,
            `${result.command} @ ${result.caseDir}，输出见 ${baseName(result.logPath)}`,
          );
        } else {
          const result = await trpc.simulation.launchVerisium.mutate({
            cwd,
            caseName: caseName ?? undefined,
            command,
          });
          useToastStore.getState().info(
            'Verisium 已启动',
            `${result.command} @ ${result.caseDir}，输出见 ${baseName(result.logPath)}`,
          );
        }
      } catch (err) {
        useToastStore.getState().error(
          tool === 'verdi' ? '启动 Verdi 失败' : '启动 Verisium 失败',
          String(err),
        );
      }
    },
    [command, cwd, caseName],
  );

  // 日志/反汇编：内置编辑器或 gvim（viaSystem）打开
  const openArtifact = useCallback(
    (path: string, viaSystem: boolean) => {
      setMenuOpen(false);
      if (viaSystem) {
        void trpc.project.openInSystem.mutate({ path, type: 'file' });
      } else {
        open({ type: 'file', path, name: baseName(path) });
      }
    },
    [open],
  );

  const openCaseDir = useCallback(() => {
    setMenuOpen(false);
    if (artifacts?.caseDir) {
      void trpc.project.openInSystem.mutate({ path: artifacts.caseDir, type: 'directory' });
    }
  }, [artifacts]);

  const hasCase = !!artifacts?.caseDir;
  const missingHint = '未找到仿真产物（用例目录 / 日志）';

  const stopRowClick = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(ROW_GRID, 'group/row relative cursor-pointer items-center gap-2 border-b border-border px-3 py-1.5 transition-colors last:border-b-0 hover:bg-accent')}
      data-testid={`sim-row-${run.runId}`}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
    >
      <span className={cn('size-2 shrink-0 rounded-full', dotClass(run.status))} />
      <div className="min-w-0 overflow-hidden">
        <span className="block truncate font-mono text-[11px] text-foreground">
          {run.caseName ?? run.caseId}
        </span>
        {run.seed && (
          <span className="block truncate font-mono text-[10px] text-muted-foreground/80">
            seed {run.seed}
          </span>
        )}
      </div>
      <span className="truncate text-[10px] text-muted-foreground">{run.subsys}</span>
      <div className="h-1 overflow-hidden rounded-sm bg-background" data-testid="sim-progress-track">
        {run.status === 'running' && (
          <div className="h-full w-1/3 animate-pulse rounded-sm bg-status-running" />
        )}
        {run.status === 'pending' && null}
        {run.status === 'pass' && <div className="h-full w-full rounded-sm bg-status-pass" />}
        {(run.status === 'fail' || run.status === 'error') && (
          <div className="h-full w-full rounded-sm bg-status-fail" />
        )}
        {run.status === 'aborted' && <div className="h-full w-full rounded-sm bg-status-aborted" />}
      </div>
      <span className="text-right font-mono text-[10px] text-muted-foreground">
        {formatDuration(duration)}
      </span>
      <span className="flex justify-end">
        {eta.tone ? (
          <FilterStatusPill tone={eta.tone}>{eta.label}</FilterStatusPill>
        ) : (
          <span className="font-mono text-[10px] text-muted-foreground/50">{eta.label}</span>
        )}
      </span>

      {/* ── 行内 Debug 按钮组（方案 C：hover 浮现，产物缺失禁用但保留提示）── */}
      <div
        className={cn(
          'flex items-center justify-end gap-0.5 transition-opacity',
          menuOpen
            ? 'opacity-100'
            : 'pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100',
        )}
        onClick={stopRowClick}
      >
        <button
          data-testid={`sim-rowdbg-${run.runId}-btn-verdi`}
          disabled={!hasCase}
          onClick={() => void launchTool('verdi')}
          className={cn(DBG_BTN_BASE, DBG_BTN_WAVE)}
          title={hasCase ? '打开 Verdi（隐藏子进程，自动检测 VCS / Xcelium）' : missingHint}
        >
          <Waves className="size-3.5" />
        </button>
        <button
          data-testid={`sim-rowdbg-${run.runId}-btn-verisium`}
          disabled={!hasCase}
          onClick={() => void launchTool('verisium')}
          className={cn(DBG_BTN_BASE, DBG_BTN_WAVE)}
          title={hasCase ? '打开 Verisium（隐藏子进程，run_vdb）' : missingHint}
        >
          <Boxes className="size-3.5" />
        </button>
        <button
          data-testid={`sim-rowdbg-${run.runId}-btn-compile-log`}
          disabled={!artifacts?.compileLogPath}
          onClick={() => artifacts?.compileLogPath && openArtifact(artifacts.compileLogPath, false)}
          className={cn(DBG_BTN_BASE, DBG_BTN_LOG)}
          title={artifacts?.compileLogPath ? '打开编译日志（内置编辑器）' : missingHint}
        >
          <FileCode className="size-3.5" />
        </button>
        <button
          data-testid={`sim-rowdbg-${run.runId}-btn-sim-log`}
          disabled={!artifacts?.simLogPath}
          onClick={() => artifacts?.simLogPath && openArtifact(artifacts.simLogPath, false)}
          className={cn(DBG_BTN_BASE, DBG_BTN_LOG)}
          title={artifacts?.simLogPath ? '打开仿真日志（内置编辑器）' : missingHint}
        >
          <FileText className="size-3.5" />
        </button>
        <button
          data-testid={`sim-rowdbg-${run.runId}-btn-asm`}
          disabled={!artifacts || artifacts.asmFiles.length === 0}
          onClick={() =>
            artifacts && artifacts.asmFiles.length > 0 && openArtifact(artifacts.asmFiles[0], false)
          }
          className={cn(DBG_BTN_BASE, DBG_BTN_ASM)}
          title={
            artifacts && artifacts.asmFiles.length > 0
              ? `打开反汇编（*_sw_build 下的 .asm，共 ${artifacts.asmFiles.length} 个）`
              : missingHint
          }
        >
          <Binary className="size-3.5" />
        </button>
        <button
          ref={moreRef}
          data-testid={`sim-rowdbg-${run.runId}-btn-more`}
          onClick={() => setMenuOpen(!menuOpen)}
          className={cn(DBG_BTN_BASE, DBG_BTN_MORE)}
          title="更多操作（打开 Verdi / Verisium、日志打开方式、用例目录）"
        >
          <MoreVertical className="size-3.5" />
        </button>
      </div>

      {/* ⋮ 菜单：对齐原型 sim-debug-buttons-c-row-actions.html 的 .row-menu
          （打开 Verdi/Verisium + 日志内置编辑器/gvim 分组 + 打开用例目录；
            产物缺失时菜单仍可展开，对应项禁用以提示） */}
      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-2 top-full z-30 mt-1 min-w-60 overflow-hidden rounded-lg border border-border bg-background py-1 shadow-xl"
          data-testid={`sim-rowdbg-${run.runId}-menu`}
          onClick={stopRowClick}
        >
          {/* 菜单头部：用例名 · 状态 */}
          <div className="flex items-center gap-1.5 border-b border-border bg-accent/30 px-3 py-1.5">
            <span className="min-w-0 truncate font-mono text-[11px] text-primary">
              {run.caseName ?? run.caseId}
            </span>
            <span className={cn('ml-auto shrink-0 text-[10px] font-medium', statusBadge(run.status).className)}>
              {statusBadge(run.status).label}
            </span>
          </div>
          {/* 波形工具：隐藏子进程启动 */}
          <button
            data-testid={`sim-rowdbg-${run.runId}-menu-verdi`}
            disabled={!hasCase}
            className={MENU_ITEM}
            title={hasCase ? '在用例目录启动 Verdi（自动检测 VCS / Xcelium）' : missingHint}
            onClick={() => {
              setMenuOpen(false);
              void launchTool('verdi');
            }}
          >
            <Waves className="size-3 shrink-0 text-muted-foreground" />
            <span>打开 Verdi</span>
            <span className={MENU_SUB}>run_verdi</span>
          </button>
          <button
            data-testid={`sim-rowdbg-${run.runId}-menu-verisium`}
            disabled={!hasCase}
            className={MENU_ITEM}
            title={hasCase ? '在用例目录启动 Verisium（run_vdb）' : missingHint}
            onClick={() => {
              setMenuOpen(false);
              void launchTool('verisium');
            }}
          >
            <Boxes className="size-3 shrink-0 text-muted-foreground" />
            <span>打开 Verisium</span>
            <span className={MENU_SUB}>run_verisium</span>
          </button>
          {/* 日志 / 反汇编：内置编辑器 与 gvim 两种打开方式 */}
          <div className="my-1 border-t border-border" />
          <button
            data-testid={`sim-rowdbg-${run.runId}-menu-compile-log-builtin`}
            disabled={!artifacts?.compileLogPath}
            className={MENU_ITEM}
            title={artifacts?.compileLogPath ? '在内置编辑器中打开编译日志' : missingHint}
            onClick={() => artifacts?.compileLogPath && openArtifact(artifacts.compileLogPath, false)}
          >
            <FileCode className="size-3 shrink-0 text-muted-foreground" />
            <span>编译日志</span>
            <span className={MENU_SUB}>内置编辑器</span>
          </button>
          <button
            data-testid={`sim-rowdbg-${run.runId}-menu-compile-log-gvim`}
            disabled={!artifacts?.compileLogPath}
            className={MENU_ITEM}
            title={artifacts?.compileLogPath ? '用 gvim 打开编译日志' : missingHint}
            onClick={() => artifacts?.compileLogPath && openArtifact(artifacts.compileLogPath, true)}
          >
            <Edit3 className="size-3 shrink-0 text-muted-foreground" />
            <span>编译日志</span>
            <span className={MENU_SUB}>gvim</span>
          </button>
          <button
            data-testid={`sim-rowdbg-${run.runId}-menu-sim-log-builtin`}
            disabled={!artifacts?.simLogPath}
            className={MENU_ITEM}
            title={artifacts?.simLogPath ? '在内置编辑器中打开仿真日志' : missingHint}
            onClick={() => artifacts?.simLogPath && openArtifact(artifacts.simLogPath, false)}
          >
            <FileText className="size-3 shrink-0 text-muted-foreground" />
            <span>仿真日志</span>
            <span className={MENU_SUB}>内置编辑器</span>
          </button>
          <button
            data-testid={`sim-rowdbg-${run.runId}-menu-sim-log-gvim`}
            disabled={!artifacts?.simLogPath}
            className={MENU_ITEM}
            title={artifacts?.simLogPath ? '用 gvim 打开仿真日志' : missingHint}
            onClick={() => artifacts?.simLogPath && openArtifact(artifacts.simLogPath, true)}
          >
            <Edit3 className="size-3 shrink-0 text-muted-foreground" />
            <span>仿真日志</span>
            <span className={MENU_SUB}>gvim</span>
          </button>
          <button
            data-testid={`sim-rowdbg-${run.runId}-menu-asm-builtin`}
            disabled={!artifacts || artifacts.asmFiles.length === 0}
            className={MENU_ITEM}
            title={
              artifacts && artifacts.asmFiles.length > 0
                ? `在内置编辑器中打开反汇编（共 ${artifacts.asmFiles.length} 个 .asm）`
                : missingHint
            }
            onClick={() =>
              artifacts && artifacts.asmFiles.length > 0 && openArtifact(artifacts.asmFiles[0], false)
            }
          >
            <Binary className="size-3 shrink-0 text-muted-foreground" />
            <span>反汇编</span>
            <span className={MENU_SUB}>内置编辑器</span>
          </button>
          <button
            data-testid={`sim-rowdbg-${run.runId}-menu-asm-gvim`}
            disabled={!artifacts || artifacts.asmFiles.length === 0}
            className={MENU_ITEM}
            title={
              artifacts && artifacts.asmFiles.length > 0
                ? `用 gvim 打开反汇编（共 ${artifacts.asmFiles.length} 个 .asm）`
                : missingHint
            }
            onClick={() =>
              artifacts && artifacts.asmFiles.length > 0 && openArtifact(artifacts.asmFiles[0], true)
            }
          >
            <Edit3 className="size-3 shrink-0 text-muted-foreground" />
            <span>反汇编</span>
            <span className={MENU_SUB}>gvim</span>
          </button>
          {/* 在文件管理器中打开用例目录 */}
          <div className="my-1 border-t border-border" />
          <button
            data-testid={`sim-rowdbg-${run.runId}-menu-open-casedir`}
            className={MENU_ITEM}
            onClick={openCaseDir}
            disabled={!hasCase}
            title={hasCase ? '在系统文件管理器中打开用例目录' : missingHint}
          >
            <FolderOpen className="size-3 shrink-0 text-muted-foreground" />
            <span>在文件管理器中打开用例目录</span>
          </button>
        </div>
      )}
    </div>
  );
});

export function RunListPanel({ projectId }: { projectId?: string } = {}) {
  const activeRuns = useSimulationStore((s) => s.activeRuns);
  const loading = useSimulationStore((s) => s.loadingActiveRuns);
  const loadActiveRuns = useSimulationStore((s) => s.loadActiveRuns);
  const stopAllRuns = useSimulationStore((s) => s.stopAllRuns);
  const open = useWorkbenchStore((s) => s.open);

  // The workspace running-simulations destination can be opened directly,
  // without mounting SimulationView first, so it must load persisted runs too.
  useEffect(() => {
    if (projectId && typeof loadActiveRuns === 'function') {
      void loadActiveRuns(projectId);
    }
  }, [projectId, loadActiveRuns]);

  const [seg, setSeg] = useState<SegKey>('all');
  const [keyword, setKeyword] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // 有运行中的仿真时秒级刷新实时耗时
  const hasLive = activeRuns.some((r) => r.status === 'running' || r.status === 'pending');
  useEffect(() => {
    if (!hasLive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLive]);

  const counts = useMemo(() => {
    const c: Record<SegKey, number> = { all: activeRuns.length, running: 0, fail: 0, pass: 0, queued: 0, stopped: 0 };
    for (const r of activeRuns) {
      for (const s of SEGMENTS) {
        if (s.key !== 'all' && s.match(r)) c[s.key] += 1;
      }
    }
    return c;
  }, [activeRuns]);

  const filtered = useMemo(() => {
    const segMatch = SEGMENTS.find((s) => s.key === seg)?.match ?? (() => true);
    const kw = keyword.trim().toLowerCase();
    return activeRuns
      .filter((r) => segMatch(r))
      .filter((r) => {
        if (!kw) return true;
        const name = (r.caseName ?? r.caseId).toLowerCase();
        return name.includes(kw) || (r.seed ?? '').toLowerCase().includes(kw);
      })
      .sort((a, b) => {
        const rank = (r: SimulationRunRecord) =>
          r.status === 'running' || r.status === 'pending'
            ? 0
            : r.status === 'fail' || r.status === 'error'
              ? 1
              : 2;
        return rank(a) - rank(b) || b.startTime - a.startTime;
      });
  }, [activeRuns, seg, keyword]);

  const clearFilters = () => {
    setSeg('all');
    setKeyword('');
  };

  // ─── 虚拟滚动 ──────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 初始读取视口高度
    setViewportHeight(el.clientHeight || 600);
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 监听容器大小变化（窗口 resize 等）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight || 600);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalRows = filtered.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visibleSlice = filtered.slice(startIndex, endIndex);
  const topSpacer = startIndex * ROW_HEIGHT;
  const bottomSpacer = (totalRows - endIndex) * ROW_HEIGHT;

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="run-list-panel">
      {/* ── Filter bar: segments + keyword + stop-all ─────────── */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">运行列表</h3>
        </div>
        <div className="flex items-center gap-1" data-testid="sim-seg">
          {SEGMENTS.map((s) => (
            <button
              key={s.key}
              type="button"
              data-testid={`sim-seg-${s.key}`}
              aria-pressed={seg === s.key}
              className="ap-ft-chip"
              onClick={() => setSeg(s.key)}
            >
              {s.dot && <span className="ap-ft-dot" style={{ background: s.dot }} />}
              {s.label}
              <span className="ap-ft-badge">{counts[s.key]}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-muted-foreground">
            <Search className="size-3 shrink-0" />
            <input
              data-testid="sim-filter-input"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="过滤用例名 / seed…"
              autoComplete="off"
              className="w-32 border-none bg-transparent font-sans text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
            />
          </div>
          <button
            className="inline-flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-[11px] text-status-fail-foreground transition-colors hover:bg-status-fail/15 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void stopAllRuns()}
            disabled={!hasLive}
            data-testid="run-list-stop-all"
            title="停止全部运行中/队列中的仿真"
          >
            <Square className="size-2.5" fill="currentColor" />
            停止全部
          </button>
        </div>
      </div>

      {/* ── Table header (sticky, not scrollable) ────────────── */}
      <div
        className={cn(ROW_GRID, 'gap-2 border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/60')}
      >
        <span />
        <span>用例</span>
        <span>子系统</span>
        <span>进度</span>
        <span>耗时</span>
        <span className="text-right">ETA</span>
        <span title="Debug 快捷操作（悬停行显示）" />
      </div>

      {/* ── Table body (virtual scrollable) ────────────────────── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        data-testid="run-list-virtual-scroll"
      >
        {loading && activeRuns.length === 0 ? (
          <div className="flex flex-col gap-2 p-3" data-testid="sim-view-skeleton">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="h-7 w-full animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : activeRuns.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 px-3 py-12 text-muted-foreground"
            data-testid="sim-view-empty"
          >
            <span className="text-xs">暂无仿真运行</span>
            <span className="text-[11px] opacity-60">从左侧用例树或 Option 面板启动仿真后此处实时展示</span>
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 px-3 py-12 text-muted-foreground"
            data-testid="sim-view-no-match"
          >
            <Search className="size-6 opacity-30" />
            <span className="text-xs">无匹配的仿真运行</span>
            <button
              className="cursor-pointer rounded border border-border px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={clearFilters}
              data-testid="sim-clear-filters"
            >
              清空筛选
            </button>
          </div>
        ) : (
          <>
            {/* 顶部空间 — 撑起虚拟滚动上方区域 */}
            {topSpacer > 0 && (
              <div style={{ height: topSpacer }} aria-hidden="true" />
            )}
            {visibleSlice.map((run) => (
              <RunRow
                key={run.runId}
                run={run}
                now={now}
                onOpen={() => open({ type: 'simulation-detail', runId: run.runId })}
              />
            ))}
            {/* 底部空间 — 撑起虚拟滚动下方区域 */}
            {bottomSpacer > 0 && (
              <div style={{ height: bottomSpacer }} aria-hidden="true" />
            )}
          </>
        )}
      </div>
    </div>
  );
}
