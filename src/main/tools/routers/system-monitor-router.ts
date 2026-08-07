/**
 * system-monitor sub-router — real-time system resource metrics.
 *
 * Procedures: getMetrics
 */

import { t } from '../../ipc/router-context';
import { getSystemMetrics, formatBytes, formatUptime } from '../system-monitor';

export const systemMonitorRouter = t.router({
  getMetrics: t.procedure
    .query(async () => {
      const metrics = await getSystemMetrics();
      return {
        ...metrics,
        memoryTotalFormatted: formatBytes(metrics.memoryTotal),
        memoryUsedFormatted: formatBytes(metrics.memoryUsed),
        diskTotalFormatted: formatBytes(metrics.diskTotal),
        diskUsedFormatted: formatBytes(metrics.diskUsed),
        processMemoryFormatted: formatBytes(metrics.processMemory),
        uptimeFormatted: formatUptime(metrics.processUptime),
      };
    }),
});
