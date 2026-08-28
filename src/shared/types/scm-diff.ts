/**
 * 源代码管理（SCM）文件 diff 类型——git 变更人工审查用。
 *
 * 与 diff-review（AI 编辑审阅）是两个独立领域：这里只承载
 * git diff 的只读展示结构，无 tool call 归属与撤销语义。
 */

export type ScmDiffLineType = 'ctx' | 'add' | 'del';

export type ScmDiffLine = {
  type: ScmDiffLineType;
  /** 行内容（不含前缀符号） */
  content: string;
  /** 旧文件行号（del/ctx 行有值） */
  oldLine?: number;
  /** 新文件行号（add/ctx 行有值） */
  newLine?: number;
};

export type ScmDiffHunk = {
  /** `@@ -a,b +c,d @@` 原始头文本 */
  header: string;
  lines: ScmDiffLine[];
};

export type ScmFileDiff = {
  /** 相对项目根的文件路径 */
  path: string;
  /** true=已暂存 diff（HEAD vs index）；false=未暂存 diff（index vs 工作区） */
  staged: boolean;
  /** 新增文件（全部行都是新增） */
  isNewFile: boolean;
  /** 被删除的文件 */
  isDeleted: boolean;
  /** 二进制文件（无法展示文本 diff） */
  isBinary: boolean;
  hunks: ScmDiffHunk[];
  totalAdd: number;
  totalDel: number;
};
