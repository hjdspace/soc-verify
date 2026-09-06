/**
 * LSP Manager — per-project LspBridge 生命周期管理与诊断广播。
 *
 * 职责：
 *   - per-project LspBridge 单例缓存（Design Source 配置驱动）
 *   - 诊断推送通过原生 IPC 广播到渲染端（lsp:diagnostics 通道）
 *   - Design Source 变更后 restart（编译选项共享，不泄漏旧进程）
 *
 * 对齐 broadcast.ts 模式（ADR 0032 决策 22 代码归属 src/main/rtl/）。
 */

import { broadcastToWindows } from '../ipc/broadcast';
import { loadDesignConfig } from './design-service';
import { LspBridge, type LspBridgeOptions } from './lsp-bridge';
import type { BridgeDefinition, BridgeDiagnostic, BridgeHover } from './lsp-types';

/** 诊断广播 IPC 通道名 */
export const LSP_DIAGNOSTICS_CHANNEL = 'lsp:diagnostics';

const bridgeCache = new Map<string, LspBridge>();

/**
 * 获取或创建 per-project LspBridge。
 * 首次调用按 Design Source 配置启动 slang-server；
 * 后续调用复用缓存实例。
 */
function getBridge(projectId: string, projectRoot: string): LspBridge {
  let bridge = bridgeCache.get(projectId);
  if (!bridge) {
    const config = loadDesignConfig(projectRoot);
    const opts: LspBridgeOptions = {
      projectRoot,
      filelists: config.filelists,
    };
    bridge = new LspBridge(opts);
    bridge.onDiagnostics((params) => {
      broadcastToWindows(LSP_DIAGNOSTICS_CHANNEL, { projectId, ...params });
    });
    bridgeCache.set(projectId, bridge);
  }
  return bridge;
}

/** 启动 LSP 进程（slang-server 不可用时返回 null） */
export async function startLsp(projectId: string, projectRoot: string): Promise<{ running: boolean; initialized: boolean } | null> {
  const bridge = getBridge(projectId, projectRoot);
  const result = await bridge.start();
  if (result === null) return null;
  return bridge.getStatus();
}

/** textDocument/didOpen — 打开 .sv 文件 */
export function lspDidOpen(projectId: string, projectRoot: string, params: { uri: string; text: string; version: number }): void {
  const bridge = getBridge(projectId, projectRoot);
  bridge.didOpen(params);
}

/** textDocument/didChange — 全量文本替换 */
export function lspDidChange(projectId: string, projectRoot: string, params: { uri: string; text: string; version: number }): void {
  const bridge = getBridge(projectId, projectRoot);
  bridge.didChange(params);
}

/** textDocument/hover — 悬停符号信息 */
export async function lspHover(projectId: string, projectRoot: string, params: { uri: string; position: { line: number; character: number } }): Promise<BridgeHover> {
  const bridge = getBridge(projectId, projectRoot);
  return bridge.hover(params);
}

/** textDocument/definition — 跳转定义（跨文件） */
export async function lspDefinition(projectId: string, projectRoot: string, params: { uri: string; position: { line: number; character: number } }): Promise<BridgeDefinition> {
  const bridge = getBridge(projectId, projectRoot);
  return bridge.definition(params);
}

/** 关闭 LSP 进程 */
export async function stopLsp(projectId: string): Promise<void> {
  const bridge = bridgeCache.get(projectId);
  if (!bridge) return;
  await bridge.shutdown();
  bridgeCache.delete(projectId);
}

/**
 * 重启 LSP 进程（Design Source 变更后重建编译选项）。
 * 用新配置 shutdown 旧进程 + start 新进程。
 */
export async function restartLsp(projectId: string, projectRoot: string): Promise<{ running: boolean; initialized: boolean } | null> {
  const bridge = getBridge(projectId, projectRoot);
  const config = loadDesignConfig(projectRoot);
  await bridge.restart({ projectRoot, filelists: config.filelists });
  return bridge.getStatus();
}

/** LSP 状态查询 */
export function getLspStatus(projectId: string, _projectRoot: string): { running: boolean; slangServerPath: string | null; initialized: boolean } {
  const bridge = bridgeCache.get(projectId);
  if (!bridge) {
    return { running: false, slangServerPath: null, initialized: false };
  }
  return bridge.getStatus();
}

/** 销毁所有 LSP 进程（应用关闭时清理） */
export async function disposeAllLsp(): Promise<void> {
  const bridges = [...bridgeCache.values()];
  bridgeCache.clear();
  await Promise.allSettled(bridges.map((b) => b.shutdown()));
}

export type { BridgeDiagnostic, BridgeHover, BridgeDefinition };
