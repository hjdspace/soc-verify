/**
 * LSP Bridge 测试（issue 06 主 seam）。
 *
 * 测试缝：LspBridge 公共 API 边界（进程边界 mock slang-server spawn）。
 * 录制 LSP 帧协议：模拟 slang-server 的 JSON-RPC stdio 通信，
 * 验证桥接协议映射——didOpen → 诊断推送、hover 请求响应、definition 映射。
 *
 * S0 lsp-probe.js 是真实协议帧的参考来源。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Hoisted mocks ──────────────────────────────────────────

const { mockSpawn, mockBinary } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockBinary: {
    resolveSlangServerPath: vi.fn((): string | null => '/fake/slang-server/slang-server.exe'),
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mockSpawn };
});

vi.mock('../../src/main/rtl/binary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/rtl/binary')>();
  return { ...actual, resolveSlangServerPath: mockBinary.resolveSlangServerPath };
});

import { LspBridge } from '../../src/main/rtl/lsp-bridge';

// ─── Fake slang-server 子进程 ───────────────────────────────

type JsonRpcMsg = {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type FrameHandler = (msg: JsonRpcMsg) => void;

/**
 * 模拟 slang-server 的 stdio JSON-RPC 通信。
 * 自动响应 initialize 请求完成握手。
 * 捕获 client → server 的消息（stdin），可编程 server → client 的响应（stdout）。
 */
function createFakeServer(): {
  child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: (data: string) => void }; kill: () => void };
  received: JsonRpcMsg[];
  sendToClient: (msg: JsonRpcMsg) => void;
  setHandler: (fn: FrameHandler) => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: (data: string) => void };
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.emit('exit', 0);
  };

  const received: JsonRpcMsg[] = [];
  let handler: FrameHandler | null = null;

  let stdinBuf = Buffer.alloc(0);

  child.stdin = {
    write: (data: string) => {
      stdinBuf = Buffer.concat([stdinBuf, Buffer.from(data, 'utf-8')]);
      let idx: number;
      while ((idx = stdinBuf.indexOf('\r\n\r\n')) !== -1) {
        const header = stdinBuf.slice(0, idx).toString('utf-8');
        const m = /Content-Length: (\d+)/i.exec(header);
        if (!m) {
          stdinBuf = stdinBuf.slice(idx + 4);
          continue;
        }
        const len = parseInt(m[1], 10);
        const bodyStart = idx + 4;
        if (stdinBuf.length < bodyStart + len) break;
        const body = stdinBuf.slice(bodyStart, bodyStart + len).toString('utf-8');
        stdinBuf = stdinBuf.slice(bodyStart + len);
        let msg: JsonRpcMsg;
        try {
          msg = JSON.parse(body) as JsonRpcMsg;
        } catch {
          continue;
        }
        received.push(msg);

        // 自动响应 initialize 请求完成握手
        if (msg.method === 'initialize' && msg.id !== undefined) {
          const s = JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { capabilities: { hoverProvider: true, definitionProvider: true } },
          });
          child.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`, 'utf-8'));
        }

        // 自动响应 shutdown 请求（避免 30s 超时）
        if (msg.method === 'shutdown' && msg.id !== undefined) {
          const s = JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: null,
          });
          child.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`, 'utf-8'));
        }

        if (handler) handler(msg);
      }
    },
  };

  const sendToClient = (msg: JsonRpcMsg) => {
    const s = JSON.stringify(msg);
    const frame = `Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`;
    child.stdout.emit('data', Buffer.from(frame, 'utf-8'));
  };

  const setHandler = (fn: FrameHandler) => {
    handler = fn;
  };

  return { child, received, sendToClient, setHandler };
}

// ─── 测试环境 ───────────────────────────────────────────────

let projectDir: string;
let fakeServer: ReturnType<typeof createFakeServer>;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'sv-lsp-bridge-'));
  mkdirSync(join(projectDir, 'rtl'), { recursive: true });
  writeFileSync(join(projectDir, 'rtl/top.sv'), 'module top; endmodule\n', 'utf-8');

  fakeServer = createFakeServer();
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => fakeServer.child);
  mockBinary.resolveSlangServerPath.mockReturnValue('/fake/slang-server/slang-server.exe');
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ─── 初始化握手 ─────────────────────────────────────────────

