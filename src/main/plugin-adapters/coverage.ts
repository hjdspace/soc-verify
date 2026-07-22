/**
 * Plugin-backed coverage parser adapter.
 *
 * Bridges the CoverageParserPlugin interface from @shared/plugin-types
 * to the methods that HostToolsRegistry and CoverageRouter call.
 *
 * 遵循 ADR 0006（插件只解析文本报告）+ ADR 0008（sessionId 生命周期）。
 */

import type {
  CoverageParserPlugin,
  PluginRegistry,
  CoverageData,
} from '@shared/plugin-types';

export class PluginBackedCoverage {
  private projectRoot: string;
  private registry: PluginRegistry;

  constructor(projectRoot: string, registry: PluginRegistry) {
    this.projectRoot = projectRoot;
    this.registry = registry;
  }

  hasParser(): boolean {
    return this.registry.coverageParsers.length > 0;
  }

  /**
   * 调用插件的 parse 方法解析文本报告为层级 Coverage Tree。
   * @param sessionId Coverage Merge Session ID（ADR 0008）
   * @param reportDir 平台已生成文本报告的目录（ADR 0006 第二步输入）
   */
  async parse(sessionId: string, reportDir: string): Promise<CoverageData> {
    if (!this.hasParser()) throw new Error('No coverage-parser plugin loaded');
    const plugin = this.registry.coverageParsers[0] as CoverageParserPlugin;
    return plugin.parse(this.projectRoot, sessionId, reportDir);
  }
}
