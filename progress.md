# Progress

## 2026-07-13
- Read the complete `diagnosing-bugs` and `planning-with-files` skill instructions.
- Inspected repository status and project scripts.
- Confirmed a dirty worktree with overlapping Agent/session work; will preserve it.
- Confirmed the screenshot has two distinct symptoms: echoed user content and a provider 403.
- Started Phase 1: feedback loop construction.
- Traced the renderer path and found a deterministic duplicate-message candidate: `message_start` does not filter by message role.
- Located the focused session-store test seam and began tracing provider configuration through the new Agent layer.
- Confirmed provider ID normalization and OpenAI environment-variable mapping already exist.
- Confirmed the Electron client does not build HTTP requests; it sends init configuration to the Agent runner, which is the next boundary to inspect.
- Located the exact runner and identified the omp-RPC-to-Agent-SDK migration as the regression boundary; no submodule files will be edited.
- Confirmed from engine source that each prompt emits user-role message events, completing the evidence chain for the duplicate-message symptom.
- Confirmed the OpenAI descriptor remains Responses API under a custom base URL.
- Found a compliant fix path that does not modify the submodule: omp's documented custom-provider `models.yml` plus `PI_CODING_AGENT_DIR`.
- Added focused regression tests for user-event echo suppression and OpenAI-compatible completions configuration; running the initial red check.
- Red loop confirmed: the user event changes the assistant placeholder to the echoed prompt, and the missing compatibility adapter makes the provider test fail.
- Completed feedback-loop/reproduction phases and started the minimal fix.
- Implemented role filtering and temporary `openai-completions` provider configuration; focused unit tests pass (20/20).
- Added an actual-runner/local-gateway integration test. Its first attempt exposed unisolated omp log state, now corrected via `XDG_STATE_HOME`.
- Actual runner completed a full assistant turn through `/v1/chat/completions` and never hit `/v1/responses`; only Windows temp cleanup remained, addressed with bounded retries.
- All focused regression tests pass: 3 files, 21 tests.
- Completed the fix/regression phase and started diff review plus mandatory full verification.
