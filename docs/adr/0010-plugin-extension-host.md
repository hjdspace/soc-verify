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

## 阶段路线图

| 阶段 | 状态 | 交付物 |
| --- | --- | --- |
| 1. 基础扩展宿主 | 已完成 | `ui` 插件、commands/views manifest、中心工作区 iframe、命令转发 |
| 2. 完整视图容器 | 已完成 | 左栏、右栏、底部插件视图容器；视图选择、折叠状态和项目布局持久化 |
| 3. 扩展宿主 API | 已完成 | 事件订阅、插件状态存储、通知、项目上下文、受控项目文件读写、生命周期停用 |
| 4. 生命周期与激活机制 | 已完成 | 基于 `activationEvents` 的按需激活、重载和资源清理策略 |
| 5. UI SDK 与开发工具 | 已完成 | 类型包、bridge SDK、插件脚手架和开发指南 |
| 6. 安全与进程隔离 | 未开始 | 独立扩展进程、权限声明、命令白名单和更严格的资源隔离 |
| 7. 插件生态管理 | 未开始 | 依赖/版本检查、安装、升级、卸载和插件市场入口 |
| 8. 现有插件迁移 | 已完成 | 内置插件统一 `apiVersion: "1.0"` manifest，补充迁移测试和开发指南 |

第二、三阶段的实现细节：

- `location: left` 在左栏以“插件”标签显示。
- `location: right` 在 AI 右栏显示为可折叠插件区。
- `location: bottom` 在底部终端区域显示为可折叠插件区。
- 当前布局状态写入项目状态文件，插件自己的持久化状态写入项目 `.socverify/plugin-state/<pluginId>.json`。
- 扩展宿主 API 通过 `PluginActivationContext` 暴露，插件不能直接访问 Electron API。

扩展宿主 API 的最小示例：

```js
activate(context) {
  context.on('project.opened', async (project) => {
    await context.setState('lastProject', project.rootPath);
    context.notify({ level: 'info', message: 'Plugin activated' });
  });

  context.registerCommand('example.read-config', () =>
    context.readFile('.socverify/config.json'));
}
```

`readFile`/`writeFile` 只接受项目根目录下的相对路径；插件状态按插件隔离保存到 `.socverify/plugin-state/`。

阶段 4 支持 `onStartupFinished`、`onProjectOpen`、`onView:<viewId>` 和 `onCommand:<commandId>`。重新加载插件时会先调用已激活插件的 `deactivate`，再重新读取 manifest 和贡献点。

阶段 5 的脚手架命令是 `node scripts/create-plugin.mjs <target-directory> <plugin-id>`，开发指南位于 `docs/plugin-development.md`。

## 非目标

- 不允许插件直接注入 React 组件或主程序 CSS。
- 不修改 `engine/oh-my-pi`。
- 不在本阶段引入插件市场、自动更新或跨进程沙箱进程。
