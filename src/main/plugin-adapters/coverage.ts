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
 * Worker Thread 同时完成 enrichment + JSON.stringify，返回 { data, jsonStr } 供调用方直接使用。
 */

import type {
  CoverageParserPlugin,
  PluginRegistry,
  CoverageData,
  DetailReportResult,
} from '@shared/plugin-types';
import { parseCoverageInWorker, parseDetailReportInWorker, type CoverageWorkerResult, type WorkerEnrichment } from '../coverage/coverage-worker';
import { DEFAULT_COVERAGE_TARGETS } from '@shared/types';

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
   * Worker Thread 同时完成 enrichment + JSON.stringify，返回预序列化的 JSON 字符串。
   * 否则回退到主进程直接调用（兼容旧路径）。
   *
   * @param sessionId Coverage Merge Session ID（ADR 0008）
   * @param reportDir 平台已生成文本报告的目录（ADR 0006 第二步输入）
   * @param enrichment 用于 enriched CoverageData 的附加字段
   * @returns 包含解析后 CoverageData 和预序列化 JSON 字符串的结果
   */
  async parse(sessionId: string, reportDir: string, enrichment: WorkerEnrichment): Promise<CoverageWorkerResult> {
    if (!this.hasParser()) throw new Error('No coverage-parser plugin loaded');

    // 优先使用 Worker Thread 执行解析（避免阻塞主进程事件循环）
    if (this.pluginPath) {
      return parseCoverageInWorker(
        this.pluginPath,
        this.projectRoot,
        reportDir,
        enrichment,
      );
    }

    // 回退：直接调用插件（可能阻塞主进程，仅作为兜底）
    const plugin = this.registry.coverageParsers[0] as CoverageParserPlugin;
    const data = await plugin.parse(this.projectRoot, sessionId, reportDir);
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

  /**
   * 调用插件的 parseDetailReport(detailPath) 解析 detail.txt（instance 级
   * blocks/branches/statements）。300 万行级 CPU 密集解析放入 Worker Thread，
   * 不阻塞主进程；pluginPath 不可用时回退主进程直接调用。
   */
  async parseDetailReport(detailPath: string): Promise<DetailReportResult> {
    if (!this.hasParser()) throw new Error('No coverage-parser plugin loaded');
    if (this.pluginPath) {
      return parseDetailReportInWorker(this.pluginPath, detailPath);
    }
    // 回退：直接调用插件（可能阻塞主进程，仅作为兜底）
    const mod = (this.registry.coverageParsers[0] as unknown as {
      parseDetailReport?: (detailPath: string) => DetailReportResult;
    });
    if (typeof mod?.parseDetailReport !== 'function') {
      throw new Error('Coverage parser plugin does not support parseDetailReport');
    }
    return mod.parseDetailReport(detailPath);
  }
}
