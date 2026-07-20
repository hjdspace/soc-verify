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
}

export interface SourceControlCommitResult {
  commitHash: string;
  summary: string;
}
