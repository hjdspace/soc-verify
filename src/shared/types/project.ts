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
  /** 用户后续添加的额外目录。rootPath 不存入此处（隐式属于验证组第一项 = 默认 cwd）。 */
  extraDirs?: ExtraDirEntry[];
  createdAt: number;
  lastOpenedAt: number;
}

export interface ProjectState {
  projectId: string;
  uiLayout: {
    leftRailCollapsed: boolean;
    rightPanelCollapsed: boolean;
    optionDockExpanded: boolean;
    pluginViews?: Partial<Record<PluginViewLocation, PluginViewLayoutState>>;
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