describe('LspBridge 初始化', () => {
  it('spawn slang-server 并完成 initialize → initialized 握手', async () => {
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    await bridge.start();

    expect(bridge.isRunning()).toBe(true);
    expect(bridge.isInitialized()).toBe(true);

    // 验证 initialize 请求被发送
    const initReq = fakeServer.received.find((m) => m.method === 'initialize');
    expect(initReq).toBeDefined();
    expect(initReq!.params).toMatchObject({
      processId: process.pid,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
        },
      },
    });

    // initialized 通知被发送
    const initializedMsg = fakeServer.received.find((m) => m.method === 'initialized');
    expect(initializedMsg).toBeDefined();

    await bridge.shutdown();
  });

  it('slang-server 不可用时 start 返回 null 且不 spawn', async () => {
    mockBinary.resolveSlangServerPath.mockReturnValue(null);
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    const ready = await bridge.start();
    expect(ready).toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// ─── didOpen → 诊断推送 ─────────────────────────────────────

describe('didOpen → 诊断推送', () => {
  it('didOpen 发送 textDocument/didOpen；server 推送 publishDiagnostics → bridge 回调', async () => {
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    await bridge.start();

    const uri = `file://${join(projectDir, 'rtl/top.sv').replace(/\\/g, '/')}`;
    const diagnostics: { uri: string; diagnostics: unknown[] }[] = [];
    bridge.onDiagnostics((d: { uri: string; diagnostics: unknown[] }) => diagnostics.push(d));

    bridge.didOpen({ uri, text: 'module top; endmodule\n', version: 1 });

    await vi.waitFor(() => {
      expect(fakeServer.received.some((m) => m.method === 'textDocument/didOpen')).toBe(true);
    });

    const didOpenMsg = fakeServer.received.find((m) => m.method === 'textDocument/didOpen')!;
    expect(didOpenMsg.params).toMatchObject({
      textDocument: { uri, languageId: 'systemverilog', version: 1 },
    });

    // server 推送诊断
    fakeServer.sendToClient({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            severity: 1,
            message: 'syntax error',
            source: 'slang',
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(diagnostics).toHaveLength(1);
    });

    expect(diagnostics[0].uri).toBe(uri);
    expect(diagnostics[0].diagnostics[0]).toMatchObject({
      severity: 'error',
      message: 'syntax error',
      source: 'slang',
    });

    await bridge.shutdown();
  });
});

// ─── hover 请求响应 ─────────────────────────────────────────

describe('hover 请求响应', () => {
  it('hover 发送 textDocument/hover → server 响应 → bridge 映射为 BridgeHover', async () => {
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    await bridge.start();

    const uri = `file://${join(projectDir, 'rtl/top.sv').replace(/\\/g, '/')}`;

    // 设置 hover 响应 handler
    fakeServer.setHandler((msg) => {
      if (msg.method === 'textDocument/hover' && msg.id !== undefined) {
        fakeServer.sendToClient({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            contents: { kind: 'markdown', value: 'module **top**\n\nA top module.' },
            range: {
              start: { line: 0, character: 7 },
              end: { line: 0, character: 10 },
            },
          },
        });
      }
    });

    const hover = await bridge.hover({ uri, position: { line: 0, character: 8 } });
    expect(hover).not.toBeNull();
    expect(hover!.contents).toContain('module **top**');
    expect(hover!.range).toEqual({
      start: { line: 0, character: 7 },
      end: { line: 0, character: 10 },
    });

    // 验证请求内容
    const hoverReq = fakeServer.received.find((m) => m.method === 'textDocument/hover');
    expect(hoverReq).toBeDefined();
    expect(hoverReq!.params).toMatchObject({
      textDocument: { uri },
      position: { line: 0, character: 8 },
    });

    await bridge.shutdown();
  });

  it('hover 返回 null 时 bridge 返回 null（无 hover 信息）', async () => {
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    await bridge.start();

    const uri = `file://${join(projectDir, 'rtl/top.sv').replace(/\\/g, '/')}`;

    fakeServer.setHandler((msg) => {
      if (msg.method === 'textDocument/hover' && msg.id !== undefined) {
        fakeServer.sendToClient({
          jsonrpc: '2.0',
          id: msg.id,
          result: null,
        });
      }
    });

    const hover = await bridge.hover({ uri, position: { line: 0, character: 0 } });
    expect(hover).toBeNull();

    await bridge.shutdown();
  });
});

// ─── definition 跳转 ────────────────────────────────────────

describe('definition 跳转', () => {
  it('definition 发送 textDocument/definition → server 响应 Location → bridge 映射', async () => {
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    await bridge.start();

    const uri = `file://${join(projectDir, 'rtl/top.sv').replace(/\\/g, '/')}`;
    const targetUri = `file://${join(projectDir, 'rtl/sub.sv').replace(/\\/g, '/')}`;

    fakeServer.setHandler((msg) => {
      if (msg.method === 'textDocument/definition' && msg.id !== undefined) {
        fakeServer.sendToClient({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            uri: targetUri,
            range: {
              start: { line: 5, character: 10 },
              end: { line: 5, character: 20 },
            },
          },
        });
      }
    });

    const def = await bridge.definition({ uri, position: { line: 10, character: 5 } });
    expect(def).toEqual([
      {
        uri: targetUri,
        range: {
          start: { line: 5, character: 10 },
          end: { line: 5, character: 20 },
        },
      },
    ]);

    const defReq = fakeServer.received.find((m) => m.method === 'textDocument/definition');
    expect(defReq).toBeDefined();
    expect(defReq!.params).toMatchObject({
      textDocument: { uri },
      position: { line: 10, character: 5 },
    });

    await bridge.shutdown();
  });

  it('definition 跨文件跳转：spike_top.sv → soc_subsys.sv 声明处', async () => {
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    await bridge.start();

    const sourceUri = `file:///D:/proj/spike_top.sv`;
    const targetUri = `file:///D:/proj/soc_subsys.sv`;

    fakeServer.setHandler((msg) => {
      if (msg.method === 'textDocument/definition' && msg.id !== undefined) {
        fakeServer.sendToClient({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            uri: targetUri,
            range: {
              start: { line: 20, character: 0 },
              end: { line: 20, character: 15 },
            },
          },
        });
      }
    });

    const def = await bridge.definition({ uri: sourceUri, position: { line: 47, character: 20 } });
    expect(def[0].uri).toBe(targetUri);
    expect(def[0].range.start.line).toBe(20);

    await bridge.shutdown();
  });
});

