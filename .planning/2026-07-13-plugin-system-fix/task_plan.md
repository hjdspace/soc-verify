# Plugin system reliability fix

## Goal
Ensure the bundled subsystem discoverer loads in source, development, and packaged runtimes; uses project-level `PROJ_RTL`; and exposes actionable empty states.

## Success criteria
- Built-in plugin discovery is covered through `PluginLoader.loadPlugins()`.
- Packaged resources include bundled plugins.
- Project environment configuration can supply `PROJ_RTL` without mutating global process state.
- The subsystem panel distinguishes missing plugin, load error, and no discovered subsystems, with a manual configuration action.
- `npm run build`, `npm run typecheck`, and `npm run test` pass in order.

## Phases
1. Loader and packaging tests/fix - complete
2. Project environment discovery tests/fix - complete
3. API/UI status and manual configuration tests/fix - complete
4. Full verification, review, and commit - in_progress

## Constraints
- Preserve all pre-existing worktree changes.
- Do not modify `engine/oh-my-pi`.
- Keep plugin API changes minimal and backwards compatible.
