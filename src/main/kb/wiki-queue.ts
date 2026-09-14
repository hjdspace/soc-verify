/**
 * Wiki 导入队列单例（issue 03）— 进程级唯一队列管理器。
 *
 * 与「当前挂载库」的绑定由 kb-router 驱动：
 *   - kb.mount（wiki 格式）→ attach(kbPath, kbId)
 *   - 队列 procedures → attach(kbPath, kbId)，按需恢复重启后保留的挂载
 *   - kb.unmount / kb.deleteKb → detach(kbId)
 * 队列事件经原生 IPC `kb:task` 通道广播到所有窗口（渲染端经 eventBridge
 * 订阅；重订阅先拉 kb.queueSnapshot 快照再按 seq 应用事件）。
 *
 * @see src/main/kb/ingest-queue.ts — 队列核心语义
 * @see .scratch/llm-wiki/issues/03-durable-ingest-queue.md
 */

import { broadcastToWindows } from '../ipc/broadcast';
import { WikiIngestQueueManager } from './ingest-queue';

export const wikiIngestQueue = new WikiIngestQueueManager({
  notify: (e) => broadcastToWindows('kb:task', e),
});
