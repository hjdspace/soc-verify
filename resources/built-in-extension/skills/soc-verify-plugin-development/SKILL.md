---
name: soc-verify-plugin-development
description: Create SoC Verify plugins against the stable contract. Use when the user wants to build, scaffold, or register a plugin for the SoC Verify desktop app — a backend plugin (subsys discoverer, case parser, coverage parser, simulation runner, sim-option schema) or a UI plugin with iframe views and commands.
---

# SoC Verify Plugin Creation

SoC Verify loads plugins from the user's project against a stable **contract**. The plugin codes to the contract only — it never imports host source, Electron, tRPC, or `@renderer`/`@main`. Everything the plugin needs lives in its own package; the host loads, isolates, and forwards commands. The user has the desktop app, not the host source, so author from the contract inlined here.

## Plugin kinds

Pick the kind from what the user wants the plugin to do:

| kind | required method(s) | returns |
|---|---|---|
| `subsys-discoverer` | `discover(projectRoot)` | `SubsysInfo[]` |
| `case-parser` | `parse(projectRoot, subsys)` | `CaseInfo[]` |
| `coverage-parser` | `parse(projectRoot, sessionId, reportDir)` | `CoverageData` |
| `simulation-runner` | `run(opts)`, `getStatus(runId)`, `getCompileErrors(runId)`, `abort(runId)` | `SimulationRunHandle` / `SimulationRunStatus` / `CompileError[]` / `void` |
| `sim-option-schema` | `getSchema(subsys)` | `SimOptionSchema` |
| `ui` | optional `activate(context)` + `contributes.views`/`contributes.commands` | — |

Return-type shapes are in **Contract types**; author methods against them exactly.

## Package structure

A plugin is a CJS package placed under `<projectRoot>/plugins/<plugin-id>/`:

- `package.json` documenting the plugin and pointing at the entry:
  ```json
  {
    "name": "<plugin-id>",
    "version": "0.1.0",
    "main": "index.cjs",
    "socverify": { "apiVersion": "1.0", "id": "<plugin-id>", "kind": "<kind>" }
  }
  ```
- `index.cjs` (the `main` file) exporting an object with `manifest` plus the kind's required method(s), and optionally `activate` / `deactivate`:
  ```js
  'use strict';
  module.exports = {
    manifest: { /* see Manifest */ },
    async discover(projectRoot) { /* ... */ return []; },
    // activate(context) { /* ... */ },   // UI & lifecycle plugins
    // deactivate() { /* ... */ },
  };
  ```
- For `ui` plugins: one or more HTML view files referenced by `contributes.views[].entry`.

The host loads the `main` file via `require()` and reads `module.exports.manifest` (it also accepts `exports.default` / `exports.plugin`). The CJS `manifest` is the authoritative object the host validates. Use a `.cjs` extension so the file loads as CJS regardless of the project's `"type"`.

## Manifest

```ts
{
  apiVersion: '1.0',            // set to '1.0' for every new plugin
  id: string,                   // unique; matches package socverify.id and the registration entry
  name: string,
  version: string,
  kind: PluginKind,             // one of the 6 kinds
  description?: string,
  activationEvents?: string[],  // omit/empty → activate at startup
  contributes?: {               // UI plugins declare views & commands here
    commands?: { command: string, title: string, category?: string }[],
    views?: { id: string, name: string, location: 'center'|'left'|'right'|'bottom', entry?: string }[]
  }
}
```

`activationEvents` (lazy activation): `onStartupFinished`, `onProjectOpen`, `onView:<viewId>`, `onCommand:<commandId>`. Omit or leave empty to activate at startup. For a UI plugin, `onView:<viewId>` is the usual choice — the plugin activates when its view is shown, so command handlers are registered before the HTML can invoke them.

## Registration

Register the plugin in the user's project at `<projectRoot>/.socverify/plugins.json`:

```json
{
  "plugins": [
    {
      "id": "<plugin-id>",
      "name": "<Plugin Name>",
      "version": "0.1.0",
      "kind": "<kind>",
      "source": "local",
      "path": "./plugins/<plugin-id>/index.cjs",
      "enabled": true
    }
  ]
}
```

- `source: "local"` — `path` is relative to the project root (or absolute); resolves to the plugin's `main` file.
- `source: "node_modules"` — `path` is a package name resolved from the project's `node_modules`.
- The `id` here must equal `manifest.id` and `kind` must equal `manifest.kind`. A project-level entry overrides any built-in plugin with the same id.
- Set `enabled: false` to keep the package on disk but skip loading.

## Host context (UI & lifecycle plugins)

`activate(context)` receives the host context. Use it for commands, events, state, notifications, and project file access:

```js
activate(context) {
  context.on('project.opened', async (project) => {
    await context.setState('lastProject', project.rootPath);
    context.notify({ level: 'info', message: 'ready' });
  });
  context.registerCommand('<plugin-id>.refresh', async (args) => ({ ok: true }));
}
```

| method | behavior |
|---|---|
| `registerCommand(command, handler)` | registers a callable command (invoked from UI or the host) |
| `on(event, handler) => () => void` | subscribes to a host event; returns an unsubscribe |
| `getState<T>(key) => Promise<T\|undefined>` | reads plugin-isolated state |
| `setState<T>(key, value) => Promise<void>` | writes plugin-isolated state |
| `notify({ level, message, detail? })` | `level: 'info'\|'warning'\|'error'` |
| `readFile(path) => Promise<string>` | project-relative path only |
| `writeFile(path, content) => Promise<void>` | project-relative path only |

