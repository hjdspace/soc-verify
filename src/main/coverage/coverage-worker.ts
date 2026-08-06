/**
 * Coverage Worker — 在 Worker Thread 中执行覆盖率插件解析。
 *
 * 解决问题：内置覆盖率解析插件（builtin-coverage-parser）的 parse() 函数是
 * 同步 CPU 密集型操作（readFileSync + 大量正则 + 树构建），直接在主进程调用
 * 会阻塞 Electron 主进程事件循环，导致 GUI 卡死。
 *
 * 方案：使用 worker_threads 的 eval 模式，在独立线程中加载插件并执行 parse()，
 * 主进程事件循环保持畅通，GUI 可以正常响应。
 *
 * 参考 ADR 0013（Worker Thread for Violation Parsing）的同类设计。
 */

import { Worker } from 'node:worker_threads';
import type { CoverageData } from '@shared/types';

/** Worker 执行的超时时间（5 分钟） */
const WORKER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 在 Worker Thread 中执行覆盖率插件的 parse() 方法。
 *
 * @param pluginPath 插件模块的绝对路径（CJS 模块）
 * @param projectRoot 项目根目录
 * @param sessionId Coverage Merge Session ID
 * @param reportDir 平台已生成文本报告的目录
 * @returns 解析后的 CoverageData
 *
 * 如果 Worker 创建失败（如不支持 worker_threads），回退到主进程同步调用。
 */
export async function parseCoverageInWorker(
  pluginPath: string,
  projectRoot: string,
  sessionId: string,
  reportDir: string,
): Promise<CoverageData> {
  return new Promise<CoverageData>((resolve, reject) => {
    // Worker 代码字符串 —— 在独立线程中执行
    // 使用 eval 模式避免需要单独编译 worker 入口文件
    const workerCode = `
      'use strict';
      const { workerData, parentPort } = require('worker_threads');
      try {
        const mod = require(workerData.pluginPath);
        const plugin = mod?.default ?? mod?.plugin ?? mod;
        if (!plugin || typeof plugin.parse !== 'function') {
          parentPort.postMessage({
            success: false,
            error: 'Plugin does not export a parse function: ' + workerData.pluginPath
          });
          return;
        }
        const result = plugin.parse(workerData.projectRoot, workerData.sessionId, workerData.reportDir);
        Promise.resolve(result).then(function(data) {
          parentPort.postMessage({ success: true, data: data });
        }).catch(function(err) {
          parentPort.postMessage({
            success: false,
            error: err && err.message ? err.message : String(err)
          });
        });
      } catch (err) {
        parentPort.postMessage({
          success: false,
          error: err && err.message ? err.message : String(err)
        });
      }
    `;

    let worker: Worker | null = null;
    let settled = false;

    const cleanup = (): void => {
      if (worker && !settled) {
        worker.terminate().catch(() => {});
      }
    };

    try {
      worker = new Worker(workerCode, {
        eval: true,
        workerData: { pluginPath, projectRoot, sessionId, reportDir },
      });
    } catch (err) {
      // Worker 创建失败，回退到主进程同步调用
      console.warn('[coverage-worker] Failed to create worker, falling back to sync parse:', err);
      fallbackSyncParse(pluginPath, projectRoot, sessionId, reportDir)
        .then(resolve)
        .catch(reject);
      return;
    }

    // 超时处理
    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Coverage parsing timed out after ${WORKER_TIMEOUT_MS / 1000}s`));
      }
    }, WORKER_TIMEOUT_MS);

    worker.on('message', (msg: { success: boolean; data?: CoverageData; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      cleanup();

      if (msg.success && msg.data) {
        resolve(msg.data);
      } else {
        reject(new Error(msg.error ?? 'Unknown coverage parsing error'));
      }
    });

    worker.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      cleanup();
      reject(err);
    });

    worker.on('exit', (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (code !== 0) {
        reject(new Error(`Coverage parsing worker exited with code ${code}`));
      }
    });
  });
}

/**
 * 回退方案：在主进程中同步加载插件并执行 parse()。
 * 仅在 Worker Thread 不可用时使用。
 */
async function fallbackSyncParse(
  pluginPath: string,
  projectRoot: string,
  sessionId: string,
  reportDir: string,
): Promise<CoverageData> {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const mod = require(pluginPath);
  const plugin = mod?.default ?? mod?.plugin ?? mod;
  if (!plugin || typeof plugin.parse !== 'function') {
    throw new Error(`Plugin does not export a parse function: ${pluginPath}`);
  }
  return plugin.parse(projectRoot, sessionId, reportDir);
}
