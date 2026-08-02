# Plugin Development

## Scaffold

```sh
node scripts/create-plugin.mjs ./plugins/my-plugin my-plugin
```

The scaffold creates a CJS backend module, a VS Code-style manifest, and an HTML view. The plugin package can be loaded from `.socverify/plugins.json` with `source: "local"` or installed under `node_modules`.

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

`readFile` and `writeFile` accept only project-relative paths. Plugin state is isolated per plugin under `.socverify/plugin-state/`.

## UI bridge

The host injects `window.socVerify.invoke(command, args)` into every plugin view. HTML can use it directly; bundled plugin code can use the helper from `plugins/sdk`:

```js
const { getPluginUiBridge } = require('@socverify/plugin-sdk');
const bridge = getPluginUiBridge();
await bridge.invoke('my-plugin.refresh');
```

Plugin HTML is rendered in a sandboxed iframe and cannot access Electron APIs directly.
