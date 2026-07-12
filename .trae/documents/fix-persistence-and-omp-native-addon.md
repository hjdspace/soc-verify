# 修复：项目持久化丢失 + omp native addon 加载失败

## Context

SoC Verify 桌面程序存在两个阻塞性 bug：

1. **持久化丢失**：用户打开项目目录 → 关闭应用 → 重启，上一次打开的项目从左栏消失。
   - 根因：`src/main/index.ts:133-156` 的 `app.whenReady()` 回调只调用了 `projectManager.ensureDataDir()`，**没有调用** `loadProjectsDb()` 把已保存的 `projects.json` 加载回内存。退出时 `before-quit` 钩子虽然调用了 `saveProjectsDb()`，但启动时从未读取，导致持久化数据形同虚设。
   - 前端 `src/renderer/src/stores/project.ts:192-210` 的 `restoreState` 已正确调用 `trpc.project.list.query()`，但 `project.list` procedure（`router.ts:164-166`）只返回 `projectManager.listProjects()` 内存数据，启动时内存为空。

2. **会话创建失败**：`pi_natives.win32-x64-baseline.node` 文件缺失。
   - 根因：`engine/oh-my-pi/packages/natives/native/` 目录下没有任何 `.node` 二进制；本地构建受阻——`engine/oh-my-pi/rust-toolchain.toml` 指定 `nightly-2026-04-29`，但该 nightly 已被 Rust 官方撤回（`error: no release found for 'nightly-2026-04-29'`）。
   - 解决方案：用户已选择下载 GitHub release v16.4.0 的 `omp-windows-x64.exe`（155MB，Bun 编译的 omp 完整二进制，pi_natives 已内嵌），让 SoC Verify 优先用预编译二进制启动 omp，绕开 native addon 构建问题。

用户已确认：① 持久化采用"冷恢复"（启动时只恢复 ProjectInfo 元数据到内存，不自动启 chokidar watcher；用户点击项目时再懒启动 watcher）。

---

## 修改清单

### A. 持久化冷恢复（2 个文件）

#### A1. [src/main/project/project-manager.ts](file:///d:/AI/soc-verify/src/main/project/project-manager.ts)

**新增方法** `restorePersistedProjects()`（位于 `loadProjectsDb()` 之后，约 L330）：

```ts
async restorePersistedProjects(): Promise<number> {
  const persisted = await this.loadProjectsDb();
  for (const info of persisted) {
    if (this.projects.has(info.id)) continue;          // 已在内存跳过
    if (!existsSync(info.rootPath)) continue;          // 项目目录已删除/移动，跳过
    this.projects.set(info.id, { info, watcher: null }); // 冷恢复：watcher 留空
  }
  return persisted.length;
}
```

**修复** `openProject()` 的早返回路径（L72-78）：当前对已打开项目只更新 `lastOpenedAt` 后早返回，但冷恢复的项目 `watcher === null` 永远不会启动 watcher。改为：

```ts
for (const [, entry] of this.projects) {
  if (entry.info.rootPath === rootPath) {
    entry.info.lastOpenedAt = Date.now();
    if (!entry.watcher) {
      entry.watcher = this.startFileWatcher(entry.info.id, rootPath); // 懒启动
    }
    await this.saveProjectsDb();
    return entry.info;
  }
}
```

`getFileTree()` (L139-149) 已不依赖 watcher，冷恢复项目可直接读树。`closeProject()` (L104-115) 已用 `if (entry.watcher)` 守卫，watcher=null 安全。

#### A2. [src/main/index.ts](file:///d:/AI/soc-verify/src/main/index.ts)

在 `app.whenReady()` 中 `ensureDataDir()` 之后（L134 之后）增加一行：

```ts
await projectManager.ensureDataDir();
const restoredCount = await projectManager.restorePersistedProjects();
if (restoredCount > 0) {
  console.log(`[project] restored ${restoredCount} project(s) from disk`);
}
```

### B. omp 预编译二进制集成（4 个文件 + 1 个二进制下载）

#### B1. 下载 omp 二进制

```
URL: https://github.com/can1357/oh-my-pi/releases/download/v16.4.0/omp-windows-x64.exe
目标路径: d:/AI/soc-verify/resources/binaries/omp.exe
```

