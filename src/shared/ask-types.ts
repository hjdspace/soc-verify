/**
 * Shared types for the `ask` interactive question tool.
 *
 * The `ask` tool is registered as a custom host tool so the omp engine routes
 * tool calls to the SoC Verify host process. The host intercepts the call,
 * emits an `askRequest` event to the renderer, and waits for the user to
 * submit answers via `resolveAsk`.
 */

/** A single selectable option in a question. */
export type AskOption = {
  label: string;
  description?: string;
};

/** A question posed to the user by the AI. */
export type AskQuestion = {
  id: string;
  question: string;
  options: AskOption[];
  /** Allow multiple selections (checkboxes instead of radio). */
  multi?: boolean;
  /** Index of the recommended option (0-based). */
  recommended?: number;
};

/** The user's answer to a single question. */
export type AskAnswer = {
  questionId: string;
  /** Selected option labels (empty when customInput is used). */
  selectedOptions: string[];
  /** Free-text answer when the user chose "Other". */
  customInput?: string;
};

/** Payload emitted via `askRequest` event → renderer. */
export type AskRequestPayload = {
  sessionId: string;
  requestId: string;
  questions: AskQuestion[];
};

/** Payload sent back via `resolveAsk` tRPC procedure. */
export type AskResolvePayload = {
  requestId: string;
  answers: AskAnswer[];
};
