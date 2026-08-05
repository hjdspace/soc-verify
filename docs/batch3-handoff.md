# Batch 3 工具移植 Handoff 文档

> 本文档为 AI Agent 提供 Batch 3（7 个工具）从 Python/PyQt5 移植到 Electron/React/TypeScript 的完整交付信息。

## 目录

1. [项目背景与已完成工作](#1-项目背景与已完成工作)
2. [架构约定](#2-架构约定)
3. [Batch 3 工具总览](#3-batch-3-工具总览)
4. [工具 1: git-manager](#工具-1-git-manager)
5. [工具 2: git-diff](#工具-2-git-diff)
6. [工具 3: git-quick-pull](#工具-3-git-quick-pull)
7. [工具 4: register-table-parser](#工具-4-register-table-parser)
8. [工具 5: reg2c](#工具-5-reg2c)
9. [工具 6: c-sv-converter](#工具-6-c-sv-converter)
10. [工具 7: sv-ifdef-checker](#工具-7-sv-ifdef-checker)
11. [验证检查清单](#11-验证检查清单)

---

## 1. 项目背景与已完成工作

### 项目概述

**SoC Verify** 是 AI Agent 驱动的 SoC 验证一站式管理平台（Electron 应用）。原系统为 Python/PyQt5 桌面应用（`runsim_r3p0`），现正在将 19 个插件工具移植到 Electron/React/TypeScript。

### Python 源码位置

所有 Python 原始插件位于：
```
d:/doc/python/runsim_r3p0/plugins/user/
```

### 已完成工具（Batch 1 + Batch 2）

| Batch | 工具 ID | 状态 |
|-------|---------|------|
| 1 | `env-checker` | ✅ 已完成 |
| 1 | `code-line-counter` | ✅ 已完成 |
| 1 | `find-replace` | ✅ 已完成 |
| 1 | `resource-monitor` | ✅ 已完成 |
| 1 | `performance-monitor` | ✅ 已完成 |
| 1 | `log-analyzer` | ✅ 已完成 |
| 1 | `time-analyzer` | ✅ 已完成 |
| 1 | `coverage-merger` | ✅ 已完成 |
| 1 | `batch-execution` | ✅ 已完成 |
| 2 | `regression-analyzer` | ✅ 已完成 |
| 2 | `regression-list-gen` | ✅ 已完成 |

### 已删除工具

| 工具 ID | 原因 |
|---------|------|
| `regression-viewer` | 用处不大，已从 `tool-types.ts`、`registry.tsx`、`tools-router.ts` 中彻底移除 |

---

## 2. 架构约定

### 三层架构

每个工具由三层组成：

```
src/main/tools/<tool-id>.ts          ← 后端逻辑（主进程，Node.js 环境）
src/renderer/src/tools/<tool-id>/    ← 前端 UI（React 组件）
    └── <ToolName>.tsx
src/main/ipc/routers/tools-router.ts ← tRPC 路由（连接前后端）
```

### 已有基础设施

- **`src/shared/tool-types.ts`**: `ALL_TOOLS` 数组已包含全部 7 个 Batch 3 工具的元数据（id、name、icon、category、width、height）
- **`src/renderer/src/tools/registry.tsx`**: Batch 3 工具已注册为 `ToolPlaceholder`（占位组件）
- **`src/main/tools/tool-window-manager.ts`**: 工具窗口管理器（单例模式，hash routing `#tool=<id>`）
- **`src/renderer/src/tools/ToolApp.tsx`**: 工具应用入口，根据 hash 路由加载对应组件
- **`src/renderer/src/tools/ToolWindow.tsx`**: 工具窗口容器

### tRPC 路由模式

在 `tools-router.ts` 中添加子路由的模式：

```typescript
// 1. 导入后端逻辑
import { someFunction, type SomeType } from '../../tools/<tool-id>';

// 2. 定义子路由
const toolRouter = t.router({
  someAction: t.procedure
    .input((raw): { param: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.param !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'param is required' });
      }
      return { param: r.param };
    })
    .mutation(async ({ input }) => {
      const result = await someFunction(input.param);
      return result;
    }),
});

// 3. 注册到主路由
export const toolsRouter = t.router({
  // ... existing routers ...
  toolId: toolRouter,
});
```

### 前端组件模式

```typescript
// src/renderer/src/tools/<tool-id>/<ToolName>.tsx

import { trpc } from '../../lib/trpc';

export type ToolComponentProps = {
  projectRoot: string | null;
  onProjectRootChange: (path: string) => void;
};

export function ToolName({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  // 使用 trpc.proxy.tools.<toolId>.<procedure>.query/mutate 调用后端
  // 使用 shadcn/ui 组件构建 UI
  // 使用 Tailwind CSS 样式
  return (
    <div className="flex flex-col h-full">
      {/* UI 内容 */}
    </div>
  );
}
```

### 注册组件

在 `registry.tsx` 中将 `ToolPlaceholder` 替换为实际组件：

```typescript
import { ToolName } from './<tool-id>/<ToolName>';
// ...
'<tool-id>': { component: ToolName },
```

### 文件对话框

tools-router 已提供通用文件对话框 API：
- `tools.selectDirectory` — 选择目录
- `tools.selectFiles` — 选择文件（支持多选 + 过滤器）
- `tools.saveFileDialog` — 保存文件对话框

---

## 3. Batch 3 工具总览

| # | 工具 ID | 名称 | Python 源码目录 | 复杂度 |
|---|---------|------|-----------------|--------|
| 1 | `git-manager` | Git 版本控制管理 | `git_manager/` | ★★★★★ 高 |
| 2 | `git-diff` | Git 文件版本比对 | `git_diff/` | ★★★★ 中高 |
| 3 | `git-quick-pull` | Git 一键 Pull | `git_quick_pull/` | ★★ 低 |
| 4 | `register-table-parser` | 寄存器表格解析器 | `register_table_parser/` | ★★★ 中 |
| 5 | `reg2c` | 寄存器表格转 C 驱动头文件 | `reg2c/` | ★★★ 中 |
| 6 | `c-sv-converter` | C/SV 代码互转 | `c_to_sv_converter/` | ★★★★★ 高 |
| 7 | `sv-ifdef-checker` | SV ifdef 检查器 | `sv_ifdef_checker/` | ★★ 低 |

---

## 工具 1: git-manager

### Python 源码路径

```
d:/doc/python/runsim_r3p0/plugins/user/git_manager_plugin.py        ← 插件入口
d:/doc/python/runsim_r3p0/plugins/user/git_manager/
├── core/
│   ├── git_utils.py          ← 核心逻辑（仓库扫描、tag管理、git操作）
│   ├── async_loader.py       ← 异步加载器
│   ├── cache_manager.py      ← 缓存管理
│   ├── config_manager.py     ← 配置管理
│   └── subprocess_wrapper.py ← 子进程封装
├── ui/
│   ├── main_window.py        ← 主窗口（卡片式UI）
│   ├── repo_card.py          ← 仓库卡片组件
│   ├── repo_selection_dialog.py ← 仓库选择对话框
│   ├── tag_dialog.py         ← 标签选择对话框
│   ├── update_dialog.py      ← 更新对话框
│   ├── update_dialog_enhanced.py ← 增强版更新对话框
│   └── progress_widget.py    ← 进度组件
└── resources/
    └── git_icon.svg
```

### 功能概要

多 Git 仓库管理工具，支持 DE/DV 目录结构：

1. **仓库发现**: 扫描 `$PROJ_DIR/de/*` 和 `$PROJ_DIR/dv/*`（含 `dv/udtb/*`）下的所有 Git 仓库
2. **仓库信息**: 获取每个仓库的分支、标签、最后提交信息、是否有未提交更改
3. **标签管理**: 通过 `cqp_query` 命令查询标签列表，通过 `checkout_cqp_tag` 命令切换标签
4. **批量更新**: `git pull` 所有 DV 或 DE 仓库，实时输出日志
5. **subsys 更新**: 按子系统前缀过滤仓库进行更新

### 核心数据结构

```typescript
// Python: GitRepoInfo dataclass → TypeScript:
type GitRepoInfo = {
  name: string;           // 仓库名称，如 "apcpu_sys" 或 "udtb/apcpu_sys"
  path: string;           // 绝对路径
  repoType: 'de' | 'dv';  // 仓库类型
  currentBranch: string;  // 当前分支
  currentTag: string;     // 当前标签
  lastCommitHash: string; // 最后提交哈希
  lastCommitMessage: string;
  lastCommitTime: string;
  hasChanges: boolean;    // 是否有未提交更改
  tags: string[];         // 可用标签列表
  subsysTag?: string;     // xxx_sys 仓库的子系统标签
};
```

### 关键实现细节

1. **仓库扫描逻辑** (`git_utils.py:36-118`):
   - DE 仓库: `os.listdir(project_dir/de)`，检查 `.git` 目录
   - DV 仓库: `os.listdir(project_dir/dv)`，`udtb` 子目录需二级扫描
   - 仅检查 `.git` 目录存在性，不调用 git 命令

2. **标签查询** (`git_utils.py:169-278`):
   - 调用外部命令 `cqp_query -dpt <de|dv> -sys <sys_name>`
   - 解析输出格式: `2025-09-02 10:49:58 DE_apcpu_sys_0015_cq_goodcode xxx`
   - 正则匹配: `\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+(\S+)\s+\S+`
   - 对于 `xxx_sys` 仓库，额外从 `git tag -l` 获取 `DE_{sys_name}_NNNN_*_goodcode` 标签

3. **标签切换** (`git_utils.py:280-327`):
   - 调用 `checkout_cqp_tag -dpt <type> -sys <sys> -tag <tag>`
   - 使用 `subprocess.Popen` 实时输出日志

4. **批量更新** (`git_utils.py:364-481, 483-600`):
   - 顺序执行 `git pull`（非并行）
   - 标记正在更新的仓库（`mark_repo_updating`），避免信息刷新冲突
   - 检测 "Already up to date" / "Already up-to-date" 判断是否有实际更新
   - 分类失败原因: 代码冲突 / 本地修改冲突 / git pull失败

### 后端 tRPC API 设计建议

```typescript
// tools.gitManager 子路由
{
  discoverRepos: query → { repos: GitRepoInfo[] }      // 扫描仓库 + 获取基本信息
  getRepoTags: query → { tags: string[] }              // 获取仓库标签列表
  checkoutTag: mutation → { success: boolean }          // 切换标签（流式日志）
  updateAllRepos: mutation → { success, logs, summary } // 批量 git pull
  updateSubsysRepos: mutation → { ... }                 // 按 subsys 更新
}
```

### UI 设计要点

- 卡片式布局展示仓库列表（参考 `repo_card.py`）
- 每张卡片显示: 仓库名、分支、标签、最后提交信息、更改状态
- 标签切换: 下拉选择 + 日志输出对话框
- 批量更新: 进度条 + 实时日志 + 成功/失败统计

---

## 工具 2: git-diff

### Python 源码路径

```
d:/doc/python/runsim_r3p0/plugins/user/git_diff_plugin.py     ← 插件入口
d:/doc/python/runsim_r3p0/plugins/user/git_diff/
├── models/
│   ├── git_repository.py     ← Git 仓库操作（使用 GitPython 库）
│   ├── file_diff.py          ← 文件差异计算（difflib）
│   ├── syntax_highlighter.py ← 语法高亮
│   └── external_tools.py     ← 外部工具调用
├── views/
│   ├── main_window.py        ← 主窗口
│   ├── file_selector.py      ← 文件选择器
│   ├── version_selector.py   ← 版本选择器
│   ├── diff_viewer.py        ← 差异查看器
│   ├── diff_navigator.py     ← 差异导航器
│   ├── toolbar.py            ← 工具栏
│   └── settings_dialog.py    ← 设置对话框
└── utils/
    └── file_utils.py         ← 文件工具
```

### 功能概要

Git 仓库中文件的版本比对工具：

1. **仓库选择**: 选择 Git 仓库（使用 GitPython 的 `Repo` 类）
2. **文件选择**: 浏览仓库中 Git 跟踪的文件列表
3. **版本选择**: 选择文件的提交历史（`iter_commits`），支持选择两个版本进行比对
4. **差异展示**:
   - 统一格式差异（`difflib.unified_diff`）
   - 并排格式差异（`difflib.SequenceMatcher`）
   - 差异块（hunks）提取
5. **统计信息**: 新增行数、删除行数、修改行数、上下文行数
6. **语法高亮**: 对代码进行语法高亮显示

### 核心数据结构

```typescript
// Python: DiffLine NamedTuple → TypeScript:
type DiffLineType = 'context' | 'add' | 'delete' | 'modify';

type DiffLine = {
  lineType: DiffLineType;
  oldLineNo: number | null;
  newLineNo: number | null;
  content: string;
};

type DiffStats = {
  addedLines: number;
  deletedLines: number;
  modifiedLines: number;
  contextLines: number;
  totalChanges: number;
};

// Python: CommitInfo → TypeScript:
type CommitInfo = {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: Date;
  message: string;
  summary: string;
};
```

### 关键实现细节

1. **Git 操作** (`git_repository.py`):
   - Python 使用 `GitPython` 库（`git.Repo`）
   - TypeScript 移植建议: 使用 `child_process` 直接调用 `git` 命令，或使用 `simple-git` npm 包
   - `get_file_commits`: `git log --follow -- <file_path>` 获取提交历史
   - `get_file_content_at_commit`: `git show <commit_sha>:<file_path>` 获取历史版本内容
   - `get_tracked_files`: `git ls-files` 或读取 `repo.index.entries`
   - 文件编码处理: 尝试 utf-8 → gbk → gb2312 → latin-1

2. **差异计算** (`file_diff.py`):
   - 使用 Python `difflib` 模块
   - TypeScript 对应: 使用 `diff` npm 包（`diff.createPatch` / `diff.diffLines`）
   - `calculate_unified_diff`: `difflib.unified_diff(old_lines, new_lines, n=context_lines)`
   - `calculate_side_by_side_diff`: `difflib.SequenceMatcher` + `get_opcodes()`
   - `get_diff_hunks`: 提取有变化的代码块（带上下文行）

3. **文件编码检测** (`git_repository.py:186-216`):
   - Python 使用 `chardet` 库检测文件编码
   - TypeScript 对应: 使用 `jschardet` npm 包或 `iconv-lite`

### 后端 tRPC API 设计建议

```typescript
// tools.gitDiff 子路由
{
  openRepo: mutation → { repoRoot, branches, currentBranch }   // 打开仓库
  getTrackedFiles: query → { files: string[] }                 // 获取跟踪文件列表
  getFileCommits: query → { commits: CommitInfo[] }            // 获取文件提交历史
  getFileContent: query → { content: string }                  // 获取文件内容（指定版本）
  calculateDiff: query → { diffLines, stats, hunks }           // 计算差异
}
```

### UI 设计要点

- 左侧: 文件选择器（树形或列表）+ 版本选择器（提交列表）
- 右侧: 差异查看器（并排/统一格式切换）+ 差异导航（跳转到下一个/上一个差异）
- 底部: 统计信息（+N -M ~K）
- 工具栏: 视图模式切换、上下文行数调整

---

## 工具 3: git-quick-pull

### Python 源码路径

```
d:/doc/python/runsim_r3p0/plugins/user/git_quick_pull_plugin.py  ← 插件入口
d:/doc/python/runsim_r3p0/plugins/user/git_quick_pull/
├── core/
│   └── repo_scanner.py       ← 仓库扫描器（轻量级，无 git 命令）
└── ui/
    ├── quick_start_dialog.py  ← 快速启动对话框（选择环境+模式）
    └── pull_log_dialog.py     ← 日志对话框（实时输出+进度）
```

### 功能概要

轻量级一键 Git Pull 工具，启动速度 < 0.5 秒：

1. **仓库扫描** (`repo_scanner.py`): 仅检查 `.git` 目录存在性，不调用任何 git 命令
2. **环境选择**: DV / DE / DV+DE
3. **更新模式**: 
   - `pull`: 标准 `git pull`
   - `pull_reset`: `git fetch` + `git reset --hard origin/master`（⚠️ 危险操作）
   - `custom`: 自定义 git 命令
4. **并行执行**: 使用 `ThreadPoolExecutor`（max_workers=8）并行 pull 多个仓库
5. **实时日志**: 每个仓库的日志先缓冲到本地列表，处理完毕后一次性 flush，避免并行时日志交叉
6. **错误处理**: 单个仓库失败不中断整体流程，自动跳过有冲突的仓库
7. **统计总结**: 成功/跳过/失败数量 + 失败原因

### 核心数据结构

```typescript
type RepoInfo = {
  name: string;       // "apcpu_sys" 或 "udtb/apcpu_sys"
  path: string;       // 绝对路径
  repoType: 'dv' | 'de';
};

type PullMode = 'pull' | 'pull_reset' | 'custom';

type PullStats = {
  total: number;
  success: number;
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; reason: string }>;
};
```

### 关键实现细节

1. **仓库扫描** (`repo_scanner.py`): 与 `git_manager` 的 `GitUtils` 相同的扫描逻辑，但更轻量（不获取仓库详情）

2. **并行 Pull** (`pull_log_dialog.py:70-131`):
   - `ThreadPoolExecutor(max_workers=min(8, total_repos))`
   - 每个仓库在独立线程中执行
   - 日志缓冲机制: 每个仓库的日志先存入本地 `buf` 列表，处理完毕后通过 `_flush_buffer` 一次性发送
   - 线程安全的统计更新: 使用 `QMutex` 保护 `stats` 字典

3. **Pull Reset 模式** (`pull_log_dialog.py:258-323`):
   - 先检查 `git status --porcelain`，有未提交更改则跳过
   - 执行 `git fetch origin` → `git reset --hard origin/master`

4. **错误原因提取** (`pull_log_dialog.py:379-403`):
   - 从 git 输出中匹配: "error:" / "fatal:" / "conflict" / "would be overwritten" / "connection refused"

### 后端 tRPC API 设计建议

```typescript
// tools.gitQuickPull 子路由
{
  scanRepos: query → { repos: RepoInfo[] }                    // 扫描仓库（快速）
  executePull: mutation → { stats: PullStats }                // 执行 pull（流式日志）
}
```

注意: pull 执行需要流式日志输出。建议使用 IPC 事件（`gitQuickPull:log`）推送实时日志，或使用 tRPC subscription。

### UI 设计要点

- 极简两步操作: 第一步选择环境(DV/DE/All) + 模式(pull/pull_reset/custom)，第二步日志输出
- 日志区: 深色背景，等宽字体，彩色日志（✅ 绿色 / ⚠️ 黄色 / ❌ 红色）
- 进度条: 执行中显示不确定进度条
- 完成后: 显示统计总结 + 复制日志按钮

---

## 工具 4: register-table-parser

### Python 源码路径

```
d:/doc/python/runsim_r3p0/plugins/user/register_table_parser_plugin.py  ← 插件入口
d:/doc/python/runsim_r3p0/plugins/user/register_table_parser/
├── parser.py                 ← Excel 解析器（核心）
├── models.py                 ← 数据模型
├── main_window.py            ← 主窗口
├── widgets.py                ← UI 组件
├── utils.py                  ← 工具函数
├── performance_optimizations.py ← 性能优化
└── tests/                    ← 测试
```

### 功能概要

Excel 格式寄存器规格表解析器：

1. **Excel 解析** (`parser.py`): 支持 `.xls`（xlrd）和 `.xlsx`（openpyxl）格式
2. **表格格式**:
   - 第 1-4 行: 表头信息（项目名、子系统、模块名、基地址）
   - 第 5-9 行: 其他表头信息（忽略）
   - 第 10 行: 寄存器表头
   - 第 11 行: Register group（跳过）
   - 第 12 行起: 寄存器数据
3. **固定列映射**:
   - A列(1): Offset
   - B列(2): RegName
   - E列(5): Width
   - H列(8): Bit（位域，格式 `[30:0]`、`[0]`）
   - I列(9): FieldName
   - J列(10): RW
   - K列(11): ResetValue
   - L列(12): Set/Clear
4. **自动格式修复**: 检测异常字符（BOM、零宽空格、不间断空格），复制到新工作簿修复
5. **交互式查看**: 寄存器列表 + 字段详情 + 数值转换（二进制/十进制/十六进制）

### 核心数据结构

```typescript
type HeaderInfo = {
  projectName: string;
  subSystem: string;
  moduleName: string;
  baseAddr: string;
};

type FieldInfo = {
  name: string;
  bitRange: string;      // "30:0" 或 "0"
  rwAttribute: string;   // "RW" | "RO" | "WO"
  resetValue: string;
  description: string;
};

type RegisterInfo = {
  offset: string;        // "0x0004"
  name: string;
  description: string;
  width: number;         // 32
  fields: FieldInfo[];
};

type RegisterTableData = {
  header: HeaderInfo;
  registers: RegisterInfo[];
};
```

### 关键实现细节

1. **Excel 读取** (`parser.py:126-162`):
   - `.xls`: 使用 `xlrd` 库
   - `.xlsx`: 使用 `openpyxl` 库（`data_only=True` 读取计算值）
   - `XlsWorksheetWrapper`: 适配 xlrd 接口到 openpyxl 风格
   - TypeScript 移植建议: 使用 `exceljs`（已存在于项目中）或 `xlsx`（SheetJS）npm 包

2. **表头提取** (`parser.py:520-578`):
   - 遍历前 4 行，A 列为标签，B 列为值
   - 模糊匹配: "project"/"proj"/"项目" → 项目名，"sub"/"system"/"子系统" → 子系统

3. **寄存器解析** (`parser.py:580-651`):
   - 从第 12 行开始逐行解析
   - 有 offset + regName → 新寄存器
   - 有 fieldName → 字段，附加到当前寄存器
   - 跳过 "Register group" 行和空行
   - 跳过 "reserved"/"rsvd"/"保留" 字段

4. **位域解析** (`parser.py:786-824`):
   - 格式 `[30:0]` → "30:0"，格式 `[0]` → "0"
   - 移除中括号，验证 high >= low >= 0

5. **地址标准化** (`parser.py:868-899`):
   - 处理 `0x` 前缀、下划线分隔（`0x6495_1000`）
   - 输出格式: `0x{addr_int:04X}`

6. **自动格式修复** (`parser.py:164-218`):
   - 创建临时工作簿，逐单元格复制数据
   - 清理 BOM (`\ufeff`)、零宽空格 (`\u200b`)、不间断空格 (`\xa0`)
   - 修复后保存为临时 `.xlsx` 文件

### 后端 tRPC API 设计建议

```typescript
// tools.registerTableParser 子路由
{
  parse: mutation → { header, registers }                    // 解析 Excel 文件
  validateField: query → { isValid, errors }                 // 验证字段
}
```

### UI 设计要点

- 文件选择: 支持拖拽 + 文件选择对话框
- 左侧: 寄存器列表（树形，按偏移地址排序）
- 右侧: 选中寄存器的字段详情表（位域、名称、RW、复位值、描述）
- 底部: 表头信息展示（项目、子系统、模块、基地址）
- 交互: 点击字段可编辑值，实时计算二进制/十进制/十六进制

---

## 工具 5: reg2c

### Python 源码路径

```
d:/doc/python/runsim_r3p0/plugins/user/reg2c_plugin.py        ← 插件入口
d:/doc/python/runsim_r3p0/plugins/user/reg2c/
├── parser_engine.py          ← 解析引擎（核心逻辑）
├── reg_parser_gui.py         ← GUI 界面
└── templates/
    ├── c_macros.j2           ← C 宏定义模板（Jinja2）
    ├── c_struct.j2           ← C 结构体模板（Jinja2）
    └── c_functions.j2        ← C 函数模板（Jinja2）
```

### 功能概要

寄存器配置表格转 C 语言驱动头文件生成器：

1. **Excel 解析** (`parser_engine.py`): 使用 `pandas` + `openpyxl`/`xlrd` 读取 Excel
2. **自适应表头识别**: 遍历前 20 行，查找包含至少 4 个必要列名关键字的行作为表头
3. **列名清理**: 移除空格、下划线、斜杠，转小写
4. **列名映射**: 模糊匹配 `regname`、`offset`、`bit`、`fieldname`、`rw`、`resetvalue`、`description`
5. **数据提取**: 
   - 向前填充合并单元格（`regname`、`offset`、`width`、`description`）
   - 跳过 `reserved` 字段
   - 解析位域格式 `[30:0]` / `[0]`
6. **C 代码生成**: 使用 Jinja2 模板引擎生成 3 部分：
   - `c_macros.j2`: 宏定义（OFFSET、WIDTH、MASK、POS、READ/WRITE 宏）
   - `c_struct.j2`: 结构体定义（带 padding 对齐）
   - `c_functions.j2`: 寄存器访问函数（`_set` / `_get`）

### 核心数据结构

```typescript
type RegData = {
  moduleName: string;       // 模块名
  baseAddr: number;         // 基地址（整数）
  registers: Array<{
    offset: number;
    name: string;
    width: number;
    shortDesc: string;
    fields: Array<{
      bit: string;          // "30:0" 或 "0"
      bitStart: number;     // 高位
      bitEnd: number;       // 低位
      bitWidth: number;
      name: string;
      rw: string;           // "RW" | "RO" | "WO"
      reset: string;        // 复位值
      desc: string;
    }>;
  }>;
};
```

### 关键实现细节

1. **Excel 解析** (`parser_engine.py:120-371`):
   - `pandas.read_excel` 读取（支持 `.xls` 和 `.xlsx`）
   - 自适应表头行: 遍历前 20 行，匹配关键字 `['offset', 'regname', 'bit', 'fieldname', 'rw', 'resetvalue', 'description']`
   - 列名清理: `re.sub('[ _/]', '', str(col)).lower()`
   - 模糊列名映射: `if req_col in col.lower()`
   - 向前填充: `df['regname'].ffill()`, `df['offset'].ffill()`
   - 位域解析: `re.match(r'\[(\d+)(?::(\d+))?\]', bit_str)`
   - TypeScript 移植建议: 使用 `exceljs` 或 `xlsx` 包替代 pandas

2. **模板渲染** (`parser_engine.py:79-113`):
   - Jinja2 模板引擎
   - TypeScript 对应: 使用 `handlebars` 或 `eta` 或纯字符串模板
   - 模板路径: `templates/` 目录
   - 自定义过滤器: `c_escape`（C 语言转义）、`left_shift`（左移）

3. **C 宏模板** (`c_macros.j2`):
   - `#define MODULE_BASE_ADDR 0xXXXXXXXX`
   - `#define REG_OFFSET 0xXXXX`
   - 联合体定义: `typedef union { struct { ... } bits; uint32_t value; } REG_t;`
   - 位域宏: `WIDTH`、`MASK`、`POS`
   - 读写宏: `READ()`、`WRITE(value)`、`GET()`、`SET(value)`

4. **C 结构体模板** (`c_struct.j2`):
   - 带地址对齐的结构体定义
   - 自动插入 padding: `uint32_t PAD_0xXXXX[N];`
   - `volatile uint32_t REG_NAME; // 0xXXXX`

5. **C 函数模板** (`c_functions.j2`):
   - `static inline void REG_FIELD_set(uint32_t value)` — 写函数
   - `static inline uint32_t REG_FIELD_get()` — 读函数
   - 位操作: `(regs->REG & ~(MASK << POS)) | ((value & MASK) << POS)`

### 后端 tRPC API 设计建议

```typescript
// tools.reg2c 子路由
{
  parse: mutation → { moduleName, baseAddr, registers }     // 解析 Excel
  generate: mutation → { code: string }                      // 生成 C 代码
  preview: query → { macros, struct, functions }             // 预览三部分代码
}
```

### UI 设计要点

- 文件选择 + Excel 解析
- 解析结果表格预览（寄存器名、偏移、位域、字段名、RW、复位值）
- 代码预览区（三标签页: 宏定义 / 结构体 / 函数）
- 导出按钮: 保存为 `.h` 文件

---

## 工具 6: c-sv-converter

### Python 源码路径

```
d:/doc/python/runsim_r3p0/plugins/user/c_to_sv_converter_plugin.py  ← 插件入口
d:/doc/python/runsim_r3p0/plugins/user/c_to_sv_converter/
├── controllers/
│   ├── converter.py          ← 转换器核心逻辑（C→SV 和 SV→C）
│   ├── c_parser.py           ← C 代码解析器（正则表达式）
│   └── sv_parser.py          ← SV 代码解析器
├── models/
│   └── data_models.py        ← 数据模型
├── views/
│   ├── main_window.py        ← 主窗口
│   ├── preview_dialog.py     ← 预览对话框
│   └── syntax_highlighters.py ← 语法高亮
├── docs/                     ← 文档
├── tests/                    ← 测试用例（含示例 C/SV 文件）
└── config_template.json      ← 配置模板
```

### 功能概要

C 代码驱动函数 ↔ SystemVerilog Task 库双向转换工具：

1. **C → SV 转换**:
   - 解析 C 文件中的函数、结构体、宏定义、枚举
   - 分析函数依赖关系（哪些函数必须是 task，哪些可以是 function）
   - 生成 SV task/function、宏定义、寄存器偏移宏
   - 支持按驱动类型分组转换（`iic.c` → `iic_task_lib.sv`）

2. **SV → C 转换**:
   - 解析 SV 文件中的 task 和宏定义
   - 生成 C 函数和宏定义

3. **核心转换规则**:
   - `mmio_write_32(addr, data)` → `write_reg_by_addr(addr, data, core_name)`
   - `mmio_read_32(addr)` → `read_reg_by_addr(addr, var, core_name)`
   - `regs->member = value` → `write_reg_by_addr(base + \`MACRO, value, core_name)`
   - `value = regs->member` → `read_reg_by_addr(base + \`MACRO, value, core_name)`
   - `regs->member |= value` → 读-修改-写三步操作
   - `udelay(n)` → `#nus;`，`mdelay(n)` → `#nms;`
   - `0xNNNN` → `'hNNNN`
   - 全大写标识符自动加反引号（宏引用）

### 核心数据结构

```typescript
type ConversionDirection = 'c-to-sv' | 'sv-to-c';

type ConversionConfig = {
  inputFiles: string[];
  outputPath: string;
  direction: ConversionDirection;
  typeMappings: Record<string, string>;       // C类型 → SV类型
  functionMappings: Record<string, string>;   // 函数名映射
  preserveComments: boolean;
  addAutomatic: boolean;                       // task automatic 关键字
  coreNameDefault: string;                     // 默认 core_name
};

type FunctionParameter = {
  name: string;
  dataType: string;
  isPointer: boolean;
  isConst: boolean;
  direction: 'input' | 'output';
};

type FunctionInfo = {
  name: string;
  returnType: string;
  parameters: FunctionParameter[];
  body: string;
  comments: string[];
  isStatic: boolean;
  mustBeTask?: boolean;  // 依赖分析后设置
};

type StructInfo = {
  name: string;
  fields: Array<{ type: string; name: string }>;
  comments: string[];
};

type MacroInfo = {
  name: string;
  value: string;
  comments: string[];
};

type EnumInfo = {
  name: string;
  values: Array<{ name: string; value: string }>;
  comments: string[];
  rawText: string;
};

type ConversionResult = {
  success: boolean;
  outputFile: string;
  functionsConverted: number;
  errors: string[];
  warnings: string[];
  message: string;
};
```

### 关键实现细节

1. **C 代码解析** (`c_parser.py`):
   - 宏定义: `#define NAME value`（跳过 `#include`、`#ifndef` 等）
   - 枚举: `typedef enum { ... } NAME;`
   - 结构体: `typedef struct { ... } NAME;`
   - 函数: `(static)? TYPE NAME(PARAMS) { BODY }` — 使用 `_extract_balanced_braces` 提取函数体
   - 参数解析: 分割逗号，检测 `const`/`*`，判断方向（指针且非 const → output）
   - 注释提取: 向前查找紧邻的 `//` 或 `/* */` 注释

2. **函数依赖分析** (`converter.py:412-490`):
   - 第一步: 标记直接包含时间操作的函数（`mmio_read`/`mmio_write`/`->`/`udelay`/`mdelay`）
   - 第二步: 传播依赖（如果 A 调用 B，且 B 是 task，则 A 也必须是 task）
   - 迭代直到收敛（最多 10 次）
   - 查找调用: 正则 `\b(\w+)\s*\(`，排除 C 关键字

3. **C→SV 语句转换** (`converter.py:719-765`):
   - `return value` → function: `return value;` / task: `result = value;`
   - `return mmio_read_32(addr)` → `read_reg_by_addr(addr, result, core_name);`
   - `return reg->member` → 读寄存器 + 位操作
   - 变量声明: `uint32_t var = value` → `bit [31:0] var = value;`
   - `mmio_write_32(addr, data)` → `write_reg_by_addr(addr, data, core_name);`
   - `mmio_read_32(addr)` → `read_reg_by_addr(addr, var, core_name);`
   - `regs->member = value` → `write_reg_by_addr(base + \`MACRO, value, core_name);`
   - `value = regs->member` → `read_reg_by_addr(base + \`MACRO, value, core_name);`
   - `regs->member |= value` → 读-修改-写三步
   - `udelay(n)` → `#nus;`，`mdelay(n)` → `#nms;`
   - `0xNNNN` → `'hNNNN`
   - 全大写标识符自动加反引号

4. **SV 代码生成** (`converter.py:202-288`):
   - 文件头注释 + `ifndef/define` 保护
   - 枚举定义: `typedef enum { NAME = 'hVALUE, ... } NAME;`
   - 宏定义: `` `define NAME (32'hVALUE) ``，值为引用其他宏时自动加反引号
   - 结构体 → 寄存器偏移宏: `` `define STRUCT_FIELD (32'hOFFSET) ``
   - 函数 → task/function: `task automatic NAME(input ...); ... endtask`
   - 结构体指针参数 → `input bit [31:0] base`
   - 非 void 返回值的 task 增加 `output` 参数

5. **文件分组** (`converter.py:70-111`):
   - 按驱动名分组文件（`iic.c` + `iic.h` → `iic`）
   - 嵌套结构: `drivers/iic/iic.c` → 使用父目录名或文件名

### 默认类型映射

```typescript
const DEFAULT_TYPE_MAPPINGS = {
  'uint8_t': 'bit [7:0]',
  'uint16_t': 'bit [15:0]',
  'uint32_t': 'bit [31:0]',
  'uint64_t': 'bit [63:0]',
  'int8_t': 'bit signed [7:0]',
  'int16_t': 'bit signed [15:0]',
  'int32_t': 'bit signed [31:0]',
  'int64_t': 'bit signed [63:0]',
  'int': 'int',
  'char': 'byte',
  'bool': 'bit',
  'void': 'void',
  'float': 'real',
  'double': 'real',
};
```

### 后端 tRPC API 设计建议

```typescript
// tools.cSvConverter 子路由
{
  convert: mutation → { result: ConversionResult }           // 执行转换
  preview: query → { code: string }                           // 预览转换结果
  parseCFile: query → { functions, structs, macros, enums }   // 解析 C 文件
}
```

### UI 设计要点

- 文件选择: 支持多文件（`.c` + `.h`）
- 方向切换: C→SV / SV→C 单选
- 配置面板: 类型映射表（可编辑）、core_name 默认值、是否保留注释、是否添加 automatic
- 预览区: 语法高亮的 SV/C 代码预览
- 输出: 保存到文件或复制到剪贴板

---

## 工具 7: sv-ifdef-checker

### Python 源码路径

```
d:/doc/python/runsim_r3p0/plugins/user/sv_ifdef_checker_plugin.py  ← 插件入口
d:/doc/python/runsim_r3p0/plugins/user/sv_ifdef_checker/
├── models.py                 ← 数据模型 + 检查逻辑（核心）
├── controllers.py            ← 控制器（线程管理）
├── views.py                  ← 视图
└── main_window.py            ← 主窗口
```

### 功能概要

SystemVerilog 文件 `ifdef`/`ifndef`/`endif` 匹配检查器：

1. **文件检查** (`models.py:56-157`):
   - 逐行读取 SV 文件
   - 处理块注释（`/* */`）和行注释（`//`）
   - 使用栈数据结构匹配 `ifdef`/`ifndef` 和 `endif`
   - 检测同一行的 `ifdef...endif`（inline 匹配）
   - 记录未匹配的 `ifdef` 和多余的 `endif`

2. **目录扫描** (`models.py:159-191`):
   - 递归扫描目录下的 `.sv` 和 `.svi` 文件
   - 支持非递归模式

3. **批量检查**: 支持同时检查多个文件，实时进度报告

4. **统计汇总**: 总文件数、平衡文件数、不平衡文件数、错误文件数、各类指令总数

### 核心数据结构

```typescript
type CheckResult = {
  filePath: string;
  totalIfdef: number;
  totalIfndef: number;
  totalEndif: number;
  inlineMatches: number;
  unmatchedIfdef: Array<{
    type: 'ifdef' | 'ifndef';
    condition: string;
    line: number;
    content: string;
  }>;
  unmatchedEndif: Array<{
    line: number;
    content: string;
  }>;
  isBalanced: boolean;
  errorMessage: string | null;
};

type CheckSummary = {
  totalFiles: number;
  balancedFiles: number;
  unbalancedFiles: number;
  errorFiles: number;
  totalIfdef: number;
  totalIfndef: number;
  totalEndif: number;
  totalInline: number;
};
```

### 关键实现细节

1. **正则模式** (`models.py:51-54`):
   - `ifdef_pattern`: `` `(ifdef|ifndef)\s+(\w+) `` — 匹配 `` `ifdef MACRO `` 或 `` `ifndef MACRO ``
   - `endif_pattern`: `` `endif `` — 匹配 `` `endif ``
   - `inline_pattern`: `` `(ifdef|ifndef)\s+(\w+).*?`endif `` — 匹配同一行的 ifdef...endif

2. **检查逻辑** (`models.py:56-157`):
   - 初始化 `ifdef_stack = []`
   - 逐行处理:
     - 跳过块注释内容（`in_block_comment` 状态）
     - 移除行注释（`//` 之后内容）
     - 先检查 inline 匹配（同一行有 ifdef 和 endif）
     - 检查 `ifdef`/`ifndef`: 推入栈
     - 检查 `endif`: 弹出栈，如果栈空则记录多余的 endif
   - 最终: 栈中剩余的是未匹配的 ifdef

3. **目录扫描** (`models.py:159-191`):
   - `os.walk(directory)` 递归扫描
   - 过滤扩展名: `.sv`, `.svi`（可配置）
   - 返回排序后的文件列表

### 后端 tRPC API 设计建议

```typescript
// tools.svIfdefChecker 子路由
{
  scanDirectory: query → { files: string[] }                 // 扫描 SV 文件
  check: mutation → { results: CheckResult[], summary }      // 执行检查
}
```

### UI 设计要点

- 路径选择: 文件或目录（单选按钮切换）
- 选项: 递归扫描、包含 .svi 文件
- 检查按钮 + 进度条
- 结果表格: 文件名、状态（✅/❌）、ifdef 数、ifndef 数、endif 数、inline 数
- 详情面板: 选中文件的未匹配 ifdef/endif 列表（行号 + 内容）
- 汇总信息: 总文件数、平衡/不平衡/错误文件数

---

## 11. 验证检查清单

完成每个工具后，必须依次执行以下命令，全部通过才算完成：

```sh
npm run build        # 1. 确认编译成功（main + preload + renderer 三进程构建）
npm run typecheck    # 2. 确认类型检查通过
npm run test         # 3. 确认测试通过
```

### 每个工具的检查项

- [ ] 后端逻辑文件 `src/main/tools/<tool-id>.ts` 已创建
- [ ] tRPC 子路由已添加到 `tools-router.ts`
- [ ] 前端组件 `src/renderer/src/tools/<tool-id>/<ToolName>.tsx` 已创建
- [ ] `registry.tsx` 中 `ToolPlaceholder` 已替换为实际组件
- [ ] `npm run build` 通过
- [ ] `npm run typecheck` 通过
- [ ] `npm run test` 通过

### 推荐实现顺序

按复杂度从低到高：

1. **sv-ifdef-checker** (★★) — 纯文本解析，无外部依赖
2. **git-quick-pull** (★★) — 简单扫描 + 子进程执行
3. **register-table-parser** (★★★) — Excel 解析 + 数据展示
4. **reg2c** (★★★) — Excel 解析 + 模板生成
5. **git-diff** (★★★★) — Git 操作 + diff 计算 + 复杂 UI
6. **git-manager** (★★★★★) — 多仓库管理 + 标签系统 + 批量操作
7. **c-sv-converter** (★★★★★) — C 代码解析 + 复杂转换规则 + 双向转换

---

## 附录: 已有工具的实现参考

以下是已完成工具的文件结构，可作为实现参考：

```
src/main/tools/
├── env-checker.ts          ← 文件扫描 + 正则匹配
├── code-line-counter.ts    ← 文件遍历 + 行数统计
├── find-replace.ts         ← 文件搜索 + 替换 + 撤销
├── system-monitor.ts       ← 系统指标（CPU/内存/磁盘）
├── log-analyzer.ts         ← 日志解析（xrun/VCS 格式）
├── time-analyzer.ts        ← 仿真时间解析
├── coverage-merger.ts      ← 覆盖率合并命令构建 + 执行
├── batch-execution.ts      ← 批量执行 + 并行控制
├── regression-analyzer.ts  ← 回归结果扫描 + 时间解析 + 聚合
├── regression-list-gen.ts  ← 命令构建 + 执行 + 历史
└── tool-window-manager.ts  ← 工具窗口管理（单例模式）
```

每个后端文件导出核心函数和类型，在 `tools-router.ts` 中通过 tRPC 子路由暴露给前端。
