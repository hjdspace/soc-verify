# Issue: 侧边栏目录交互——添加按钮、拖拽、右键菜单、cwd 标记

## Parent

PRD: `docs/prd/multi-directory-support.md`

## What to build

实现用户与多目录的完整交互：通过「+」按钮和拖拽添加目录、通过右键菜单设为工作目录和移除目录、当前 cwd 可视化标记。

端到端行为：
- 用户点击分组标题行的「+」按钮 → 弹出系统文件夹选择对话框 → 选择后目录添加到对应分组
- 用户拖拽文件夹到侧边栏 → 目录自动归入对应分组（拖到验证区域→verify 组，拖到设计区域→design 组）
- 用户右键目录根节点 → 菜单出现「设为工作目录」和「移除目录」选项
- 当前 cwd 目录在文件树中显示可视化标记（加粗或星标）
- 移除 cwd 目录时自动回退到验证组第一个剩余目录
- 移除目录时如果该目录下有 AI 创建的未审阅文件改动（Review Queue 中有该目录路径下的条目），弹出提示让用户确认

## Acceptance criteria

- [ ] 分组标题行「+」按钮点击后弹出 Electron 文件夹选择对话框，选择后调用 `project.addDir`
- [ ] 拖拽文件夹到侧边栏验证区域自动归入 verify 组，拖到设计区域归入 design 组
- [ ] 目录根节点右键菜单包含「设为工作目录」选项（调用 `project.setCwd`）
- [ ] 目录根节点右键菜单包含「移除目录」选项（调用 `project.removeDir`），有确认提示
- [ ] 当前 cwd 目录节点显示可视化标记（加粗 + 星标图标）
- [ ] 移除 cwd 目录时自动回退到验证组第一个剩余目录（rootPath 或 extraDirs 中 verify 组第一个）
- [ ] 移除目录时检查 Review Queue 中是否有该目录路径下的未审阅改动，有则弹出提示
- [ ] `tests/ui/LeftRail.test.tsx` 扩展覆盖：分组标题行「+」按钮存在、右键菜单选项存在、cwd 标记渲染
- [ ] `npm run typecheck` 和 `npm run lint` 通过
- [ ] `npx vitest run tests/ui/LeftRail.test.tsx` 通过

## Blocked by

- `docs/issues/multi-dir-slice-2-filetree-ai-cwd.md`（需要多分组多 FileTree 渲染和 setCwd session 重建）
