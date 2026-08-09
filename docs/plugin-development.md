# Plugin Development

## Scaffold

```sh
node scripts/create-plugin.mjs my-plugin
```

This creates a plugin directly under `~/.socverify/plugins/my-plugin`. Pass an explicit target directory before the plugin ID to scaffold somewhere else:

```sh
node scripts/create-plugin.mjs ./plugins/my-plugin my-plugin
```

The scaffold creates a CJS backend module, a VS Code-style manifest, and an HTML view. Restart the app or use plugin reload after editing; no project configuration is needed for a user plugin.

## User plugin discovery

Each direct child of `~/.socverify/plugins` is treated as a plugin package when its `package.json` contains `socverify` metadata:

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

Plugin resolution is deterministic: project configuration overrides a user plugin with the same ID, and a user plugin overrides a built-in plugin. Project `.socverify/plugins.json` remains supported for local paths, packages in project `node_modules`, and per-project enable/disable overrides. Disabled auto-discovered plugins remain visible in the host state but are not executed.

User plugins are trusted local code and run in the Electron main process. Install only plugins whose source you trust. Plugin HTML views remain isolated in sandboxed iframes and can call only commands owned by that plugin.

## Manifest

Every migrated plugin declares `apiVersion: "1.0"`. Backend capability remains selected by `kind`; UI-only plugins use `kind: "ui"`. UI contributions use `contributes.views` and `contributes.commands`.

`activationEvents` are optional. Without them, the plugin activates during startup. Supported events are:

- `onStartupFinished`
- `onProjectOpen`
- `onView:<viewId>`
- `onCommand:<commandId>`

## Backend context

`activate(context)` receives the stable host context from `src/shared/plugin-types.ts`:

```js
activate(context) {
  context.on('project.opened', async (project) => {
    await context.setState('lastProject', project.rootPath);
  });

  context.registerCommand('my-plugin.refresh', () => ({ ok: true }));
  context.notify({ level: 'info', message: 'Ready' });
}
```

`readFile` and `writeFile` accept only project-relative paths. Plugin state is isolated per plugin under `.socverify/plugin-state/`. A failing package, activation hook, or event handler is reported against that plugin and does not stop other plugins from loading.

## UI bridge

The host injects `window.socVerify.invoke(command, args)` into every plugin view. HTML can use it directly; bundled plugin code can use the helper from `plugins/sdk`:

```js
const { getPluginUiBridge } = require('@socverify/plugin-sdk');
const bridge = getPluginUiBridge();
await bridge.invoke('my-plugin.refresh');
```

Plugin HTML is rendered in a sandboxed iframe and cannot access Electron APIs directly.
