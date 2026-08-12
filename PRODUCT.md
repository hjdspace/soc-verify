# Product

## Register

product

## Users

SoC verification engineers working in a Windows desktop environment across project setup, simulation, regression, coverage closure, failure analysis, and tape-out readiness. They work with dense technical data and repeated workflows, and need extension points that remain understandable when EDA integrations vary by project or vendor.

## Product Purpose

SoC Verify is a single desktop workbench for the verification lifecycle — from project kickoff to Tape-Out. It combines project navigation, EDA execution, analysis, and AI-assisted engineering while keeping vendor-specific behavior in independently installable plugins. Success means engineers can discover system state, act on it quickly, and extend the application without changing its source code.

## Domain Scope

SoC Verify covers the complete SoC verification lifecycle:

| Phase | Capability | Description |
|-------|-----------|-------------|
| **Project Setup** | Project management | Multi-project open/switch, file tree browsing, plugin discovery, project state persistence |
| **Simulation** | Simulation execution | Run individual cases or batches, configure options via plugin-driven schema, real-time terminal output, simulation history |
| **Error Analysis** | Automated debugging | On FAIL detection, auto-trigger AI error analysis — compile errors get auto-fix + retry (max 3), sim errors get suggestions |
| **Coverage** | Coverage analysis & closure | Import coverage data from EDA tools, view hierarchical coverage tree (8 metrics), AI-driven coverage closure loop (gap identification → test generation → simulation → delta check) |
| **Timing** | Timing violation management | Parse `vio_summary.log`, confirm violations with pattern matching, dashboard with distribution charts |
| **Regression** | Regression suite management | Create regression suites, batch execution, result summary, comparison between runs |
| **Dashboard** | Verification metrics | 9+ ECharts visualizations — trends, heatmap, failures, regression progress, duration distribution, unstable cases, phase pass rates, debug difficulty |
| **AI Agent** | Multi-session AI | Streaming chat with omp, tool calling (simulation, coverage, files, logs), multiple concurrent sessions, skill system |
| **Documents** | Office document handling | Preview/edit .docx/.pptx/.xlsx/.pdf in-app, AI-generated documents stored in project `docs/` |
| **TO Readiness** | Tape-out checklist | Track TO checklist items, assess readiness, export reports |
| **Tools** | 20+ built-in tools | Git Manager, Diff, Quick Pull, Time Analyzer, SV Ifdef Checker, Regression Analyzer, Register Table Parser, Coverage Merger, C-SV Converter, Log Analyzer, and more |
| **Browser** | In-app browser | WebContentsView-based browser with SSO, bookmarks, tab persistence |
| **MCP** | MCP server config | Multi-scope MCP server configuration and status management |

## Architecture Overview

### Three-Process Model

| Process | Source | Output | Responsibility |
|---------|--------|--------|----------------|
| Main | `src/main/` | CJS | Window management, omp subprocess, tRPC router, native IPC |
| Preload | `src/preload/` | CJS | `contextBridge` exposes `electron-trpc` + `windowControls` + `eventBridge` |
| Renderer | `src/renderer/` | ESM | React SPA, tRPC proxy calls to main process API |

### Core Technical Decisions

- **Plugin system**: 6 plugin kinds (`case-parser` / `subsys-discoverer` / `simulation-runner` / `coverage-parser` / `sim-option-schema` / `ui`). Plugins live in `~/.socverify/plugins/` and project directories. Platform provides interfaces and runtime; EDA vendor logic is entirely in plugins.
- **Case Database**: Single SQLite source of truth (`~/.socverify/cases.db`). UI, AI Agent, timing violation module, and Dashboard all read from DB. Plugins degrade to "scanners" called only on refresh.
- **tRPC API**: All business logic exposed through tRPC router (`src/main/ipc/router.ts`). ~40 procedures across 20+ sub-routers. Frontend types derived automatically.
- **omp integration**: AI Agent communicates via `socverify-runner` JSONL subprocess. SessionManager manages concurrency (max 10). Supports precompiled runner + Bun fallback + OpenAI-compatible providers.
- **Diff Review**: AI code change review system with hunk-level accept/reject, before reconstruction, overwritten hunk detection, and global review queue across sessions.
- **Office documents**: officecli binary integrated for docx/pptx/xlsx/pdf preview and creation. Fortune-sheet for xlsx editing. AI creates documents via Host Tools.
- **Coverage pre-processing pipeline**: Platform runs EDA commands to generate text reports; `CoverageParserPlugin` parses reports into hierarchical tree. Two-step separation allows independent evolution.
- **Timing violation module**: `better-sqlite3` + Worker Thread parsing. Pattern matching for confirmation reuse. Violation Dashboard replaces Python web server.

### tRPC Procedure Surface

| Router | Procedures | Purpose |
|--------|-----------|---------|
| `session` | 20+ | AI session create/send/abort/destroy, model switch, skill discovery, context management, event stream |
| `simulation` | 12 | Run simulation, status, compile errors, abort, history, details, comparison, terminal simulation |
| `dashboard` | 11 | Summary, trend, heatmap, failures, regression progress, duration histogram, unstable cases, phase pass rate, debug difficulty, subsys list, layout |
| `project` | 18 | Project CRUD, file tree, file read/write, subsys/case discovery, plugin management, search |
| `coverage` | 7+ | Coverage summary/tree/trend/export/closure, session management, targets config |
| `regression` | 5 | Regression suite CRUD, execution, cancellation, results |
| `violation` | multiple | Timing violation query/parse/statistics |
| `confirmation` | multiple | Violation confirmation workflow |
| `pattern` | multiple | Violation pattern management |
| `document` | multiple | Office/PDF preview/edit |
| `tools` | multiple | 20+ built-in tool routers |
| `browser` | multiple | In-app browser management |
| `database` | multiple | SQLite database viewer |
| `settings` | 10+ | Credentials, app settings, MCP config, system prompt |
| `errorAnalysis` | 6 | Error analysis session management, log reading |
| `diff-review` | 2 | Diff fetch, rejection apply |
| `to` | 4 | TO checklist management |
| `env` | 4 | EDA tool detection, environment config |
| `terminal` | 7 | Terminal create/write/resize/destroy/list/buffer |
| `system` | 1 | Agent runtime resolution |

## Brand Personality

Precise, restrained, dependable. The interface should feel like an engineering instrument: quiet during routine work, explicit when state changes, and direct when something fails.

## Anti-references

- Marketing-style composition, oversized hero typography, and decorative feature cards.
- Nested cards, pill-heavy controls, gratuitous gradients, glass effects, and ornamental animation.
- One-note purple, dark-blue, beige, or brown palettes that overpower semantic status colors.
- Hidden system state, unlabeled unfamiliar icons, and extension workflows that require source-code knowledge.

## Design Principles

- Put the current engineering task first; product chrome should stay compact and predictable.
- Make discovery, loading, activation, and failure states visible where users manage extensions.
- Use familiar desktop affordances and the existing semantic component vocabulary.
- Keep plugin trust boundaries and file locations explicit without exposing application internals.
- Prefer dense, scan-friendly rows and progressive detail over repeated decorative cards.
- Data flows from backend to frontend via tRPC — avoid ad-hoc state management that bypasses the API layer.
- Plugin interfaces are the contract; internal implementations are replaceable.

## Accessibility & Inclusion

Interactive controls must be keyboard reachable, expose visible focus states, and provide labels or tooltips for icon-only actions. Status must not rely on color alone. Text and controls must maintain readable contrast across all bundled themes, and motion must be limited to short state feedback that respects reduced-motion preferences.
