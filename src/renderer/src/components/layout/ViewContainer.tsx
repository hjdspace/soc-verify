import { useUiStore } from '@renderer/stores/ui';
import { CenterArea } from './CenterArea';
import { DashboardView } from '@renderer/components/views/DashboardView';
import { SimulationView } from '@renderer/components/views/SimulationView';
import { CoverageView } from '@renderer/components/views/CoverageView';
import { RegressionView } from '@renderer/components/views/RegressionView';

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

/**
 * 视图路由容器：按 ui.activeView 渲染五个视图。
 * 总览视图为 Mission Control 仪表盘（Issue #3）；
 * 仿真视图为运行管理工作台（Issue #4）；
 * 覆盖率视图为覆盖率分析工作台（Issue #5）；
 * 回归视图为回归测试管理工作台（Issue #6）；
 * 深度分析经 coverage-detail / regression-detail 目的地开 workspace Tab（CenterArea）。
 * docked 模式的 AI 右栏由 AppShell 全局渲染，所有视图共享。
 */
export function ViewContainer() {
  const activeView = useUiStore((s) => s.activeView);

  switch (activeView) {
    case 'dashboard':
      return <DashboardView />;
    case 'simulation':
      return <SimulationView />;
    case 'coverage':
      return <CoverageView />;
    case 'regression':
      return <RegressionView />;
    case 'workspace':
      return <WorkspaceView />;
  }
}
