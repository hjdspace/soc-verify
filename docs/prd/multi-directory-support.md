# PRD: 多目录支持

## Problem Statement

SoC 验证环境通常由多个独立目录组成——子系统 RTL 目录、SoC 验证环境目录、IP2SOC 验证目录等。当前 SoC Verify 桌面平台只支持导入单个项目目录，无法将多个相关目录纳入同一工作集。用户被迫在多个项目间来回切换，或在一个项目中通过绝对路径手动引用其他目录的文件，AI Agent 也无法感知这些额外目录的存在。

## Solution

在 Project 下新增「额外目录」（Extra Directory）子实体，允许用户将多个文件系统目录挂接到同一项目。目录按固定两类分组组织：验证分组（验证环境目录）和设计分组（设计目录）。侧边栏文件树改为 VS Code 多根工作区风格——扁平结构，所有目录的文件树并列显示并用分组标题分隔。AI Agent session 的 cwd 可由用户在已添加目录中切换，其他目录通过 system prompt 自动告知 AI。

## User Stories

### 目录管理

1. 作为 SoC 验证工程师，我希望能在一个项目下添加多个验证环境目录，以便将 SoC 验证环境和 IP2SOC 验证环境统一管理
2. 作为 SoC 验证工程师，我希望能在一个项目下添加多个设计目录（如子系统 RTL、SoC RTL），以便 AI Agent 能直接读取设计文件
3. 作为 SoC 验证工程师，我希望能为每个添加的目录设置自定义标签（如「IP2SOC」「SoC RTL」），以便在侧边栏中快速识别
4. 作为 SoC 验证工程师，我希望能移除已添加的额外目录，以便清理不再需要的目录
5. 作为 SoC 验证工程师，我希望移除目录时有确认提示，以防误操作
6. 作为 SoC 验证工程师，我希望能通过分组标题行的「+」按钮添加目录到指定分组
7. 作为 SoC 验证工程师，我希望能通过拖拽文件夹到侧边栏来添加目录，以便快速操作
8. 作为 SoC 验证工程师，我希望初始导入项目时选择的目录自动归入验证分组并设为 cwd，无需额外配置

### 文件树浏览

9. 作为 SoC 验证工程师，我希望侧边栏文件树以分组标题分隔并列展示所有目录的文件树，以便一览全局文件结构
10. 作为 SoC 验证工程师，我希望能展开/折叠每个目录的文件树，交互方式与当前一致
11. 作为 SoC 验证工程师，我希望在文件树中右键目录节点时能看到「设为工作目录」选项
12. 作为 SoC 验证工程师，我希望当前 cwd 目录在文件树中有明显的可视化标记（如加粗或星标）
13. 作为 SoC 验证工程师，我希望刷新按钮仍能刷新当前所有目录的文件树

### AI Agent 工作目录

14. 作为 SoC 验证工程师，我希望能将任意已添加目录设为 AI Agent 的工作目录（cwd），以便针对不同工作阶段切换工作上下文
15. 作为 SoC 验证工程师，我希望切换 cwd 后当前活跃 AI session 自动重建，以使新的 cwd 生效
16. 作为 SoC 验证工程师，我希望切换 cwd 不影响后台运行的 AI session（如错误分析、覆盖率闭环），以免丢失它们的运行时状态
17. 作为 SoC 验证工程师，我希望 AI Agent 的 system prompt 自动列出所有目录的路径和分组归属，以便 AI 知道有哪些目录可访问
18. 作为 SoC 验证工程师，我希望非 cwd 目录的文件能通过绝对路径正常读取和编辑

### 文件操作

19. 作为 SoC 验证工程师，我希望在任意已添加目录内读写文件时不受安全限制阻碍
20. 作为 SoC 验证工程师，我希望在目录外路径操作文件时仍被安全检查拦截，以防意外修改项目外文件

### 向后兼容

21. 作为已有项目的用户，我希望升级后打开旧项目时能无感迁移——rootPath 自动作为验证组第一项和 cwd，不显示迁移向导
22. 作为已有项目的用户，我希望旧项目的插件、知识库、session 等功能在升级后仍正常工作

## Implementation Decisions

### 数据模型

- **Project 概念不变**：保留 `ProjectInfo` 和 `rootPath` 语义，不升级为 Workspace 概念。`rootPath` 仍是项目打开时的主目录。
- **新增 ExtraDirEntry 子实体**：`ProjectInfo` 增加 `extraDirs?: ExtraDirEntry[]` 字段。`rootPath` 不存入 `extraDirs`（隐式属于验证分组的第一项 = 默认 cwd），`extraDirs` 只存储用户后续添加的目录。
- **ExtraDirEntry 结构**（来自 ADR 0027 设计原型）：
  ```ts
  type DirGroup = 'verify' | 'design';
  interface ExtraDirEntry {
    id: string;           // 如 'dir_<timestamp>_<random>'
    path: string;         // 绝对路径
    group: DirGroup;      // 分组
    label?: string;       // 用户自定义标签
    isCwd: boolean;       // 是否为当前工作目录
    order: number;        // 组内排序
    createdAt: number;
  }
  ```
- **持久化**：`extraDirs` 与 `rootPath` 一起存入现有 `projects.json`，不新建表或文件。
- **固定两类分组**：`verify` 和 `design`，不引入自定义分组。

### omp 引擎能力