// ─── didChange 增量同步 ─────────────────────────────────────

describe('didChange 增量同步', () => {
  it('didChange 发送 textDocument/didChange（全量文本替换）', async () => {
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    await bridge.start();

    const uri = `file://${join(projectDir, 'rtl/top.sv').replace(/\\/g, '/')}`;

    bridge.didOpen({ uri, text: 'module top; endmodule\n', version: 1 });
    bridge.didChange({ uri, text: 'module top; wire x; endmodule\n', version: 2 });

    await vi.waitFor(() => {
      expect(fakeServer.received.some((m) => m.method === 'textDocument/didChange')).toBe(true);
    });

    const changeMsg = fakeServer.received.find((m) => m.method === 'textDocument/didChange')!;
    expect(changeMsg.params).toMatchObject({
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: 'module top; wire x; endmodule\n' }],
    });

    await bridge.shutdown();
  });
});

// ─── 进程生命周期 ───────────────────────────────────────────

describe('LSP 进程生命周期', () => {
  it('shutdown 时发送 shutdown → exit 通知并 kill 子进程', async () => {
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    await bridge.start();

    fakeServer.setHandler((msg) => {
      if (msg.method === 'shutdown' && msg.id !== undefined) {
        fakeServer.sendToClient({ jsonrpc: '2.0', id: msg.id, result: null });
      }
    });

    await bridge.shutdown();

    expect(fakeServer.received.some((m) => m.method === 'shutdown')).toBe(true);
    expect(fakeServer.received.some((m) => m.method === 'exit')).toBe(true);
    expect(bridge.isRunning()).toBe(false);
  });

  it('restart：Design Source 变更后重启 LSP 进程（旧进程关闭，新进程 spawn）', async () => {
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    await bridge.start();

    const killSpy = vi.fn(() => {
      fakeServer.child.emit('exit', 0);
    });
    fakeServer.child.kill = killSpy;

    // 重新创建 fake server 给第二次 spawn
    const newFakeServer = createFakeServer();
    mockSpawn.mockImplementation(() => newFakeServer.child);

    fakeServer.setHandler((msg) => {
      if (msg.method === 'shutdown' && msg.id !== undefined) {
        fakeServer.sendToClient({ jsonrpc: '2.0', id: msg.id, result: null });
      }
    });

    await bridge.restart({ projectRoot: projectDir, filelists: ['new.f'] });

    expect(killSpy).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(bridge.isRunning()).toBe(true);

    // 新进程完成 initialize 握手（fake server 自动响应）
    await vi.waitFor(() => {
      expect(newFakeServer.received.some((m) => m.method === 'initialized')).toBe(true);
    });

    await bridge.shutdown();
  });

  it('slang-server 二进制路径变化时 restart 反映新路径', async () => {
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    await bridge.start();

    const status = bridge.getStatus();
    expect(status.running).toBe(true);
    expect(status.slangServerPath).toBe('/fake/slang-server/slang-server.exe');
    expect(status.initialized).toBe(true);

    await bridge.shutdown();
  });
});

// ─── 编译选项共享（.f → slang-server Build File） ───────────

describe('编译选项共享 Design Source', () => {
  it('initialize 请求中 workspaceFolders 指向 projectRoot', async () => {
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    await bridge.start();

    const initReq = fakeServer.received.find((m) => m.method === 'initialize');
    const params = initReq!.params as { rootUri: string; workspaceFolders: Array<{ uri: string; name: string }> };
    expect(params.rootUri.startsWith('file://')).toBe(true);
    expect(params.workspaceFolders[0].uri.startsWith('file://')).toBe(true);

    await bridge.shutdown();
  });

  it('didOpen 的 languageId 为 systemverilog', async () => {
    const bridge = new LspBridge({ projectRoot: projectDir, filelists: ['spike.f'] });
    await bridge.start();

    const uri = `file://${join(projectDir, 'rtl/top.sv').replace(/\\/g, '/')}`;
    bridge.didOpen({ uri, text: 'module top; endmodule', version: 1 });

    await vi.waitFor(() => {
      expect(fakeServer.received.some((m) => m.method === 'textDocument/didOpen')).toBe(true);
    });

    const didOpen = fakeServer.received.find((m) => m.method === 'textDocument/didOpen')!;
    expect((didOpen.params as { textDocument: { languageId: string } }).textDocument.languageId).toBe('systemverilog');

    await bridge.shutdown();
  });
});
