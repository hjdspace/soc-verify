/**
 * Worker Thread 入口 — 在 Worker 中执行日志解析。
 *
 * 参考 docs/adr/0013-worker-thread-for-violation-parsing.md
 *
 * Worker 负责文件 I/O 和解析，通过 parentPort.postMessage 分批回传结果（每 1000 条一批）。
 * 主进程接收后使用 better-sqlite3 的 transaction() 批量插入。
 */

import { parentPort, workerData } from 'node:worker_threads';
import { parseLogStream } from './vio-parser';
import type { ParsedViolation, WorkerMessage, ParseOptions } from '../types';

const BATCH_SIZE = 1000;

async function run(): Promise<void> {
  const { filePath, options } = workerData as {
    filePath: string;
    options: ParseOptions;
  };

  if (!parentPort) {
    throw new Error('parentPort is not available — must run in Worker context');
  }

  const port = parentPort;
  let batch: ParsedViolation[] = [];
  let totalCount = 0;

  function flushBatch(): void {
    if (batch.length > 0) {
      const msg: WorkerMessage = { type: 'batch', violations: batch, count: totalCount };
      port.postMessage(msg);
      batch = [];
    }
  }

  try {
    await parseLogStream(
      filePath,
      options,
      (violation) => {
        batch.push(violation);
        totalCount++;
        if (batch.length >= BATCH_SIZE) {
          flushBatch();
        }
      },
      (lineCount) => {
        const msg: WorkerMessage = { type: 'progress', processed: lineCount, total: 0 };
        port.postMessage(msg);
      },
    );

    flushBatch();

    const doneMsg: WorkerMessage = { type: 'done', count: totalCount };
    port.postMessage(doneMsg);
  } catch (err) {
    const msg: WorkerMessage = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(msg);
  }
}

void run();
