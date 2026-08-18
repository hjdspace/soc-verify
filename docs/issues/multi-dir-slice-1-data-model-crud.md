# Issue: 项目多目录数据模型与目录增删改 API

## Parent

PRD: `docs/prd/multi-directory-support.md`

## What to build

为 Project 新增「额外目录」（Extra Directory）子实体，支持用户将多个文件系统目录挂接到同一项目。目录按固定两类分组（`verify` / `design`）组织。

端到端行为：
- 用户打开一个已有项目，项目数据结构中新增 `extraDirs` 字段（可选，旧项目为空时自动迁移——rootPath 隐式作为验证组第一项和 cwd）
- 通过 tRPC API 可以向项目添加目录（指定路径、分组、可选标签）、移除目录、设置某个目录为 cwd、更新目录标签、查询额外目录列表
- 文件读写安全检查从「在 rootPath 内」改为「在任意已添加目录内」即允许
- 所有目录变更持久化到 `projects.json`

数据结构（来自 ADR 0027 原型）：
```ts
type DirGroup = 'verify' | 'design';
interface ExtraDirEntry {
  id: string;
  path: string;
  group: DirGroup;
  label?: string;
  isCwd: boolean;
  order: number;
  createdAt: number;
}
```
`ProjectInfo` 增加 `extraDirs?: ExtraDirEntry[]`。`rootPath` 不存入 `extraDirs`（隐式属于验证分组的第一项 = 默认 cwd）。

## Acceptance criteria

- [ ] `ProjectInfo` 类型增加 `extraDirs?: ExtraDirEntry[]` 字段，类型检查通过
- [ ] `ProjectManager` 实现 `addDir(projectId, path, group, label?)` → 返回 `ExtraDirEntry`
- [ ] `ProjectManager` 实现 `removeDir(projectId, dirId)` — 移除 cwd 目录时自动回退到验证组第一个剩余目录
- [ ] `ProjectManager` 实现 `setCwd(projectId, dirId)` — 更新 isCwd 标记
- [ ] `ProjectManager` 实现 `updateDirLabel(projectId, dirId, label)` 
- [ ] `ProjectManager` 实现 `getExtraDirs(projectId)` → 返回 `ExtraDirEntry[]`
- [ ] `readFile/writeFile` 安全检查改为「在任意已添加目录内」即允许，拒绝目录外路径
- [ ] 目录变更后 `projects.json` 正确持久化（含 extraDirs）
- [ ] 旧项目（extraDirs 为空/不存在）打开时自动迁移，rootPath 隐式作为验证组第一项和 cwd
- [ ] tRPC router 新增 `project.addDir`、`project.removeDir`、`project.setCwd`、`project.updateDirLabel`、`project.getExtraDirs` procedures
- [ ] `tests/project/multi-dir.test.ts` 覆盖：addDir 后持久化、removeDir 后消失、setCwd 标记更新、安全检查允许/拒绝、旧项目自动迁移
- [ ] `npm run typecheck` 和 `npm run lint` 通过
- [ ] `npx vitest run tests/project/multi-dir.test.ts` 通过

## Blocked by

None - can start immediately
