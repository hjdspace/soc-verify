/**
 * LSP Bridge — slang-server stdio JSON-RPC 桥（ADR 0032 决策 20 / issue 06）。
 *
 * 主进程 spawn slang-server（hudson-trading/slang-server，stdio LSP），
 * 桥接渲染端 CodeMirror 6：
 *   - didOpen → 诊断推送（publishDiagnostics → onDiagnostics 回调）
 *   - hover → 符号类型/文档
 *   - definition → 跳转定义（跨文件）
 *
 * MVP 三能力：诊断 + hover + 跳转。补全 / references 为第二波，不在本票。
 *
 * LSP 进程生命周期受管理（Design Source 变更后 restart 生效，关闭/切换不泄漏）。
 * S0 spike lsp-probe.js 是真实帧协议的参考来源。
 *
 * 代码归属 src/main/rtl/lsp-bridge.ts（ADR 0032 决策 22）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveSlangServerPath } from './binary';
import {
  severityLabel,
  type BridgeDefinition,
  type BridgeDiagnostic,
  type BridgeHover,
  type LspLocation,
  type LspServerMessage,
} from './lsp-types';

const LSP_TIMEOUT_MS = 30_000;

/** LspBridge 构造选项 */
export type LspBridgeOptions = {
  /** 项目根目录（workspaceFolders rootUri 基准） */
  projectRoot: string;
  /** Design Source .f 文件列表（编译选项共享；slang-server Build File 模式预留） */
  filelists: string[];
};

/** 诊断回调类型 */
export type DiagnosticsHandler = (params: { uri: string; diagnostics: BridgeDiagnostic[] }) => void;

/**
 * slang-server stdio LSP 桥。
 *
 * 协议：JSON-RPC 2.0 over stdio，Content-Length 帧格式。
 * 生命周期：start() → initialize/initialized 握手 → didOpen/didChange/hover/definition
 * → shutdown() → shutdown + exit 通知 + kill。
 *
 * restart() = shutdown 旧进程 + start 新进程（Design Source 变更后重建编译选项）。
 */
export class LspBridge {
  private readonly projectRoot: string;
  private filelists: string[];

  private child: ChildProcessWithoutNullStreams | null = null;
  private slangServerPath: string | null = null;
  private initialized = false;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private diagnosticsHandlers = new Set<DiagnosticsHandler>();
  private rxBuffer = Buffer.alloc(0);

  constructor(opts: LspBridgeOptions) {
    this.projectRoot = opts.projectRoot;
    this.filelists = opts.filelists;
  }

  // ─── 生命周期 ──────────────────────────────────────────────

