/**
 * System Monitor — collects system resource metrics (CPU, memory, disk).
 *
 * Used by both the Resource Monitor and Performance Monitor tools.
 * Ported from the Python `resource_monitor` and `performance_monitor` plugins.
 */

import { cpus, totalmem, freemem, platform } from 'node:os';
import { statfs } from 'node:fs/promises';
export type SystemMetrics = {
  timestamp: number;
  cpuUsage: number;        // percentage (0-100)
  cpuCores: number;
  memoryTotal: number;     // bytes
  memoryUsed: number;      // bytes
  memoryUsage: number;     // percentage (0-100)
  diskTotal: number;       // bytes
  diskUsed: number;        // bytes
  diskUsage: number;       // percentage (0-100)
  processMemory: number;   // bytes (Electron process RSS)
  processUptime: number;   // seconds
};

/** Previous CPU times for delta calculation. */
let prevCpuTimes: { idle: number; total: number } | null = null;

/**
 * Get current CPU usage as a percentage.
 * Uses delta of idle/total CPU times between calls.
 */
function getCpuUsage(): number {
  const cpuList = cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpuList) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }

  if (!prevCpuTimes) {
    prevCpuTimes = { idle, total };
    return 0;
  }

  const idleDelta = idle - prevCpuTimes.idle;
  const totalDelta = total - prevCpuTimes.total;
  prevCpuTimes = { idle, total };

  if (totalDelta === 0) return 0;
  return Math.round((1 - idleDelta / totalDelta) * 100);
}

/**
 * Get disk usage for the root partition.
 *
 * On Windows, uses the `C:` drive. On Unix, uses `/`.
 */
async function getDiskUsage(): Promise<{ total: number; used: number; usage: number }> {
  try {
    const diskPath = platform() === 'win32' ? 'C:\\' : '/';
    const stats = await statfs(diskPath);
    const total = stats.bsize * stats.blocks;
    const free = stats.bsize * stats.bfree;
    const used = total - free;
    const usage = total > 0 ? Math.round((used / total) * 100) : 0;
    return { total, used, usage };
  } catch {
    return { total: 0, used: 0, usage: 0 };
  }
}

/**
 * Collect current system metrics.
 */
export async function getSystemMetrics(): Promise<SystemMetrics> {
  const totalMem = totalmem();
  const freeMem = freemem();
  const usedMem = totalMem - freeMem;
  const memUsage = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;

  const disk = await getDiskUsage();
  const cpuUsage = getCpuUsage();
  const cpuList = cpus();

  const processMem = process.memoryUsage();

  return {
    timestamp: Date.now(),
    cpuUsage,
    cpuCores: cpuList.length,
    memoryTotal: totalMem,
    memoryUsed: usedMem,
    memoryUsage: memUsage,
    diskTotal: disk.total,
    diskUsed: disk.used,
    diskUsage: disk.usage,
    processMemory: processMem.rss,
    processUptime: Math.round(process.uptime()),
  };
}

/**
 * Format bytes to human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format seconds to human-readable uptime string.
 */
export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
