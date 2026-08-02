# Unisoc Plugin Coupling Audit

Audit date: 2026-08-02

## Result

The five existing Unisoc plugins are runtime-decoupled from the Electron host. They do not import renderer modules, main-process modules, Electron, or tRPC. The loader only depends on the shared plugin contract and invokes each plugin through its declared kind.

| Plugin | Host coupling | Domain coupling | Migration |
| --- | --- | --- | --- |
| `unisoc-case-parser` | None found | `$PROJ_ENV`, `.socverify/env.json`, Unisoc cfg format | `apiVersion: 1.0` |
| `unisoc-subsys-discoverer` | None found | `$PROJ_RTL`, `.socverify/subsys-config.json` | `apiVersion: 1.0` |
| `unisoc-sim-option-schema` | None found | Unisoc runsim field names and groups | `apiVersion: 1.0` |
| `unisoc-simulation-runner` | None found | runsim command construction and EDA process behavior | `apiVersion: 1.0` |
| `builtin-coverage-parser` | None found | IMC/VCS urg/vcover report formats | `apiVersion: 1.0` |

## Interpretation

The domain coupling is intentional. EDA formats and commands belong to the adapter plugin, not the host. Moving those rules into the Electron process would recreate the coupling this plugin architecture is meant to remove.

The only remaining compatibility surface is the shared contract in `src/shared/plugin-types.ts`, the project-relative host context, and the declared manifest version. Future plugin changes should use the SDK and host context rather than reaching into application internals.
