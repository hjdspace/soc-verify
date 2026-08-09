# ADR 0018: User Plugin Catalog

## Status

Accepted

## Context

The extension host from ADR 0010 decoupled plugin views and commands from React layout code, but discovery still merged only bundled plugins and project `.socverify/plugins.json`. Users could not install a plugin once for all projects, and plugin configuration was duplicated between `ProjectManager` and `PluginLoader`.

OpenSquilla's TUI plugin runtime was reviewed as a reference. Its useful properties are renderer-independent events and slots, deterministic priority, bounded error handling, and continuing after one plugin fails. It does not implement external user-package discovery, so its runtime principles are adopted without copying its package model.

## Decision

1. `PluginLoader` is the plugin-host seam. It owns discovery, configuration, module loading, activation, command ownership, state, notifications, and registry projection.
2. `catalog.ts` discovers package candidates from the bundled directory and `~/.socverify/plugins`. Each plugin is a direct child package with `package.json#socverify` metadata.
3. Resolution priority is project, then user, then built-in. IDs are the stable identity; a higher-priority candidate replaces a lower-priority candidate with the same ID.
4. Project `.socverify/plugins.json` remains the compatibility and per-project override layer. It can also disable an auto-discovered plugin without making that plugin disappear from status results.
5. Package and runtime manifests must agree on ID and kind. Required methods are checked before registration. CJS and ESM entrypoints are reloaded without retaining the entry-module cache.
6. Package, activation, and event failures are isolated to the responsible plugin. Plugin UI commands are scoped to the plugin that registered them.
7. `ProjectManager` no longer reads or mutates plugin configuration.

## Consequences

- A user can develop or copy a plugin into `~/.socverify/plugins/<plugin-id>` and use it in every project without editing application source or project configuration.
- Built-in and existing project plugins remain compatible with API version 1.0.
- Plugin views remain renderer-independent HTML hosted in sandboxed iframes.
- Backend plugins are trusted local code loaded in the Electron main process. Process-level permission isolation remains future work; this trust model must be explicit in developer documentation.
