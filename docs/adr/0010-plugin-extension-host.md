# ADR 0010: VS Code 风格插件扩展宿主

## 状态

Accepted

## 背景

插件过去只提供固定的后端能力（解析、发现、仿真和覆盖率）。插件页面必须修改主程序的 `CenterArea` 或其他布局组件，导致插件实现和 Electron 渲染端版本强耦合。

## 决策

采用一个小型的 VS Code 风格扩展宿主：

1. 插件 manifest 通过 `contributes.commands` 和 `contributes.views` 声明能力。
2. 插件模块可选导出 `activate(context)`，通过 `context.registerCommand` 注册命令处理器。
3. 视图由插件包中的 HTML 文件提供，主进程在加载时解析并通过 tRPC 返回；渲染端使用带 sandbox 的 iframe 承载视图。
4. iframe 只通过 `window.postMessage` 调用命令：

   ```js
   window.parent.postMessage({
     type: 'socverify:command',
     command: 'example.refresh',
     args: [],
     requestId: '1'
   }, '*');
   ```

5. 命令执行路径固定为：插件 iframe → 渲染端宿主 → `project.invokePluginCommand` → 主进程扩展宿主 → 插件命令处理器。

示例 manifest：

```js
module.exports = {
  manifest: {
    id: 'example-ui',
    name: 'Example UI',
    version: '1.0.0',
    kind: 'ui',
    contributes: {
      commands: [{ command: 'example.refresh', title: 'Refresh' }],
      views: [{ id: 'overview', name: 'Overview', location: 'center', entry: 'view.html' }]
    }
  },
  activate(context) {
    context.registerCommand('example.refresh', async () => ({ ok: true }));
  }
};
```

## 结果

- 插件只依赖 `src/shared/plugin-types.ts` 的稳定契约，不依赖 `AppShell`、`CenterArea` 或 Electron IPC 细节。
- 修改插件页面只需要修改插件自己的 HTML/CSS/JS 文件。
- 主程序只负责加载、隔离、展示和转发命令，新增视图无需修改主程序布局代码。
- iframe 不能直接访问 Electron API；需要的能力必须显式注册为命令。

## 当前范围

当前宿主把所有插件视图作为工作台中心页签打开。`location` 已保留为扩展点，后续可以增加左栏、右栏和底部容器，而不改变插件契约或命令通道。

## 非目标

- 不允许插件直接注入 React 组件或主程序 CSS。
- 不修改 `engine/oh-my-pi`。
- 不在本阶段引入插件市场、自动更新或跨进程沙箱进程。