State is persisted per plugin at `.socverify/plugin-state/<pluginId>.json`. `readFile`/`writeFile` reject absolute paths and any path that escapes the project root. Release resources in `deactivate()` — the host calls it before reloading the plugin.

## UI views

UI plugins ship HTML in a sandboxed iframe; the host injects `window.socVerify.invoke(command, args)`. Call commands from the HTML directly — no SDK import needed:

```html
<button id="refresh">Refresh</button>
<script>
  document.querySelector('#refresh').addEventListener('click', async () => {
    const result = await window.socVerify.invoke('<plugin-id>.refresh');
  });
</script>
```

- `location: center` → center workspace; `left` → left rail "Plugins" tab; `right` → collapsible area in the AI panel; `bottom` → collapsible area in the terminal zone.
- `entry` is a path relative to the plugin package; the host inlines the HTML when loading.
- The iframe cannot reach Electron, tRPC, or the host app's DOM — every host capability must be a registered command.

## Contract types

Author backend methods against these shapes exactly:

```ts
SubsysInfo = { id: string, name: string, path: string, kind: 'subsys' | 'top' }

CaseInfo = {
  id: string, name: string, path: string,
  baseCase?: string,   // set when this case inherits from another
  filePath?: string,
  base?: string, block?: string   // sim -base / -block params parsed from config
}

SimOptionSchema = { fields: SimOptionField[] }
SimOptionField = {
  key: string, label: string,
  type: 'string' | 'number' | 'boolean' | 'enum',
  default?: unknown, enumValues?: string[], description?: string, group?: string
}

SimulationRunOptions = {
  caseId: string, caseName?: string, subsys: string,
  options?: Record<string, unknown>, projectRoot?: string   // projectRoot injected by host
}
SimulationRunHandle = { runId: string }
SimulationRunStatus = {
  runId: string, status: 'pending'|'running'|'pass'|'fail'|'error'|'aborted',
  startTime?: number, endTime?: number, message?: string
}
CompileError = { file: string, line: number, column?: number, severity: 'error'|'warning', message: string }

CoverageMetric = 'line'|'branch'|'toggle'|'condition'|'fsm_state'|'fsm_transition'|'functional'|'assertion'
CoverageTriplet = { percentage: number|null, covered: number|null, total: number|null }
CoverageNode = {
  name: string, path: string, depth: number,
  metrics: Record<CoverageMetric, CoverageTriplet>,
  children: CoverageNode[]
}
UncoveredItem = { module: string, file?: string, line?: number, signal?: string, description: string }
TestContribution = { testName: string, score?: number, rank?: number, coverage?: Partial<Record<CoverageMetric, number>> }
CoverageData = {
  sessionId: string,
  source: { covMergeDir: string, edaTool: 'imc'|'vcs-urg'|'vcover'|'unknown', reportGeneratedAt: number },
  root: CoverageNode,
  targets: Partial<Record<CoverageMetric, number>>,
  uncovered?: Partial<Record<CoverageMetric, UncoveredItem[]>>,
  metrics?: Record<string, number>,
  testContributions?: TestContribution[],
  csvData?: string
}
```

The coverage-parser parses text reports the host has already generated in `reportDir`; it does not run EDA commands itself.

## Guardrails

- Code to the contract only — never import `electron`, tRPC, `@renderer`, `@main`, or any host source.
- UI HTML reaches the host solely through `window.socVerify.invoke`; no direct Electron or `postMessage`.
- `readFile`/`writeFile` use project-relative paths only; never touch `.socverify/plugin-state/` of another plugin.
- Do not inject React components, host CSS, or main-process modules into the host app.

## Workflow

1. **Pick the kind.** Match the user's intent to one of the 6 kinds. *Done when* the chosen kind is in the table and matches what the user wants the plugin to do.

2. **Scaffold the package.** Create `<projectRoot>/plugins/<plugin-id>/` with `package.json` (including the `socverify` field) and the `main` CJS file exporting `manifest` plus the kind's method(s). *Done when* `package.json.socverify` has `apiVersion: '1.0'`, `id`, `kind`, and the `main` file exports an object whose `manifest.id` and `manifest.kind` match.

3. **Implement the contract.** Backend: implement the required method(s) returning the exact type from **Contract types**. UI: declare `contributes.views` (and `contributes.commands` for any command the view calls), implement `activate(context)` registering a handler for every declared command, and ship the HTML view calling `window.socVerify.invoke`. *Done when* the kind's required method exists (backend) or views + commands + activate + HTML are all present (UI), and `manifest` validates against the Manifest schema.

4. **Register in the project.** Add the entry to `<projectRoot>/.socverify/plugins.json` with matching `id`/`kind`, `source`, `path` resolving to the `main` file, `enabled: true`. *Done when* the entry's `id` equals `manifest.id`, `kind` equals `manifest.kind`, and `path` resolves to an existing file.

5. **Test in isolation.** Write a vitest or node test that requires the plugin, asserts the manifest fields, and calls the kind method (or `activate`'s `registerCommand`) on sample input, asserting the return shape. *Done when* the test passes and exercises manifest + export shape + return shape.

6. **Check guardrails.** Confirm no host/Electron/tRPC imports, project-relative file access only, and UI HTML uses only `window.socVerify.invoke`. *Done when* every guardrail above is satisfied.
