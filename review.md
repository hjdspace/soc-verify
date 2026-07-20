Codebase Architecture Optimization Analysis
Using the codebase-design vocabulary (depth, seam, interface, adapter, locality, leverage), here is a systematic evaluation of the current architecture, followed by prioritized optimization recommendations.

Current Architecture Assessment
What's well-designed:

tRPC router as the primary seam — clean boundary between main and renderer. 13 sub-routers each focused on one domain. The electron-trpc-bridge is a genuinely deep module: it hides the v10→v11 compatibility complexity behind a small IPC channel interface.

Plugin system interfaces — 5 clear PluginKind contracts with standalone types. The PluginBackedXxx adapters in plugin-discovery.ts are proper adapters sitting at a well-defined seam.

EventEmitter pattern — SessionManager, ProjectManager, SimulationManager all extend EventEmitter, which is the idiomatic Node.js pattern for pub-sub.

Workbench store — a clean tab-management seam in the renderer. The WorkbenchDestination union type is a small interface that hides which component renders each destination.

What's shallow or leaking:

1. Renderer stores are too deep (leaky)
The useSessionStore (46.5KB, 1230 lines) is the most concerning. It contains:

State management (expected)
tRPC calls (coordination logic)
Streaming event processing (a big switch on event types)
Throttling logic (message_update throttling, persist throttling)
Model/credential switching (coordinating tRPC calls + state updates)
History session management
Skill management
The interface (20+ exported actions) is nearly as complex as the implementation. The deletion test: if we delete this store, the complexity reappears across the RightPanel component and the chat components — not at a single seam. This is the hallmark of a shallow module.

┌──────────────────────────────────────┐ │ Large Interface (20+ fns) │ ├──────────────────────────────────────┤ │ │ │ tRPC calls │ Event processing │ │ │ Throttling │ Persistence │ │ │ Model mgmt │ Skill mgmt │ │ │ │ └──────────────────────────────────────┘
Same pattern in useSimulationStore (16.8KB, 438 lines) and useTerminalStore (7.1KB, 214 lines).

2. Event forwarding is fragmented across 3 touchpoints
Adding a new backend event requires touching:

Main process manager → emit the event
registerEventForwarding() in src/main/index.ts (113 lines, 7 event streams)
eventBridge in src/preload/index.ts (7+ explicit listeners)
The renderer store that listens to it
Each event type is a manual wire from EventEmitter.on() → win.webContents.send() → contextBridge → store listener. This is a leaky seam — the interface (what events exist) is not declared anywhere; it's implicit in the forwarding code.

3. No domain service layer in main process
The main process is a flat directory of managers. The router-context.ts (94 lines) is filling the gap by providing:

Validation helpers (requireProject, requireSession)
Factory methods (getSimulationManager)
File I/O helpers (storedMessagesPath, loadStoredMessages)
Utility functions (isPlaceholderSessionName, filterEmptyPlaceholderSessions)
This is a shallow module — each helper is a thin wrapper, and the cohesion is "what routers need" rather than a domain concept.

4. shared/types.ts is a growing monolith
10KB, 30+ type definitions from 8 domains (project, SCM, simulation, coverage, regression, TO checklist, error analysis, diff review). Lacks locality — finding a type means scrolling through unrelated domains.

5. Plugin adapter classes are in the wrong module
PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage live in src/main/host/plugin-discovery.ts but are imported by 3 different routers and router-context.ts. These adapters bridge the plugin system to the discovery interface — they should be at the seam between host/ and simulation/, not in host/.

6. Boilerplate duplication across stores
tRPCError() helper — identical in 3 stores (project.ts, session.ts, simulation.ts)
eventListenerRegistered guard — identical pattern in 3 stores (session.ts, simulation.ts, terminal.ts)
getToast() pattern — in 2 stores
7. CenterArea.tsx (822 lines) and RightPanel.tsx (1268 lines) are too large
These components directly import 10+ store selectors and domain components. They have no interface — just a procedural wall of code. The deletion test: if you delete one, the other absorbs its responsibilities.

Optimization Recommendations
Priority-ordered by impact. Each recommendation uses the codebase-design vocabulary.

P1 — Extract a Renderer IPC Event Layer
Problem: Event forwarding is a manual, error-prone wire across 4 files.

Decision: Create a single EventBridge abstraction in the renderer that:

Provides a typed EventMap interface (declares all events and their payload types)
Handles registration/deregistration in one place
Exposes typed on<T>(event, handler) and off<T>(event, handler) methods
typescript
复制
// src/renderer/src/lib/event-bridge.ts
// Deep module: Callers just subscribe to typed events
export interface EventMap {
  'session:event': { sessionId: string; event: unknown };
  'simulation:event': { type: string; record: unknown };
  'terminal:data': { id: string; data: string };
  'terminal:exit': { id: string; exitCode: number };
  'filetree:update': unknown;
  'project:opened': unknown;
  'project:closed': string;
  'errorAnalysis:event': { type: string; [key: string]: unknown };
}
This eliminates the eventListenerRegistered duplication and the eventBridge block in preload. The preload still exposes windowControls but event forwarding is now a single typed bridge.

Check: Every store imports eventBridge.on('simulation:event', ...) instead of window.eventBridge.onSimulationEvent(...). Adding a new event type = add to EventMap + wire in registerEventForwarding → no preload changes.