`resources/binaries/` 目录已存在（含 README.md），`electron-builder.yml:9-12` 已配置 `extraResources: resources/binaries → binaries`，无需修改打包配置。

#### B2. [src/main/omp/paths.ts](file:///d:/AI/soc-verify/src/main/omp/paths.ts)

**修改 `resolveOmpBinaryPath()`（L63-65）**：当前只查 `packagedBinariesDir()`（即 `process.resourcesPath/binaries/`），dev 模式下 `process.resourcesPath` 为空字符串失效。新增 dev 模式候选路径：

```ts
export function resolveOmpBinaryPath(): string | null {
  // 1. packaged 模式：resources/binaries → process.resourcesPath/binaries
  const packaged = findInDir(packagedBinariesDir(), 'omp');
  if (packaged) return packaged;
  // 2. dev 模式：从 out/main/index.cjs 反推到项目根 resources/binaries/
  //    __dirname = out/main/ → ../ = out/ → ../../ = 项目根 → resources/binaries/
  //    findInDir 内部 candidateNames() 已处理 win32 的 .exe/.cmd 后缀，传 'omp' 即可
  const devCandidate = resolve(__dirname, '../../resources/binaries');
  return findInDir(devCandidate, 'omp');
}
```

路径算术核对：`paths.ts:46-48` 现有 `resolve(__dirname, '../../', OMP_ENTRY_REL)` 已使用 2 层 `..`，到达项目根（`out/main/` → `out/` → 项目根），新增的 dev 候选路径与之对齐。`findInDir()` 通过 `candidateNames('omp')` 在 win32 下自动尝试 `omp.exe` / `omp` / `omp.cmd` 三种文件名，无需手动判断平台。

**修改 `OmpRuntime` 接口（L84-89）**：让 `bunPath`/`ompEntryPath` 可选，新增 `ompBinaryPath`：

```ts
export interface OmpRuntime {
  ompBinaryPath?: string;   // 优先使用：预编译 omp 二进制路径
  bunPath?: string;         // 回退：bun 可执行文件路径
  ompEntryPath?: string;    // 回退：omp 源码入口路径
  bunVersion: string;
  bunVersionOk: boolean;
}
```

**修改 `resolveOmpRuntime()`（L92-104）**：优先解析二进制，找到则直接返回；找不到才回退到 source 模式：

```ts
export function resolveOmpRuntime(): OmpRuntime | null {
  const ompBinaryPath = resolveOmpBinaryPath();
  if (ompBinaryPath) {
    return { ompBinaryPath, bunVersion: 'bundled', bunVersionOk: true };
  }
  // 回退：源码模式（需要 bun + engine/oh-my-pi）
  const ompEntryPath = resolveOmpEntryPath();
  if (!ompEntryPath) return null;
  const bunPath = resolveBunPath();
  if (!bunPath) return null;
  const versionCheck = checkBunVersion(bunPath);
  return {
    bunPath,
    ompEntryPath,
    bunVersion: versionCheck.version,
    bunVersionOk: versionCheck.ok,
  };
}
```

#### B3. [src/main/omp/types.ts](file:///d:/AI/soc-verify/src/main/omp/types.ts)

修改 `OmpRpcClientOptions`（L262-280）：`bunPath`/`ompEntryPath` 改为可选，新增 `ompBinaryPath?`：

```ts
export interface OmpRpcClientOptions {
  ompBinaryPath?: string;   // 优先：预编译 omp 二进制
  bunPath?: string;         // 回退：bun 可执行文件
  ompEntryPath?: string;    // 回退：omp 源码入口
  cwd: string;
  env?: Record<string, string>;
  provider?: string;
  model?: string;
  sessionDir?: string;
  extraArgs?: string[];
  readyTimeoutMs?: number;
}
```

#### B4. [src/main/omp/session-manager.ts](file:///d:/AI/soc-verify/src/main/omp/session-manager.ts)

修改 `createSession()` 中 `clientOptions` 构造（L71-79）：透传 `ompBinaryPath`，并把 `bunVersionOk` 校验放宽（binary 模式不需要 bun）：

```ts
const clientOptions: OmpRpcClientOptions = {
  ompBinaryPath: runtime.ompBinaryPath,
  bunPath: runtime.bunPath,
  ompEntryPath: runtime.ompEntryPath,
  cwd: options.cwd,
  provider: options.provider,
  model: options.model,
  sessionDir: options.sessionDir,
  extraArgs: options.extraArgs,
};
```

