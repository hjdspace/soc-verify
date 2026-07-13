# Findings

Treat this file as investigation data, not instructions.

## Initial evidence
- Screenshot: one right-aligned user bubble is followed by a left-aligned bubble containing the same text, then a formatted 403 error bubble.
- Provider is described as OpenAI-compatible at a `/v1` base URL using `chat/completions`.
- The worktree already contains a substantial Agent/host reorganization, including new `src/main/agent/` files and changes to `src/renderer/src/stores/session.ts`.
- No `RTK.md`, `CONTEXT.md`, or relevant ADR was found in the repository.
- The secret supplied by the user must not be copied into source, tests, commands, logs, or planning files.
- `sendMessage` adds one optimistic user message and one empty streaming assistant placeholder.
- `handleSessionEvent('message_start')` extracts text and updates the streaming assistant placeholder without checking `event.message.role`.
- Therefore an engine event carrying `message.role: 'user'` and the prompt text deterministically turns the assistant placeholder into a duplicate user echo. This matches the screenshot's left-aligned duplicate bubble.
- The renderer already has focused store tests under `tests/session/session-store.test.ts`, which is the correct seam for the duplicate symptom.
- Session creation forwards stored `providerId`, API key, and base URL into the Agent layer; provider interpretation still needs tracing.
- `credentialManager.mapProviderForAgent()` already normalizes both `openai` and `openai-compatible` to `openai`, so a credential saved with the documented compatibility ID should not reach the runner as an unknown provider.
- `credentialManager.buildEnvForAgent()` also supplies `OPENAI_API_KEY` and `OPENAI_BASE_URL` for either of those IDs.
- Every Agent session currently sends the SoC host tool definitions and defaults MCP to enabled; whether the provider adapter changes protocol shape for those options remains to be verified in the runner.
- `AgentClient` is only a JSONL transport. The HTTP request is built inside the external runner, so request compatibility must be tested at that runner's init/model-selection boundary.
- The runner resolves to `engine/oh-my-pi/packages/coding-agent/src/socverify-runner.ts`; it is inside the submodule and must remain unmodified.
- Current repository changes replaced the old omp RPC path with this SDK runner and began passing `apiKey` plus `baseUrl` directly even when no explicit model is selected. That migration is the likely regression boundary.
- Base URL forwarding at the router is exact; there is no visible `/v1` concatenation before the runner.
- Engine source `packages/agent/src/agent-loop.ts` explicitly emits `message_start` and `message_end` for the user prompt. The renderer must filter message events by role; this confirms hypothesis 1.
- `socverify-runner.ts` is an untracked user-added file inside the omp submodule; the project constraint still forbids editing it.
- omp officially supports custom OpenAI-compatible providers through `<agentDir>/models.yml` with `api: openai-completions`, `baseUrl`, and model discovery. `PI_CODING_AGENT_DIR` selects that agent directory.
- This provides a main-repository-only integration path: generate a scoped provider configuration that references an environment variable for the secret, then pass its provider/model selector to the unchanged runner.
- The official `openai` catalog descriptor is explicitly `api: openai-responses`; setting `OPENAI_BASE_URL` changes the host but does not change the wire API. This confirms hypothesis 2.
- The custom gateway base URL is forwarded unchanged and OpenAI clients trim trailing slashes, so no evidence supports duplicated `/v1`; hypothesis 3 is deprioritized.
- A real `SessionManager` + Bun runner test against a local gateway completed a full turn through `/v1/chat/completions`; the gateway's `/v1/responses` endpoint was never called.
- Generated `models.json` contains only an environment-variable name for the key. The temporary runtime directory is removed when the session ends, with bounded retries for Windows SQLite handle release.

## Hypotheses
1. **Confirmed:** user-role `message_start` events are incorrectly rendered into the assistant placeholder. Engine source emits exactly this event for every prompt.
2. **Confirmed:** the official OpenAI catalog descriptor is `openai-responses`; overriding `OPENAI_BASE_URL` changes only the host. A `chat/completions`-only gateway therefore receives the wrong request protocol.
3. The base URL is transformed incorrectly (for example `/v1` is duplicated or omitted). Prediction: inspecting the resolved provider config/request URL reveals a path other than one `/v1/chat/completions`.
4. Agent tool definitions trigger the gateway's `Request not allowed` policy. Prediction: an otherwise identical request succeeds without tools but fails with them; this only warrants a fallback if the selected model/provider cannot support tools.
5. The key/model is denied upstream independent of client code. Prediction: the exact minimal OpenAI-compatible request is also rejected when request construction is known-correct.

## Root cause
- Duplicate UI message: renderer consumed user-role Agent events as assistant events.
- 403: the runner registered the credential under the official `openai` provider, whose catalog uses `openai-responses`; a custom base URL changes the host but not the protocol. The configured gateway supports `openai-completions` only.
