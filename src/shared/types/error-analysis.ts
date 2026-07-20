/** 失败仿真的错误分类 */
export type ErrorType = 'compile_error' | 'sim_error';

/** 错误分析会话的状态 */
export type ErrorAnalysisStatus = 'analyzing' | 'fixing' | 'retrying' | 'completed' | 'stopped' | 'failed';

/** 错误分析会话信息 */
export interface ErrorAnalysisSession {
  sessionId: string;
  projectId: string;
  caseName: string;
  errorType: ErrorType;
  status: ErrorAnalysisStatus;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  /** 触发错误分析的仿真 runId */
  sourceRunId?: string;
  /** 错误上下文摘要 */
  errorSummary?: string;
}

/** 从日志中提取的结构化编译错误 */
export interface ExtractedCompileError {
  tool: 'Xcelium' | 'VCS';
  errorType?: string;
  errorCode: string;
  file?: string;
  line?: string;
  errorInfo: string;
  lineNumber: number;
  context: string[];
}

/** 从日志中提取的结构化仿真错误 */
export interface ExtractedSimError {
  tool: 'UVM' | 'SPRD' | 'VCS' | 'VCS/NC' | 'Timing';
  severity?: string;
  errorType?: string;
  timestamp?: string;
  testCase?: string;
  message: string;
  file?: string;
  line?: string;
  location?: string;
  code?: string;
  typeName?: string;
  index?: string;
  lineNumber: number;
  context: string[];
}

/** 日志分析结果 */
export interface LogAnalysisResult {
  filePath: string;
  toolType: string;
  totalLines: number;
  totalErrors: number;
  errors: ExtractedCompileError[] | ExtractedSimError[];
  truncated: boolean;
  criticalErrors?: number;
  fatalErrors?: number;
  errorCount?: number;
}
