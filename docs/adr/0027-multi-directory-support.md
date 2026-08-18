# 0027 — 多目录支持：Project 不变 + 目录子实体

SoC 验证环境通常由多个独立目录组成——子系统 RTL 目录、SoC 验证环境目录、IP2SOC 验证目录等。此前平台只支持单项目目录导入，无法覆盖多目录工作场景。本 ADR 记录多目录改造的架构决策。

## 调查结论：omp 引擎能力

omp CLI（`engine/oh-my-pi/packages/coding-agent/src/cli/`）的 flag 表（`flag-tables.ts`）和参数解析器（`args.ts`）中**没有** `--add-dir` 或类似的多目录参数。omp 通过 `--cwd` 设置单一工作目录，所有路径工具（read/write/grep/glob）基于此 cwd 解析相对路径。

但 omp 的文件工具**不强制沙箱**——绝对路径不会被拒绝。因此"多目录"可通过以下方式实现：cwd 设置为验证组第一个目录，其他目录通过 system prompt 告知 AI 路径，AI 使用绝对路径访问。

## 关键决策

### 1. Project 概念不变 + 新增目录子实体

**选择**：保留 `ProjectInfo` 和 `rootPath` 语义不变，新增 `ExtraDirEntry` 子实体挂属于 Project。

**理由**：
- 现有的 `ProjectManager`、`sessionManager.createSession`、插件加载、知识库挂载等都基于 `project.rootPath`，改动面巨大。
- 方案 C 最小破坏性，向后兼容。
- 分组是目录的属性（`group: 'verify'|'design'`），逻辑清晰且可扩展。

**被拒绝方案**：
- **方案 A（Project 直接加目录列表字段）**：分组逻辑混入扁平数组，不如子实体清晰。
- **方案 B（升级为 Workspace 概念）**：概念迁移成本高，现有代码全部需要改名，收益不明确。

### 2. 固定两类分组（验证 / 设计）

**选择**：固定 `verify` 和 `design` 两类分组，不引入自定义分组。

**理由**：
- SoC 验证场景的目录角色天然二分——验证环境 vs 设计 RTL。
- 自定义分组增加 UI 复杂度（分组管理、排序、嵌套），与桌面应用的单用户场景不匹配。
- 每个目录有可选 `label`（如「IP2SOC」「SoC RTL」），满足细分类需求。

### 3. cwd 可配置为任意已添加目录

**选择**：用户可通过右键菜单「设为工作目录」将任意已添加目录设为 cwd，默认为 rootPath。

**理由**：
- 不同工作阶段可能需要不同的 cwd（如调试时以验证环境为 cwd，覆盖率分析时以覆盖率工作区为 cwd）。
- omp 的 cwd 在进程启动时固定，切换 cwd 需要重建 session。这是 omp 的硬约束，无法绕过。

**被拒绝方案**：
- **自动选验证组第一个目录**：不够灵活，用户可能需要以设计目录为 cwd 运行某些分析。
- **自动找公共父目录**：多目录可能无公共父（如 `D:\proj\verify` 和 `E:\rtl`），且公共父可能过大。

### 4. 扁平多根文件树（VS Code 多根工作区风格）

**选择**：侧边栏文件树采用扁平结构——所有目录的 FileTree 并列显示，用分组标题行分隔。

**理由**：
- VS Code 多根工作区是成熟范式，用户认知成本低。
- 两级结构（分组→目录→文件）嵌套太深，文件节点在侧边栏空间有限时更难展示。
- FileTree 组件不变，LeftRail 循环渲染多个实例，实现成本最低。

### 5. 安全检查改为「任意已添加目录内」即允许

**选择**：`ProjectManager.readFile/writeFile` 的路径安全检查从「在 rootPath 内」改为「在任意已添加目录内」。

**理由**：
- 多目录场景下，AI 和用户都需要在多个目录中读写文件。
- 保持 rootPath-only 检查会导致其他目录的文件操作被拒绝，体验差。
- 桌面单用户应用，去掉安全检查过于宽松；任意已添加目录是合理的中间地带。

### 6. 插件仍基于 rootPath 加载

**选择**：插件扫描（CaseParser、SubsysDiscovery 等）仍基于 `rootPath`，不扩展到其他目录。

**理由**：
- 验证环境目录是主工作目录，插件扫描的是验证相关文件（case 配置、回归列表等）。
- 设计目录（RTL）主要是给 AI 读取参考，不需要插件扫描。
- 未来如需扩展，可给插件增加 `extraScanDirs` 参数。

### 7. session 重建仅限当前活跃 session

**选择**：切换 cwd 时只重建用户创建的当前活跃会话 Tab，不影响后台 session（错误分析、覆盖率闭环等）。

**理由**：
- 后台 session 通常绑定特定工作目录和上下文，强行重建会丢失运行时状态。
- 用户主动创建的会话 Tab 才受 cwd 切换影响。

## 数据模型

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

// ProjectInfo 增加 extraDirs 字段
interface ProjectInfo {
  id: string;
  name: string;
  rootPath: string;          // 隐式属于验证分组的第一项 = 默认 cwd
  extraDirs?: ExtraDirEntry[]; // 用户后续添加的目录
  createdAt: number;
  lastOpenedAt: number;
}
```

## AI system prompt 注入

session 创建时，如果项目有 `extraDirs`，自动构造目录说明追加到 systemPrompt：

```
本项目的文件分布在以下目录中：
验证环境目录：
  - /path/to/verify1（当前工作目录）
  - /path/to/verify2
设计目录：
  - /path/to/rtl1
  - /path/to/rtl2
当前工作目录是 /path/to/verify1，其他目录请使用绝对路径访问。
```

## tRPC API 变更

新增 procedures：
- `project.addDir` — `{ projectId, path, group, label? }` → `ExtraDirEntry`
- `project.removeDir` — `{ projectId, dirId }` → `void`
- `project.setCwd` — `{ projectId, dirId }` → `void`（触发 session 重建）
- `project.updateDirLabel` — `{ projectId, dirId, label }` → `void`
- `project.getExtraDirs` — `{ projectId }` → `ExtraDirEntry[]`
- `project.getDirFileTree` — `{ projectId, dirId }` → `FileTreeNode`

修改 procedures：
- `project.getDirChildren` — 增加 `dirId` 参数，支持按额外目录查询子项

## 实现顺序

1. **Phase 1 — 数据模型层**：修改 `ProjectInfo` 类型、`ProjectManager` 多目录操作、安全检查、tRPC procedures、测试
2. **Phase 2 — AI 层**：修改 `session-manager.ts` system prompt 注入、cwd 切换重建、测试
3. **Phase 3 — UI 层**：修改 `LeftRail` 多分组多 FileTree 渲染、添加/移除目录交互、project store、测试

## 向后兼容

已有用户打开的旧项目（`extraDirs` 为空或不存在）在升级后自动迁移：打开项目时 `extraDirs` 为空则 rootPath 隐式作为验证组第一项和 cwd，用户可继续添加目录。无感升级，无迁移向导。
