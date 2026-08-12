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
 * 额外优化：Worker Thread 同时完成 enriched 数据构建和 JSON.stringify，
 * 避免主进程在大数据量时同步序列化阻塞事件循环。
 * 返回 { data, jsonStr } 供调用方直接使用。
 *
 * 参考 ADR 0013（Worker Thread for Violation Parsing）的同类设计。
 */

import { Worker } from 'node:worker_threads';
import type { CoverageData, EdaTool } from '@shared/types';
import { DEFAULT_COVERAGE_TARGETS } from '@shared/types';

/** Worker 执行的超时时间（10 分钟，覆盖率数据可能很大） */
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

/** 传递给 Worker 的 enrichment 字段 */
export interface WorkerEnrichment {
  sessionId: string;
  covMergeDir: string;
  edaTool: EdaTool;
  targets?: Partial<Record<string, number>>;
}

/** Worker 返回结果：包含解析后的数据和预序列化的 JSON 字符串 */
export interface CoverageWorkerResult {
  /** 解析后并 enriched 的 CoverageData */
  data: CoverageData;
  /** 预序列化的 JSON 字符串（JSON.stringify(enrichedData)），避免主进程同步序列化 */
  jsonStr: string;
}

/**
 * 在 Worker Thread 中执行覆盖率插件的 parse() 方法。
 *
 * @param pluginPath 插件模块的绝对路径（CJS 模块）
 * @param projectRoot 项目根目录
 * @param reportDir 平台已生成文本报告的目录
 * @param enrichment 用于 enriched CoverageData 的附加字段
 * @returns 包含解析后 CoverageData 和预序列化 JSON 字符串的结果
 *
 * 如果 Worker 创建失败（如不支持 worker_threads），回退到主进程同步调用。
 */
export async function parseCoverageInWorker(
  pluginPath: string,
  projectRoot: string,
  reportDir: string,
  enrichment: WorkerEnrichment,
): Promise<CoverageWorkerResult> {
  return new Promise<CoverageWorkerResult>((resolve, reject) => {
    // Worker 代码字符串 —— 在独立线程中执行
    // 使用 eval 模式避免需要单独编译 worker 入口文件
    // Worker 同时完成 parse() + enrichment + JSON.stringify()，避免主进程同步阻塞
    const workerCode = `
      'use strict';
      var { workerData, parentPort } = require('worker_threads');
      try {
        var mod = require(workerData.pluginPath);
        var plugin = mod && mod.default ? mod.default : (mod && mod.plugin ? mod.plugin : mod);
        if (!plugin || typeof plugin.parse !== 'function') {
          parentPort.postMessage({
            success: false,
            error: 'Plugin does not export a parse function: ' + workerData.pluginPath
          });
          return;
        }
        var result = plugin.parse(workerData.projectRoot, workerData.sessionId, workerData.reportDir);
        Promise.resolve(result).then(function(data) {
          // 在 Worker Thread 中完成 enrichment + JSON.stringify，避免主进程同步阻塞
          try {
            var enriched = Object.assign({}, data, {
              sessionId: workerData.enrichment.sessionId,
              source: {
                covMergeDir: workerData.enrichment.covMergeDir,
                edaTool: workerData.enrichment.edaTool,
                reportGeneratedAt: Date.now()
              },
              targets: workerData.enrichment.targets || {}
            });
            var jsonStr = JSON.stringify(enriched);
            parentPort.postMessage({ success: true, data: enriched, jsonStr: jsonStr });
          } catch (strErr) {
            // enrichment 或 JSON.stringify 失败，仍然返回原始 data
            parentPort.postMessage({
              success: true,
              data: data,
              jsonStr: null,
              stringifyError: strErr && strErr.message ? strErr.message : String(strErr)
            });
          }
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
        workerData: {
          pluginPath,
          projectRoot,
          sessionId: enrichment.sessionId,
          reportDir,
          enrichment,
        },
      });
    } catch (err) {
      // Worker 创建失败，回退到主进程同步调用
      console.warn('[coverage-worker] Failed to create worker, falling back to sync parse:', err);
      fallbackSyncParse(pluginPath, projectRoot, reportDir, enrichment)
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

    worker.on('message', (msg: { success: boolean; data?: CoverageData; jsonStr?: string | null; error?: string; stringifyError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      cleanup();

      if (msg.success && msg.data) {
        resolve({
          data: msg.data,
          jsonStr: msg.jsonStr ?? '',
        });
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
  reportDir: string,
  enrichment: WorkerEnrichment,
): Promise<CoverageWorkerResult> {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const mod = require(pluginPath);
  const plugin = mod?.default ?? mod?.plugin ?? mod;
  if (!plugin || typeof plugin.parse !== 'function') {
    throw new Error(`Plugin does not export a parse function: ${pluginPath}`);
  }
  const data = await plugin.parse(projectRoot, enrichment.sessionId, reportDir);
  const enriched: CoverageData = {
    ...data,
    sessionId: enrichment.sessionId,
    source: {
      covMergeDir: enrichment.covMergeDir,
      edaTool: enrichment.edaTool,
      reportGeneratedAt: Date.now(),
    },
    targets: enrichment.targets ?? { ...DEFAULT_COVERAGE_TARGETS },
  };
  return { data: enriched, jsonStr: JSON.stringify(enriched) };
}