P1 — Split useSessionStore Along Domain Seams
Problem: 46.5KB store mixing tRPC calls, event processing, and UI state.

Decision: Split into three cooperating stores, each with a smaller interface:

Store	Responsibility	Interface size
useSessionStore	Session CRUD, current session selection, send/abort	~8 actions
useChatStore (new)	Message list, streaming state, message mutations	~5 actions
useSessionComposerStore (new)	Input text, skills, context files	~5 actions
The seam is the sessionId reference: useChatStore and useSessionComposerStore are parametrized by session ID; they never import useSessionStore. The event processing stays in useChatStore (it owns message state).

Check: RightPanel.tsx imports useChatStore for messages, useSessionComposerStore for input, useSessionStore for session list. No store exceeds 15KB.

P1 — Extract Domain Service Layer in Main Process
Problem: router-context.ts is a kitchen sink of helpers.

Decision: Create a src/main/services/ directory with focused domain services:

src/main/services/ project-service.ts # requireProject, ensurePluginsLoaded, loadPluginsForProject session-service.ts # requireSession, storedMessagesPath, loadStoredMessages simulation-service.ts # getSimulationManager, createSimulationManager
Each service is a deep module: it encapsulates the coordination logic between managers, registry, and plugin loader. router-context.ts shrinks to just export const t = initTRPC.create() and re-exports from services.

Check: router-context.ts < 10 lines. Each service < 80 lines.

P2 — Split shared/types.ts by Domain
Problem: 10KB monolith, 30+ types from 8 domains.

Decision: One file per domain:

src/shared/types/ index.ts # re-exports everything (backward compat) project.ts simulation.ts coverage.ts regression.ts to-checklist.ts error-analysis.ts diff-review.ts credential.ts source-control.ts background-task.ts
The index.ts re-export is a shallow adapter — it exists only for backward compatibility during migration. After every importer is updated, we delete it.

Check: Each file < 2KB. No file contains types from >1 domain.

P2 — Extract Shared Renderer Utilities
Problem: tRPCError() duplicated in 3 stores.

Decision: Move to src/renderer/src/lib/trpc-utils.ts:

typescript
复制
export function tRPCError(err: unknown): string { ... }
export function getToast() { return useToastStore.getState(); }
Check: 3 stores import from @renderer/lib/trpc-utils instead of defining their own.

P2 — Move Plugin Adapters to a Domain Boundary
Problem: PluginBackedDiscovery et al. live in host/ but are used by routers.

Decision: Move to src/main/plugin-adapters/:

src/main/plugin-adapters/ discovery.ts # PluginBackedDiscovery simulation.ts # PluginBackedSimulation coverage.ts # PluginBackedCoverage
The seam is now explicit: host/ defines the interfaces (SubsysDiscovery, HostToolsRegistry), plugin-adapters/ implements adapters that satisfy them. Routers import from plugin-adapters/.

Check: host/ no longer imports from @shared/plugin-types (it only defines the interface). plugin-adapters/ imports from both.

P3 — Decompose CenterArea.tsx and RightPanel.tsx
Problem: 822 and 1268 lines respectively.

Decision: Each workbench destination type gets its own renderer component file. The CenterArea becomes a thin router:

typescript
复制
function CenterArea() {
  const tab = useWorkbenchStore((s) => s.activeTab);
  if (!tab) return <DashboardPanel />;
  switch (tab.destination.type) {
    case 'file': return <FileEditorPanel />;
    case 'terminal': return <TerminalPanel />;
    case 'simulation-history': return <SimulationHistoryPanel />;
    // ... each < 200 lines
  }
}
Check: CenterArea.tsx < 100 lines. No file > 400 lines.

P3 — Extract SessionManager into Sub-Managers
Problem: SessionManagerImpl is 567 lines with too many responsibilities.

Decision: Extract:

SessionLifecycleManager — create/destroy/close sessions, concurrency limits
SessionEventStream — streaming event routing and throttling
SessionModelManager — model switching, credential integration
The SessionManager becomes a facade that delegates to these sub-managers. The interface (the facade) is still small, but the implementation is now internally modular.

Check: SessionManagerImpl < 200 lines. Each sub-manager < 200 lines.

Summary
Priority	Recommendation	Problem	Depth gain
P1	Renderer IPC event layer	Fragmented event wiring across 4 files	High — one interface vs 4 touchpoints
P1	Split useSessionStore	46.5KB shallow store	High — smaller interfaces, testable in isolation
P1	Extract domain services	router-context.ts kitchen sink	Medium — cleaner seam at service layer
P2	Split shared/types.ts	10KB monolith	Medium — locality for maintainers
P2	Extract shared utilities	tRPCError duplicated in 3 stores	Low — mechanical, but eliminates drift
P2	Move plugin adapters	Wrong module boundary	Medium — clear seam between host/ and plugin-adapters/
P3	Decompose CenterArea/RightPanel	822+1268 line components	Medium — each panel independently testable
P3	Extract SessionManager sub-managers	567-line class	Low — internal seam, not changing external interface
The biggest leverage win is P1#1 and P1#2 combined: a typed event layer + split stores means the renderer has a clear data flow: IPC events → event bridge → domain store → selector → component. Each arrow is a deep seam, not a leaky wire.