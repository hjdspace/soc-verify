# Issue: 额外目录文件树加载与 AI system prompt 注入及 cwd 切换

## Parent

PRD: `docs/prd/multi-directory-support.md`

## What to build

实现额外目录的文件树懒加载（多根工作区风格），以及 AI Agent session 的多目录感知和 cwd 切换重建。

端到端行为：
- 侧边栏 files tab 以分组标题分隔并列展示所有目录的文件树（VS Code 多根工作区风格）
- 每个额外目录的文件树独立懒加载（首次展开时加载子目录）和独立文件监听
- 刷新按钮刷新所有目录的文件树
- AI session 创建时，如果项目有 extraDirs，system prompt 自动追加一段目录说明（列出所有目录路径、分组归属、cwd 标记），告知 AI 其他目录请使用绝对路径访问
- 用户通过 tRPC `project.setCwd` 切换 cwd 后，当前活跃 AI session 自动重建（destroy + create），后台 session（错误分析、覆盖率闭环等）不受影响

文件树缓存 key 从 `projectId` 改为 `${projectId}:${dirId}`。`getDirChildren` 增加 `dirId` 参数。新增 `project.getDirFileTree(projectId, dirId)` procedure。`FileTree` 组件不变，`LeftRail` 循环渲染多个 FileTree 实例。

## Acceptance criteria

- [ ] `ProjectManager` 文件树缓存 key 改为 `${projectId}:${dirId}`，每个目录独立缓存
- [ ] 每个额外目录独立启动 `fs.watch`（recursive），独立 debounce 刷新
- [ ] 新增 tRPC `project.getDirFileTree(projectId, dirId)` → `FileTreeNode`
- [ ] tRPC `project.getDirChildren` 增加 `dirId` 参数
- [ ] project store 加载并存储多目录文件树状态（以 dirId 为 key）
- [ ] `LeftRail` files tab 循环渲染所有目录的 FileTree 实例，分组标题行分隔（「验证」「设计」）
- [ ] 每个分组标题行带「+」按钮（功能在 Slice 3 实现，此处预留 UI 占位）
- [ ] `session-manager.ts` 构造 `InitConfig` 时，如有 extraDirs，自动构造目录说明追加到 systemPrompt
- [ ] system prompt 格式包含：验证目录列表、设计目录列表、cwd 标记、使用绝对路径提示
- [ ] tRPC `project.setCwd` 触发当前活跃 session 重建（destroy + create），后台 session 不受影响
- [ ] `tests/agent/multi-dir-system-prompt.test.ts` 覆盖：system prompt 包含所有目录路径、分组、cwd 标记
- [ ] `tests/ui/LeftRail.test.tsx` 扩展覆盖：多分组标题行渲染、多 FileTree 实例渲染
- [ ] `npm run typecheck` 和 `npm run lint` 通过
- [ ] `npx vitest run tests/agent/multi-dir-system-prompt.test.ts tests/ui/LeftRail.test.tsx` 通过

## Blocked by

- `docs/issues/multi-dir-slice-1-data-model-crud.md`（需要 ExtraDirEntry 类型和 ProjectManager 多目录操作）
