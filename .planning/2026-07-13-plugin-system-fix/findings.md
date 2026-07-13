# Findings

- Source execution resolves `../../plugins` from `src/main/plugins` to nonexistent `src/plugins`.
- Development bundle resolves the same expression from `out/main` to the repository root by coincidence.
- `electron-builder.yml` does not package `plugins/` into `resources/plugins`.
- The Unisoc plugin reads only `process.env.PROJ_RTL`; project `.socverify/env.json` is disconnected.
- The renderer maps every empty result and query error to the same "plugin required" message.
- Manual fallback exists only as `.socverify/subsys-config.json`; no UI action exposes it.
- Existing repository guidance is sufficient product context for the compact desktop tool; no separate PRODUCT.md/DESIGN.md will be introduced for this surgical fix.
- Confirmed TDD seams: `PluginLoader.loadPlugins()`, `SubsysDiscoveryPlugin.discover(projectRoot)`, and `SubsysList` user-visible tRPC behavior.
- `useProjectStore` already holds plugin load results returned by project open, so the empty state can distinguish missing/error plugins without changing the existing subsystem array response.
- UI tests mock the tRPC proxy and Zustand selectors directly; a focused `SubsysList.test.tsx` can cover the user-visible states without Electron.
- `PluginConfigEntry` already carries `kind`, `enabled`, and optional `error`, sufficient for precise empty-state copy.
- There is no existing project plugin-management component to reuse; the compact action should open the existing environment wizard instead of adding a second manual subsystem editor.
- Existing `EnvWizard` supports arbitrary environment variables and is mounted globally, but no component currently opens it; `SubsysList` can load the project config and jump directly to the environment-variable step.
- Rescanning does not require a new backend endpoint because `getSubsystems` calls the discoverer on every query and has no subsystem cache.
- Diff review found that plugin metadata can lag restored subsystem data; non-empty discovery results must take precedence over plugin empty-state diagnostics.