  /**
   * 启动 slang-server 并完成 initialize → initialized 握手。
   * @returns 初始化完成的 Promise（slang-server 不可用时返回 null）
   */
  start(): Promise<void | null> {
    this.slangServerPath = resolveSlangServerPath();
    if (!this.slangServerPath) return Promise.resolve(null);

    const child = spawn(this.slangServerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => {
      this.onStdoutData(chunk);
    });
    child.stderr.on('data', () => {
      // stderr 忽略（slang-server 调试日志）
    });
    child.on('exit', () => {
      this.initialized = false;
      // 拒绝所有 pending 请求
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('slang-server 进程退出'));
      }
      this.pending.clear();
    });

    // 发送 initialize 请求
    const initPromise = this.sendRequest('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.projectRoot).toString(),
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: false },
        },
      },
      workspaceFolders: [
        {
          uri: pathToFileURL(this.projectRoot).toString(),
          name: this.projectRoot.split(/[\\/]/).pop() ?? 'project',
        },
      ],
    });

    return (async () => {
      try {
        await initPromise;
        this.initialized = true;
        this.sendNotification('initialized', {});
      } catch {
        // initialize 失败不抛出（bridge 仍可用，diagnostics/hover/definition 会 reject）
      }
    })();
  }

  /**
   * 重启 LSP 进程（Design Source 变更后重建编译选项）。
   * 关闭旧进程 → 用新选项启动新进程。
   */
  async restart(opts: LspBridgeOptions): Promise<void> {
    await this.shutdown();
    this.filelists = opts.filelists;
    await this.start();
  }

  /** 关闭 LSP 进程：shutdown → exit → kill */
  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;

    try {
      await this.sendRequest('shutdown', undefined).catch(() => undefined);
      this.sendNotification('exit', undefined);
    } finally {
      try {
        child.kill();
      } catch {
        // kill 失败忽略
      }
      this.child = null;
      this.initialized = false;
      this.rxBuffer = Buffer.alloc(0);
    }
  }

  // ─── 文档同步 ──────────────────────────────────────────────

  /** textDocument/didOpen — 打开文件（languageId 固定 systemverilog） */
  didOpen(params: { uri: string; text: string; version: number }): void {
    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: params.uri,
        languageId: 'systemverilog',
        version: params.version,
        text: params.text,
      },
    });
  }

  /** textDocument/didChange — 全量文本替换（slang-server 不支持增量 range） */
  didChange(params: { uri: string; text: string; version: number }): void {
    this.sendNotification('textDocument/didChange', {
      textDocument: { uri: params.uri, version: params.version },
      contentChanges: [{ text: params.text }],
    });
  }

  // ─── LSP 能力 ──────────────────────────────────────────────

  /** textDocument/hover — 悬停符号信息 */
  async hover(params: { uri: string; position: { line: number; character: number } }): Promise<BridgeHover> {
    const result = await this.sendRequest('textDocument/hover', {
      textDocument: { uri: params.uri },
      position: params.position,
    });
    return mapHover(result);
  }

  /** textDocument/definition — 跳转定义（跨文件） */
  async definition(params: { uri: string; position: { line: number; character: number } }): Promise<BridgeDefinition> {
    const result = await this.sendRequest('textDocument/definition', {
      textDocument: { uri: params.uri },
      position: params.position,
    });
    return mapDefinition(result);
  }

  // ─── 诊断推送 ──────────────────────────────────────────────

  /** 注册诊断回调（publishDiagnostics → onDiagnostics） */
  onDiagnostics(handler: DiagnosticsHandler): () => void {
    this.diagnosticsHandlers.add(handler);
    return () => this.diagnosticsHandlers.delete(handler);
  }

  // ─── 状态查询 ──────────────────────────────────────────────

  isRunning(): boolean {
    return this.child !== null;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getStatus(): { running: boolean; slangServerPath: string | null; initialized: boolean } {
    return {
      running: this.child !== null,
      slangServerPath: this.slangServerPath,
      initialized: this.initialized,
    };
  }

  // ─── JSON-RPC 协议层 ───────────────────────────────────────

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('slang-server 未启动'));
    const id = ++this.nextId;

    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`LSP 请求超时: ${method} (${LSP_TIMEOUT_MS}ms)`));
      }, LSP_TIMEOUT_MS);

      // 先注册 pending 再写 stdin：fake server 可能同步回响应，
      // 此时 handler 需能在 pending map 中找到 id。
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
      child.stdin.write(frame);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const child = this.child;
    if (!child) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    child.stdin.write(frame);
  }

  /** 处理 stdout 数据：按 Content-Length 帧切分解析（Buffer 级，正确处理多字节 UTF-8） */
  private onStdoutData(chunk: Buffer): void {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    let idx: number;
    while ((idx = this.rxBuffer.indexOf('\r\n\r\n')) !== -1) {
      const header = this.rxBuffer.subarray(0, idx).toString('utf-8');
      const m = /Content-Length: (\d+)/i.exec(header);
      if (!m) {
        this.rxBuffer = this.rxBuffer.subarray(idx + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const bodyStart = idx + 4;
      if (this.rxBuffer.length < bodyStart + len) break;
      const body = this.rxBuffer.subarray(bodyStart, bodyStart + len).toString('utf-8');
      this.rxBuffer = this.rxBuffer.subarray(bodyStart + len);
      try {
        const msg = JSON.parse(body) as LspServerMessage;
        this.handleServerMessage(msg);
      } catch {
        // JSON 解析失败忽略（不完整帧等）
      }
    }
  }

  /** 分发 server → client 消息 */
  private handleServerMessage(msg: LspServerMessage): void {
    // Response（有 id 且在 pending 中）
    if ('id' in msg && msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error((msg.error as { message: string }).message ?? 'LSP error'));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Notification（有 method）
    if ('method' in msg && msg.method) {
      if (msg.method === 'textDocument/publishDiagnostics') {
        const params = msg.params as { uri: string; diagnostics: Array<{ range: unknown; severity: number; message: string; source?: string; code?: number | string }> };
        const diags: BridgeDiagnostic[] = (params?.diagnostics ?? []).map((d) => ({
          uri: params.uri,
          range: d.range as BridgeDiagnostic['range'],
          severity: severityLabel(d.severity as 1 | 2 | 3 | 4),
          message: d.message,
          source: d.source,
          code: d.code,
        }));
        for (const handler of this.diagnosticsHandlers) {
          handler({ uri: params.uri, diagnostics: diags });
        }
      }
    }
  }
}

// ─── 响应映射 ────────────────────────────────────────────────

/** LSP hover result → BridgeHover */
function mapHover(result: unknown): BridgeHover {
  if (!result) return null;
  const h = result as {
    contents:
      | { kind: string; value: string }
      | string
      | string[];
    range?: unknown;
  };
  let contents: string;
  if (typeof h.contents === 'string') {
    contents = h.contents;
  } else if (Array.isArray(h.contents)) {
    contents = h.contents.join('\n');
  } else if (h.contents && typeof h.contents === 'object' && 'value' in h.contents) {
    contents = h.contents.value;
  } else {
    contents = JSON.stringify(h.contents);
  }
  return {
    contents,
    range: h.range as BridgeHover extends { range?: infer R } ? R : never,
  };
}

/** LSP definition result → BridgeDefinition（Location | Location[]） */
function mapDefinition(result: unknown): BridgeDefinition {
  if (!result) return [];
  if (Array.isArray(result)) {
    return result.map((r) => r as LspLocation);
  }
  return [result as LspLocation];
}