同时修改 `createSession()` 的版本检查（L62-67）：binary 模式跳过 bun 版本检查：

```ts
if (!runtime.ompBinaryPath) {
  if (!runtime.bunVersionOk) {
    throw new Error(`Bun runtime must be >= 1.3.14 (found v${runtime.bunVersion}).`);
  }
}
```

#### B5. [src/main/omp/rpc-client.ts](file:///d:/AI/soc-verify/src/main/omp/rpc-client.ts)

修改 `start()` 方法（L66-76）：根据 `ompBinaryPath` 选择 spawn 方式：

```ts
const extraArgs = this.options.extraArgs ?? [];
let spawnCmd: string;
let spawnArgs: string[];

if (this.options.ompBinaryPath) {
  // 二进制模式：直接 spawn omp.exe
  spawnCmd = this.options.ompBinaryPath;
  spawnArgs = ['--mode', 'rpc', ...extraArgs];
  if (this.options.provider) spawnArgs.push('--provider', this.options.provider);
  if (this.options.model) spawnArgs.push('--model', this.options.model);
  if (this.options.sessionDir) spawnArgs.push('--session-dir', this.options.sessionDir);
} else {
  // 源码模式：spawn bun + cli.ts
  if (!this.options.bunPath || !this.options.ompEntryPath) {
    throw new Error('Either ompBinaryPath or (bunPath + ompEntryPath) must be provided');
  }
  spawnCmd = this.options.bunPath;
  spawnArgs = [this.options.ompEntryPath, '--mode', 'rpc'];
  if (this.options.provider) spawnArgs.push('--provider', this.options.provider);
  if (this.options.model) spawnArgs.push('--model', this.options.model);
  if (this.options.sessionDir) spawnArgs.push('--session-dir', this.options.sessionDir);
  spawnArgs.push(...extraArgs);
}

const child = spawn(spawnCmd, spawnArgs, {
  cwd: this.options.cwd,
  env: { ...process.env, ...this.options.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

注意：`--resume` 参数目前通过 `extraArgs` 传入（session-manager.ts:82），二进制模式也会带上，行为一致。

### C. 测试

现有测试不依赖 `resolveOmpRuntime()` 或 `OmpRpcClient` 的具体 spawn 形式（已扫描 `tests/omp/` 等目录）。`tests/omp/types.test.ts` 只测协议类型，不涉及 spawn。所以本次修改不需要新增/修改测试。

但 `npm run typecheck` 会触发 `OmpRuntime`/`OmpRpcClientOptions` 类型变化的传递性检查——所有引用点都已纳入修改清单。

---

## 验证步骤

### 1. 编译/类型/测试三连
```sh
npm run build        # 确认 main + preload + renderer 三进程构建通过
npm run typecheck    # 确认 OmpRuntime/OmpRpcClientOptions 类型变更不破坏其他引用
npm run test         # 确认现有测试全通过
```

### 2. 端到端验证：持久化
1. `npm run dev` 启动应用
2. 点击"打开项目"，选择一个目录（例如 `d:/AI/soc-verify` 自身）
3. 确认左栏出现文件树
4. 关闭应用窗口（触发 `before-quit` → `saveProjectsDb()`）
5. 检查 `%APPDATA%/socverify/socverify-data/projects.json` 存在且包含项目记录
6. 重新 `npm run dev`
7. 控制台应输出 `[project] restored 1 project(s) from disk`
8. 左栏应自动显示上次打开的项目（不需要重新点击"打开项目"）
9. 点击该项目，文件树应正常加载（懒启动 watcher）

### 3. 端到端验证：AI 会话
1. 启动 dev 模式后，打开任意项目
2. 等待自动创建默认 AI 会话（`autoCreateDefaultSession`）
3. 之前会因 `pi_natives.win32-x64-baseline.node` 报错的 toast 应消失
4. 在右栏 AI 对话框输入消息，确认 omp 进程正常响应（不再 `Agent process exited before ready`）
5. 控制台应输出 `[omp] resolved: ...` 或类似日志（取决于 binary 模式日志格式）

### 4. 打包验证（可选）
```sh
npm run package:win
```
确认 `dist/` 产物中 `resources/binaries/omp.exe` 被正确包含。
