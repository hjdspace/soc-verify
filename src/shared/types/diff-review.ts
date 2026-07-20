/** 单个 tool call 的信息，用于 diff 计算和撤销 */
export interface DiffToolCall {
  /** 工具调用唯一标识 */
  id: string;
  /** 工具名：write / edit / apply_patch / ast_edit */
  toolName: string;
  /** 文件路径 */
  filePath: string;
  /** 时间戳，用于排序 */
  timestamp: number;
  /** 来源会话 ID */
  sessionId?: string;
  /** EDIT: oldText（被替换的原文段） */
  oldText?: string;
  /** EDIT: newText（替换后的新文段） */
  newText?: string;
  /** WRITE: 文件内容（全量新增） */
  content?: string;
  /** 是否为创建新文件（WRITE 工具） */
  isNewFile: boolean;
}

/** Diff 中的一行 */
export interface DiffLine {
  /** 行类型：ctx=上下文, add=新增, del=删除 */
  type: 'ctx' | 'add' | 'del';
  /** 行内容（不含前缀符号） */
  content: string;
  /** 原文件行号（del 行有值） */
  oldLine?: number;
  /** 新文件行号（add 和 ctx 行有值） */
  newLine?: number;
  /** 所属 hunk 序号（从 1 开始），ctx 行为 null */
  hunkId?: number;
}

/** Hunk 边界信息 */
export interface DiffHunkInfo {
  /** hunk 序号（从 1 开始） */
  id: number;
  /** 来源 tool call ID */
  toolCallId: string;
  /** 来源工具名 */
  toolName: string;
  /** 该 hunk 是否已被后续编辑覆盖（无法拒绝） */
  overwritten: boolean;
  /** 该 hunk 在 diff 行数组中的起始索引 */
  startLineIndex: number;
  /** 该 hunk 在 diff 行数组中的结束索引（不含） */
  endLineIndex: number;
  /** 统计：新增行数 */
  addCount: number;
  /** 统计：删除行数 */
  delCount: number;
}

/** getFileDiff API 返回的完整文件 diff 结果 */
export interface FileDiffResult {
  /** 文件路径 */
  filePath: string;
  /** 文件是否为新创建（WRITE） */
  isNewFile: boolean;
  /** diff 行数组（包含 ctx/add/del） */
  lines: DiffLine[];
  /** hunk 列表 */
  hunks: DiffHunkInfo[];
  /** 统计：总新增行数 */
  totalAdd: number;
  /** 统计：总删除行数 */
  totalDel: number;
}

/** applyDiffRejections 的单个拒绝项 */
export interface DiffRejection {
  /** hunk 序号 */
  hunkId: number;
  /** 来源 tool call ID */
  toolCallId: string;
  /** 工具名 */
  toolName: string;
  /** oldText（用于撤销替换） */
  oldText?: string;
  /** newText（用于定位和替换） */
  newText?: string;
  /** 是否为删除整个文件（WRITE 拒绝） */
  deleteFile: boolean;
}

/** applyDiffRejections API 的返回 */
export interface ApplyRejectionsResult {
  ok: boolean;
  /** 成功应用的拒绝数 */
  appliedCount: number;
  /** 失败的拒绝（oldText 在文件中未找到等） */
  failures: Array<{ hunkId: number; reason: string }>;
}
