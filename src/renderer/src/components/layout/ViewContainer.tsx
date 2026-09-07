import { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@renderer/lib/utils';
import { useUiStore, type ActiveView } from '@renderer/stores/ui';
import { CenterArea } from './CenterArea';
import { DashboardView } from '@renderer/components/views/DashboardView';
import { SimulationView } from '@renderer/components/views/SimulationView';
import { CoverageView } from '@renderer/components/views/CoverageView';
import { RegressionView } from '@renderer/components/views/RegressionView';
import { TokenView } from '@renderer/components/views/TokenView';
import { DesignView } from '@renderer/components/views/DesignView';

/**
 * 工作区视图：多 Tab 工作台原样完整嵌入。
 * Issue #7 后文件树/子系统移入左抽屉（全局可呼出），LeftRail 渲染路径已退役；
 * AI 会话默认走右抽屉（AiDrawer），docked 模式由 AppShell 全局渲染右栏。
 */
function WorkspaceView() {
  return (
    <div className="flex flex-1 overflow-hidden">
      <CenterArea />
    </div>
  );
}

/** 视图路由渲染（保持原 switch 语义） */
function renderActiveView(view: ActiveView) {
  switch (view) {
    case 'dashboard':
      return <DashboardView />;
    case 'simulation':
      return <SimulationView />;
    case 'coverage':
      return <CoverageView />;
    case 'regression':
      return <RegressionView />;
    case 'token':
      return <TokenView />;
    case 'design':
      return <DesignView />;
    case 'workspace':
      return <WorkspaceView />;
  }
}

/**
 * 需要 keep-alive 的视图：切走时保留 DOM（隐藏），切回零挂载成本。
 * - simulation：仿真视图含万级用例树 + 运行列表，全量重建是切换卡顿的主因。
 * - workspace：多 Tab 工作台内的终端依赖 TerminalKeepAliveLayer 常驻
 *   xterm 实例（含 10 万行 scrollback），视图卸载会连带销毁终端缓冲，
 *   切回时需跨 IPC 全量恢复输出（大日志下表现为空白数秒）。
 */
const KEEP_ALIVE_VIEWS: ReadonlySet<ActiveView> = new Set(['simulation', 'workspace']);

/** 视图路由容器：按 ui.activeView 渲染七个视图。
 * 总览视图为 Mission Control 仪表盘（Issue #3）；
 * 仿真视图为运行管理工作台（Issue #4）；
 * 覆盖率视图为覆盖率分析工作台（Issue #5）；
 * 回归视图为回归测试管理工作台（Issue #6）；
 * 深度分析经 coverage-detail / regression-detail 目的地开 workspace Tab（CenterArea）。
 * docked 模式的 AI 右栏由 AppShell 全局渲染，所有视图共享。
 *
 * 视图切换过渡：popLayout 让旧视图退出时脱离文档流（绝对定位原位淡出），
 * 新视图同时入场，交叉淡入避免硬切。过渡用临界欠阻尼弹簧
 * （damping 0.8 / response 0.3，apple-design §4：弹簧无固定时长、
 * 目标切换时从当前展示值继续，比固定时长 ease 更自然）。
 *
 * 性能（keep-alive）：KEEP_ALIVE_VIEWS 中的视图首次激活后常驻 DOM，
 * 切走时 display:none 而非卸载（卸载会丢弃已加载的子系统/用例树状态，
 * 切回需重建上万 CaseTreeItem 导致明显卡顿）。AnimatePresence 只负责
 * 非 keep-alive 视图的交叉淡入；keep-alive 视图由 KeepAliveLayer 承载，
 * 避免同一视图双实例竞争 tRPC 事件与 store 订阅。
 */
export function ViewContainer() {
  const activeView = useUiStore((s) => s.activeView);
  const simulationViewMounted = useUiStore((s) => s.simulationViewMounted);
  const setSimulationViewMounted = useUiStore((s) => s.setSimulationViewMounted);
  const workspaceViewMounted = useUiStore((s) => s.workspaceViewMounted);
  const setWorkspaceViewMounted = useUiStore((s) => s.setWorkspaceViewMounted);

  // keep-alive 视图首次激活时置位（effect 内 set，渲染期无副作用）
  useEffect(() => {
    if (activeView === 'simulation' && !simulationViewMounted) {
      setSimulationViewMounted(true);
    }
  }, [activeView, simulationViewMounted, setSimulationViewMounted]);

  useEffect(() => {
    if (activeView === 'workspace' && !workspaceViewMounted) {
      setWorkspaceViewMounted(true);
    }
  }, [activeView, workspaceViewMounted, setWorkspaceViewMounted]);

  return (
    <>
      {/* keep-alive 层：仿真视图挂载后常驻，仅激活时可见 */}
      {simulationViewMounted && (
        <div
          className={cn(
            'min-h-0 flex-1 flex-col overflow-hidden',
            activeView === 'simulation' ? 'flex' : 'hidden',
          )}
          aria-hidden={activeView !== 'simulation'}
        >
          <SimulationView />
        </div>
      )}
      {/* keep-alive 层：workspace（多 Tab 工作台）挂载后常驻，仅激活时可见 */}
      {workspaceViewMounted && (
        <div
          className={cn(
            'min-h-0 flex-1 flex-col overflow-hidden',
            activeView === 'workspace' ? 'flex' : 'hidden',
          )}
          aria-hidden={activeView !== 'workspace'}
        >
          <WorkspaceView />
        </div>
      )}
      <AnimatePresence mode="popLayout" initial={false}>
        {/* keep-alive 视图激活时由上方常驻层渲染，此层跳过 */}
        {!KEEP_ALIVE_VIEWS.has(activeView) && (
          <motion.div
            key={activeView}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ type: 'spring', stiffness: 439, damping: 33 }}
            className="flex min-h-0 flex-1 flex-col overflow-hidden will-change-[opacity,transform]"
          >
            {renderActiveView(activeView)}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
