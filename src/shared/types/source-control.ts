export interface SourceControlFileStatus {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workTreeStatus: string;
  staged: boolean;
  unstaged: boolean;
}

export interface SourceControlStatus {
  isRepository: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: SourceControlFileStatus[];
  /**
   * 状态获取失败/降级原因（如 dubious ownership、git 不可用、stdout 超限）。
   * 仅在 isRepository 为 false 时由后端填充，供 UI 展示诊断信息。
   */
  notice?: string;
}

export interface SourceControlCommitResult {
  commitHash: string;
  summary: string;
}
