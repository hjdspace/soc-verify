---
name: socverify-plugin-dev
description: "为 SoC Verify 桌面 EXE 开发、安装、调试和验收用户插件。Use when the user asks to create a SoC Verify plugin, add EDA verification capability, extend the desktop UI, or use ~/.socverify/plugins."
---

# SoC Verify 用户插件开发

这个技能面向使用已安装 SoC Verify EXE 的用户。目标是交付一个可以独立放入 `~/.socverify/plugins/<plugin-id>/` 的插件包；插件作者只依赖下面的公开包格式和宿主上下文，插件实现不依赖应用内部目录、React 组件、Electron API 或 tRPC。

后端插件是可信本地代码，会在应用主进程中运行。把插件当作可执行程序审查来源；HTML 视图运行在 sandbox iframe 中，只通过 `window.socVerify.invoke()` 调用已注册命令。

## 工作步骤

### 1. 定义插件边界

先把需求归到一个公开 `kind`，并写出输入、输出和失败行为：

- `case-parser`: 从项目文件解析某个 `subsys` 的用例，返回用例数组。
- `subsys-discoverer`: 扫描项目发现子系统，返回子系统数组。
- `coverage-parser`: 把已有覆盖率报告目录解析为覆盖率树。
- `simulation-runner`: 封装 EDA 仿真启动、状态、编译错误和终止。
- `sim-option-schema`: 为子系统提供仿真选项字段定义。
- `ui`: 提供 HTML 视图和命令；可以组合宿主上下文完成项目分析。

需求必须能通过一个小的公开接口描述；无法归类的需求先缩小范围或拆成多个插件。完成条件：`kind`、输入文件、返回结构和错误输出均已列出。

需要逐字段的接口、返回值和示例时，读取 [reference/plugin-api.md](reference/plugin-api.md)。

### 2. 建立插件包

每个用户插件是 `~/.socverify/plugins` 的一个直接子目录，最小结构如下：

```text
~/.socverify/plugins/my-plugin/
  package.json
  index.cjs
  view.html                 # 只有 UI 插件需要
```

