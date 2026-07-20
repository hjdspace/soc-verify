export interface AppVersionInfo {
  app: string;
  version: string;
  stage: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  lastOpenedAt: number;
}

export interface ProjectState {
  projectId: string;
  uiLayout: {
    leftRailCollapsed: boolean;
    rightPanelCollapsed: boolean;
    optionDockExpanded: boolean;
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
}

export interface FileTreeUpdate {
  projectId: string;
  type: 'add' | 'unlink' | 'change';
  path: string;
}
