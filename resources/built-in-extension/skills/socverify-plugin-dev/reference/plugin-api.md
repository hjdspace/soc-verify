# SoC Verify 公开插件契约

## Manifest

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `apiVersion` | 推荐 | 当前为 `1.0` |
| `id` | 是 | 全局稳定 ID，使用小写 kebab-case |
| `name` | 是 | UI 展示名称 |
| `version` | 是 | 插件版本 |
| `kind` | 是 | `case-parser` / `subsys-discoverer` / `coverage-parser` / `simulation-runner` / `sim-option-schema` / `ui` |
| `activationEvents` | 否 | 按需激活事件；缺省为项目打开后启动 |
| `contributes` | 否 | commands 和 views 声明 |

`package.json#socverify` 用于发现，入口 manifest 用于运行时校验。两个位置的 `id` 和 `kind` 必须相同。

## Backend kind

### case-parser

```js
parse(projectRoot, subsys) -> Promise<CaseInfo[]>
```

每个 `CaseInfo` 至少包含 `id`、`name`、`path`；可选 `baseCase`、`filePath`、`base`、`block`、`phase`。

### subsys-discoverer

```js
discover(projectRoot) -> Promise<SubsysInfo[]>
```

每个 `SubsysInfo` 包含 `id`、`name`、`path` 和 `kind`（`subsys` 或 `top`）。

### coverage-parser

```js
parse(projectRoot, sessionId, reportDir) -> Promise<CoverageData>
```

读取 `reportDir` 中的平台或 EDA 报告，返回 coverage tree。保持节点的层级、metric 名称、数值和未覆盖项稳定；解析失败抛出包含报告文件和原因的错误。

### simulation-runner

必须同时提供：

```js
run(options) -> Promise<{ runId }>
getStatus(runId) -> Promise<{ runId, status, startTime?, endTime?, message? }>
getCompileErrors(runId) -> Promise<CompileError[]>
abort(runId) -> Promise<void>
```

`options` 至少包含 `caseId` 和 `subsys`，宿主会注入 `projectRoot`。状态使用 `pending`、`running`、`pass`、`fail`、`error`、`aborted`。

### sim-option-schema

```js
getSchema(subsys) -> Promise<{ fields: SimOptionField[] }>
```

字段类型为 `string`、`number`、`boolean` 或 `enum`；enum 字段提供 `enumValues`。字段 `key` 在同一插件内稳定。

### ui

UI 插件不要求业务方法；它通过 `contributes.views` 提供 HTML，通过 `activate` 注册命令。view location 为 `center`、`left`、`right` 或 `bottom`。

## Activation context

| 方法 | 行为 |
| --- | --- |
| `registerCommand(id, handler)` | 注册异步或同步命令；命令 ID 应以插件 ID 开头 |
| `on(event, handler)` | 订阅事件并返回取消订阅函数 |
| `getState(key)` / `setState(key, value)` | 读写插件隔离的项目状态 |
| `notify({ level, message, detail? })` | 记录 info / warning / error 通知 |
| `readFile(relativePath)` | 读取项目根目录内 UTF-8 文本 |
| `writeFile(relativePath, content)` | 写入项目根目录内文本并创建父目录 |

状态保存位置和实现细节由宿主管理；插件只保存自己的 key。文件方法使用项目相对路径，路径验证由宿主完成。

## UI bridge

宿主向每个 HTML view 注入：

```js
window.socVerify.invoke(command, args?) -> Promise<unknown>
```

命令参数必须是可结构化克隆的数据。处理结果应是 JSON 可序列化值；错误会作为 rejected Promise 返回。视图不要假设 Electron、Node 或 React 全局存在。

## UI styles and assets

宿主将 `entry` 读取为单个 HTML 字符串并通过 sandbox iframe 渲染。使用内联 `<style>` 和原生 JavaScript；相对路径的外部 CSS、JavaScript、字体和图片文件不会由宿主自动提供。小型静态资源使用 data URI，较大的资源应由后端命令读取并以可序列化数据返回。视图不会继承桌面应用的 Tailwind 类、组件库或 CSS 变量。