`package.json` 必须包含 `main` 和 `socverify` 元数据。`socverify.id`、`socverify.kind`、包版本与 `index.cjs` 导出的 `manifest` 保持一致，`apiVersion` 使用 `1.0`。

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "main": "index.cjs",
  "socverify": {
    "apiVersion": "1.0",
    "id": "my-plugin",
    "kind": "ui"
  }
}
```

完成条件：目录名稳定，入口文件存在，package metadata 能被 JSON 解析，且没有把应用源代码路径写进包内。

### 3. 实现 manifest 和后端入口

入口导出对象或 `default` 对象，至少包含 `manifest` 和对应 `kind` 的方法。UI 插件可选 `activate(context)` / `deactivate()`；命令在 `activate` 中注册。

```js
module.exports = {
  manifest: {
    apiVersion: '1.0',
    id: 'my-plugin',
    name: 'My Plugin',
    version: '0.1.0',
    kind: 'ui',
    activationEvents: ['onCommand:my-plugin.analyze'],
    contributes: {
      commands: [{ command: 'my-plugin.analyze', title: 'Analyze' }],
      views: [{ id: 'overview', name: 'Overview', location: 'center', entry: 'view.html' }]
    }
  },
  activate(context) {
    context.registerCommand('my-plugin.analyze', async (relativePath) => {
      const text = await context.readFile(String(relativePath));
      return { bytes: Buffer.byteLength(text, 'utf8') };
    });
  }
};
```

命令名使用 `<plugin-id>.<action>` 命名空间。manifest 中声明的 commands/views 是用户可见契约；实际命令处理器只在激活后存在。完成条件：入口加载时 manifest 校验通过，kind 所需方法齐全，命令能返回 JSON 可序列化结果。

### 4. 接入项目和 UI

UI 视图使用普通 HTML/CSS/JavaScript。通过 `window.socVerify.invoke(command, args)` 调用命令；不要导入 React、Electron 或应用内部模块。`entry` 是相对插件包根目录的 HTML 路径。

视图由宿主读取为单个 HTML 文档并放入 sandbox iframe。把 CSS 写在 `view.html` 的 `<style>` 中，把小型图片作为 data URI 内嵌；不要依赖相对路径的 `style.css`、远程脚本或 CDN。插件视图不继承桌面的 Tailwind、React 组件或主题变量，因此必须定义自己的字体、颜色、focus、loading、empty、error 和 responsive 状态。优先使用 `color-scheme` 与 `prefers-color-scheme` 同时适配明暗环境。

```html
<button id="run">Analyze</button>
<pre id="result"></pre>
<script>
document.querySelector('#run').addEventListener('click', async () => {
  const result = await window.socVerify.invoke('my-plugin.analyze', ['logs/run.log']);
  document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
});
</script>
```

宿主只允许命令调用通过插件自己的命令归属校验；把文件读取、项目写入和长耗时工作放在后端命令中。直接双击 HTML 只能检查静态外观，因为普通浏览器中不存在 `window.socVerify`。完成条件：视图可以在 sandbox 中渲染，按钮调用命令并把成功/失败结果呈现给用户。

### 5. 选择激活策略和状态

没有 `activationEvents` 的插件在项目打开后启动。需要按需启动时使用：

- `onStartupFinished`
- `onProjectOpen`
- `onView:<view-id>`
- `onCommand:<command-id>`
- `*`

`context.on(event, handler)` 订阅宿主事件；`getState` / `setState` 保存插件自己的项目状态；`notify` 发送信息、警告或错误通知。`readFile` / `writeFile` 只接受项目相对路径，路径越界会返回错误。完成条件：激活事件、状态 key 和事件清理方式已写入实现，重复 reload 不会留下重复命令或监听器。

### 6. 安装、加载和排障

1. 把完整插件目录复制到 `~/.socverify/plugins/<plugin-id>`。
2. 打开项目，在“设置 → 插件管理”中点击“重新扫描”。也可以关闭并重新打开项目。
3. 在插件管理中检查 ID、版本、来源、启用状态和加载错误，再打开 UI 视图或对应业务流程。
4. 修改代码后重新扫描；入口模块和 HTML 会重新读取，避免用旧缓存评估结果。
5. 用 `.socverify/plugins.json` 为某个项目写入同 ID 条目，可以覆盖路径或设置 `enabled: false`。

来源优先级固定为：项目配置 > 用户插件 > 内置插件。同 ID 的高优先级插件替换低优先级插件；禁用插件仍显示为 disabled，但不会激活或注册到业务能力列表。完成条件：插件状态无加载错误，目标命令/视图可用，重新打开项目后结果一致。

### 7. 做真实 EDA 小插件验收

先复制 [assets/eda-log-summary](assets/eda-log-summary) 到用户插件目录，再在项目中创建 `logs/eda-run.log`。该示例统计 EDA compile、simulation、tests、passed、failed 和 elapsed 字段，包含后端命令与 center HTML 视图。

验收顺序：

1. 复制目录并重开项目。
2. 打开“设置 → 插件管理”，找到 `EDA Log Summary` 并点击视图按钮。
3. 点击 Analyze，确认结果包含 `status`、`tests`、`passed`、`failed`、`elapsedSeconds`。
4. 将日志路径改为不存在的文件，确认视图显示宿主错误且应用其他功能继续可用。
5. 修改示例入口后 reload，确认返回字段变化而不是旧模块结果。

完成条件：健康日志得到结构化摘要，缺失文件得到明确错误，reload 生效，插件停用后不再响应命令。

## 交付清单

- `package.json` 的 `socverify` metadata 与入口 manifest 一致。
- 每个 `contributes` view 都有存在的 HTML entry；每个 command 都有 handler。
- 所有项目文件访问使用相对路径，返回值是可 JSON 序列化数据。
- 真实 EDA 示例验收通过，包含成功、缺失输入和 reload 三种结果。
- 交付给用户：插件目录、安装路径、触发方式、输入文件约定、已知工具依赖和回滚方式。

## 参考

- [reference/plugin-api.md](reference/plugin-api.md) — 公开 manifest、kind 接口和宿主上下文。
- [reference/eda-plugin-example.md](reference/eda-plugin-example.md) — EDA 日志插件的设计和验收断言。
- [assets/eda-log-summary](assets/eda-log-summary) — 可直接复制运行的最小示例。
