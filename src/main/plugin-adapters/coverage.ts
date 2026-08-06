/**
 * Plugin-backed coverage parser adapter.
 *
 * Bridges the CoverageParserPlugin interface from @shared/plugin-types
 * to the methods that HostToolsRegistry and CoverageRouter call.
 *
 * 遵循 ADR 0006（插件只解析文本报告）+ ADR 0008（sessionId 生命周期）。
 *
 * 性能优化：当 pluginPath 可用时，使用 Worker Thread 执行插件的 parse() 方法，
 * 避免同步 CPU 密集型解析阻塞 Electron 主进程事件循环。
 */

import type {
  CoverageParserPlugin,
  PluginRegistry,
  CoverageData,
} from '@shared/plugin-types';
import { parseCoverageInWorker } from '../coverage/coverage-worker';

export class PluginBackedCoverage {
  private projectRoot: string;
  private registry: PluginRegistry;
  private pluginPath: string | null;

  constructor(projectRoot: string, registry: PluginRegistry, pluginPath?: string) {
    this.projectRoot = projectRoot;
    this.registry = registry;
    this.pluginPath = pluginPath ?? null;
  }

  hasParser(): boolean {
    return this.registry.coverageParsers.length > 0;
  }

  /**
   * 调用插件的 parse 方法解析文本报告为层级 Coverage Tree。
   *
   * 如果 pluginPath 可用，在 Worker Thread 中执行解析，避免阻塞主进程。
   * 否则回退到主进程直接调用（兼容旧路径）。
   *
   * @param sessionId Coverage Merge Session ID（ADR 0008）
   * @param reportDir 平台已生成文本报告的目录（ADR 0006 第二步输入）
   */
  async parse(sessionId: string, reportDir: string): Promise<CoverageData> {
    if (!this.hasParser()) throw new Error('No coverage-parser plugin loaded');

    // 优先使用 Worker Thread 执行解析（避免阻塞主进程事件循环）
    if (this.pluginPath) {
      return parseCoverageInWorker(
        this.pluginPath,
        this.projectRoot,
        sessionId,
        reportDir,
      );
    }

    // 回退：直接调用插件（可能阻塞主进程，仅作为兜底）
    const plugin = this.registry.coverageParsers[0] as CoverageParserPlugin;
    return plugin.parse(this.projectRoot, sessionId, reportDir);
  }
}
