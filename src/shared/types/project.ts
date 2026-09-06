import type { PluginViewLocation } from '../plugin-types';

export type DirGroup = 'verify' | 'design';

export interface ExtraDirEntry {
  id: string;
  path: string;
  group: DirGroup;
  label?: string;
  isCwd: boolean;
  order: number;
  createdAt: number;
}

export interface AppVersionInfo {
  app: string;
  version: string;
  stage: string;
}

export interface PluginViewLayoutState {
  activeViewId?: string;
  collapsed?: boolean;
}

export interface ProjectInfo {
  id: string;
  name: string;
  rootPath: string;
  /** 项目标记名：独立于目录名的用户可编辑项目标签。
   *  默认从 $PROJ_RTL 路径解析（/proj/<ProjectName>/xxx → 第二级目录名）。
   *  用户可通过 UI 修改，持久化到 .socverify/config.json。 */
  projectLabel?: string;
  /** 用户后续添加的额外目录。rootPath 不存入此处（隐式属于验证组第一项 = 默认 cwd）。 */
  extraDirs?: ExtraDirEntry[];
  createdAt: number;
  lastOpenedAt: number;
}

export interface ProjectState {
  projectId: string;
  uiLayout: {
    rightPanelCollapsed: boolean;
    /** @deprecated UI store 已移除此字段；仅用于读取旧持久化状态。 */
    optionDockExpanded?: boolean;
    pluginViews?: Partial<Record<PluginViewLocation, PluginViewLayoutState>>;
    /** App Shell 活动视图（mission-control 布局）；旧持久化状态可能缺失 */
    activeView?: string;
    /** AI 面板呈现模式（drawer | docked）；旧持久化状态可能缺失 */
    aiPanelMode?: string;
    /** 文件面板呈现模式（drawer | docked）；旧持久化状态可能缺失 */
    filePanelMode?: string;
    /** 文件面板（docked 模式）折叠状态；旧持久化状态可能缺失 */
    filePanelCollapsed?: boolean;
    /** 文件面板（docked 模式）宽度；旧持久化状态可能缺失 */
    filePanelWidth?: number;
    /** 仿真视图左栏宽度（可拖拽调整）；旧持久化状态可能缺失 */
    simLeftPanelWidth?: number;
    /** 设计视图层级树侧边栏宽度（可拖拽调整）；旧持久化状态可能缺失 */
    designTreeWidth?: number;
  };
  lastSessionIds: string[];
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
  /** True when this file/directory is ignored by .gitignore (dimmed in the tree). */
  gitIgnored?: boolean;
  /** True when this directory's children have not been loaded yet (lazy loading).
   * The UI shows an expand arrow; children are fetched on first expand. */
  lazy?: boolean;
}

export interface FileTreeUpdate {
  projectId: string;
  type: 'add' | 'unlink' | 'change';
  path: string;
}
