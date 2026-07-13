# Agent chat 403 and duplicate-message diagnosis

## Goal
Make the configured OpenAI-compatible provider support a normal Agent conversation without replaying the user's message or returning a request-shape-related 403.

## Success criteria
- A fast deterministic regression command catches the duplicate-message and provider-request symptoms.
- The regression test fails before the fix and passes after it.
- The original send path is verified against the repaired behavior.
- `npm run build`, `npm run typecheck`, and `npm run test` pass in that order.

## Phases
1. **Feedback loop** - complete
   - Trace renderer message state, main-process Agent session, and provider request construction.
   - Build the smallest red-capable test at the real call boundary.
2. **Reproduce and hypothesize** - complete
   - Reproduce deterministically and rank 3-5 falsifiable causes.
3. **Fix and regress** - complete
   - Add the regression test, apply the smallest root-cause fix, and rerun the focused loop.
4. **Full verification and cleanup** - in progress
   - Remove diagnostic artifacts and run build, typecheck, then test.

## Constraints
- Preserve all pre-existing worktree changes.
- Do not modify `engine/oh-my-pi` source.
- Never write or print the user's API key.

## Errors encountered
| Error | Attempt | Resolution |
|---|---:|---|
| Initial parallel read failed because `RTK.md` does not exist | 1 | Retried with existence checks; confirmed no RTK/CONTEXT/ADR is available. |
| First skill read took about 46 seconds | 1 | Waited for the existing process; no repeated command. |
| Runner search batch had a PowerShell quote parse error | 1 | Replaced double-quoted regex with PowerShell single-quoted patterns. |
| Corrected parallel search batch aborted because one filtered `rg` returned exit 1 | 1 | Switched to narrow, independent file reads so an empty search cannot hide other outputs. |
| Focused test command hit PowerShell's disabled `npm.ps1` policy | 1 | Use `npm.cmd` for repository scripts on this Windows host. |
| Actual runner integration could not write `~/.omp/logs` in the sandbox | 1 | Isolate the embedded runner's XDG state under its temporary runtime directory. |
| Windows omp ignored `XDG_STATE_HOME` and still targeted the sandboxed home | 2 | Override `HOME`/`USERPROFILE` only in the integration harness, not production. |
| Successful runner test hit `EBUSY` deleting the just-closed SQLite sidecar | 1 | Use Node's bounded `rm` retry options for Windows handle-release latency. |
| A parallel verification batch again aborted on an empty `rg` result | 1 | Keep optional searches out of fail-fast parallel batches. |
