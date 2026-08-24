/**
 * RunnerContext — shared mutable state passed to all handler modules.
 *
 * Runner is single-process single-threaded; no concurrency guards needed.
 * Each handler receives the context and reads/writes its properties directly,
 * mirroring the original module-level `let` variables.
 */

import type { ApprovalMode } from "./approval-logic";

export interface RunnerContext {
	/** omp session reference (null before init / after destroy) */
	session: unknown;
	/** Event subscription unsubscribe function (null when no active session) */
	unsubscribe: (() => void) | null;
	/** Current working directory (set on init) */
	currentCwd: string;
	/** Current approval mode (updated by init + setApprovalMode) */
	currentApprovalMode: ApprovalMode;
	/** Currently disabled tool names (updated by init + setToolFilter) */
	currentDisabledTools: Set<string>;
	/** Snapshot of original tools before wrapping (for mode switching) */
	originalTools: unknown[] | null;
	/** Forward a tool call to the Electron host and await its result */
	callHostTool: (toolName: string, args: unknown) => Promise<unknown>;
	/** Request user approval for a tool call (resolves true/false) */
	requestApproval: (toolName: string, args: unknown) => Promise<boolean>;
}