- omp CLI 只有 `--cwd`（单一工作目录），没有 `--add-dir` 或类似多目录参数。
- omp 的文件工具不强制沙箱——绝对路径不会被拒绝。
- 多目录通过「cwd + 绝对路径 + system prompt 告知」实现。

### AI session

- session 创建时 cwd 仍取自 project 的已添加目录（默认 rootPath，可由用户切换）。
- system prompt 自动构造目录说明追加到 `InitConfig.systemPrompt`（用户自定义 systemPrompt 拼接在后面）。
- 切换 cwd 触发当前活跃 session 重建（destroy + create），不影响后台 session。
- 插件仍基于 rootPath 加载，不扩展到其他目录。

### 文件树

- 缓存 key 从 `projectId` 改为 `${projectId}:${dirId}`，每个目录独立懒加载、独立 watch、独立刷新。
- `getFileTree` 保留原行为（返回 rootPath 的树），新增 `getDirFileTree(projectId, dirId)` 返回额外目录的树。
- `getDirChildren` 增加 `dirId` 参数，支持按额外目录查询子项。
- `FileTree` 组件不变，`LeftRail` 的 files tab 内容区循环渲染多个 FileTree 实例，每个实例前面带分组标题行和「+」按钮。

### 安全检查

- `ProjectManager.readFile/writeFile` 的路径安全检查从「在 rootPath 内」改为「在任意已添加目录内」即允许。

### tRPC API

新增 procedures：
- `project.addDir` — `{ projectId, path, group, label? }` → `ExtraDirEntry`
- `project.removeDir` — `{ projectId, dirId }` → `void`
- `project.setCwd` — `{ projectId, dirId }` → `void`（触发 session 重建）
- `project.updateDirLabel` — `{ projectId, dirId, label }` → `void`
- `project.getExtraDirs` — `{ projectId }` → `ExtraDirEntry[]`
- `project.getDirFileTree` — `{ projectId, dirId }` → `FileTreeNode`

修改 procedures：
- `project.getDirChildren` — 增加 `dirId` 参数

### 向后兼容

- 旧项目（`extraDirs` 为空或不存在）打开时自动迁移：rootPath 隐式作为验证组第一项和 cwd。无感升级，无迁移向导。

### UI 交互

- 侧边栏保留项目切换栏（上层概念），项目内新增目录操作（下层概念）。
- 分组标题行带「+」按钮和拖拽支持。
- 目录根节点右键菜单增加「设为工作目录」和「移除目录」选项。
- 当前 cwd 目录节点显示可视化标记。
- 移除 cwd 目录时自动回退到验证组第一个剩余目录。
- 移除时有未审阅文件改动的目录提示用户。

## Testing Decisions

### 测试理念

只测外部行为，不测实现细节。优先复用现有 seam，不引入新测试目录。三个层各一个 seam。

### 测试 seam

1. **数据层** — `tests/project/multi-dir.test.ts`（新建）
   - 先例：`tests/project/gitignore.test.ts`（真实 fs 操作 + mock electron）
   - 测 ProjectManager 的 addDir/removeDir/setCwd/getExtraDirs 外部行为：目录添加后持久化、移除后消失、cwd 切换后 isCwd 标记更新、安全检查允许任意已添加目录内文件操作且拒绝目录外操作、旧项目自动迁移
   - 不测内部 Map 结构或缓存实现

2. **AI 层** — `tests/agent/multi-dir-system-prompt.test.ts`（新建）
   - 先例：`tests/agent/openai-compatible-session.test.ts`（测 session 构造逻辑）
   - 测 session-manager 构造的 InitConfig 中 systemPrompt 是否包含所有目录路径和分组信息、cwd 标记是否正确
   - 不测 omp 子进程通信

3. **UI 层** — `tests/ui/LeftRail.test.tsx`（扩展）
   - 先例：已有 LeftRail 测试（mock store + mock FileTree）
   - 测多分组渲染（验证/设计标题行出现）、多 FileTree 实例渲染、添加目录按钮存在、右键菜单「设为工作目录」和「移除目录」选项存在
   - 不测 FileTree 组件内部行为（已有测试覆盖）

### 验证检查

增量验证（按 AGENTS.md）：
```sh
npm run typecheck                 # 类型检查
npm run lint                      # ESLint
npx vitest run tests/project/     # 数据层改动
npx vitest run tests/agent/       # AI 层改动
npx vitest run tests/ui/LeftRail.test.tsx  # UI 层改动
```

## Out of Scope

- 自定义分组名称和数量（固定 verify/design 两类）
- 目录间拖拽排序（order 字段预留但 UI 不做拖拽排序）
- 批量导入多个目录（一次只能添加一个）
- 目录的 git 状态独立展示（沿用当前 git-ignore 标记机制）
- 多项目间目录共享（目录属于特定 Project）
- 插件扫描扩展到设计目录（仍基于 rootPath）
- 自定义分组颜色或图标
- 目录级别的权限控制

## Further Notes

- 详细架构决策见 `docs/adr/0027-multi-directory-support.md`
- 术语定义见 `CONTEXT.md` 的「多目录域」部分
- 实现顺序：Phase 1 数据模型层 → Phase 2 AI 层 → Phase 3 UI 层
- omp 引擎源码（`engine/oh-my-pi/`）是 git submodule，不修改其源码
