/**
 * LSP 协议类型（slang-server stdio LSP 桥接用）。
 *
 * 仅覆盖 MVP 三能力（诊断 / hover / 跳转）所需的 JSON-RPC 2.0 + LSP 子集。
 * 补全 / references 为第二波，不在本票范围。
 *
 * 参考：S0 spike lsp-probe.js 真实帧协议验证。
 */

// ─── JSON-RPC 2.0 基础 ──────────────────────────────────────

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** LSP server → client 的任意消息（response 或 notification） */
export type LspServerMessage = JsonRpcResponse | JsonRpcNotification;

// ─── LSP 位置与范围 ─────────────────────────────────────────

export type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

export type LspLocation = {
  uri: string;
  range: LspRange;
};

// ─── 诊断 ──────────────────────────────────────────────────

export type LspDiagnostic = {
  range: LspRange;
  severity: LspDiagnosticSeverity;
  code?: number | string;
  source?: string;
  message: string;
};

export type LspDiagnosticSeverity = 1 | 2 | 3 | 4;

export type PublishDiagnosticsParams = {
  uri: string;
  diagnostics: LspDiagnostic[];
};

// ─── Hover ─────────────────────────────────────────────────

export type LspHover = {
  contents:
    | { kind: 'markdown'; value: string }
    | { kind: 'plaintext'; value: string }
    | string
    | string[];
  range?: LspRange;
} | null;

// ─── Bridge 对外类型 ────────────────────────────────────────

/** Bridge 诊断推送给渲染端的简化结构（LSP severity → 语义字符串） */
export type BridgeDiagnostic = {
  uri: string;
  range: LspRange;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: number | string;
};

/** Bridge hover 推送给渲染端的简化结构 */
export type BridgeHover = {
  contents: string;
  range?: LspRange;
} | null;

/** Bridge 跳转定义推送给渲染端的简化结构 */
export type BridgeDefinition = LspLocation[];

/** LSP 进程状态 */
export type LspStatus = {
  running: boolean;
  slangServerPath: string | null;
  initialized: boolean;
};

/** severity 数值 → 语义字符串 */
export function severityLabel(s: LspDiagnosticSeverity): BridgeDiagnostic['severity'] {
  switch (s) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
  }
}
