import type { AgentToolResult } from '../types';
import type { SubsysDiscovery } from '../discovery';
import type { PluginBackedSimulation, PluginBackedCoverage } from '../../plugin-adapters';
import type { CoverageManager } from '../../coverage/coverage-manager';
import type { CaseStatsService } from '../../case/case-stats-service';

// ── 共享类型 ───────────────────────────────────────────────────────

export type HostToolHandler = (args: Record<string, unknown>) => Promise<AgentToolResult | string>;

export interface HostToolEntry {
  definition: { name: string; description: string; parameters: Record<string, unknown> };
  handler: HostToolHandler;
}

export const TEXT = (text: string): AgentToolResult => ({ content: [{ type: 'text', text }] });

export function defineTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: HostToolHandler,
): HostToolEntry {
  return {
    definition: { name, description, parameters },
    handler,
  };
}

/**
 * 工具上下文：封装所有工具模块需要的依赖。
 *
 * 深模块 seam：工具模块通过此接口获取 discovery/simulation/coverage 等能力，
 * 不直接 import 全局单例。注册器负责构造和更新此上下文。
 */
export type ToolContext = {
  discovery: SubsysDiscovery;
  simulation: PluginBackedSimulation | null;
  coverage: PluginBackedCoverage | null;
  coverageManager: CoverageManager | null;
  caseStatsService: CaseStatsService | null;
  cwd: string;
};
