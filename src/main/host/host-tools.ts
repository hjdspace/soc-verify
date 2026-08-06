import type { RpcHostToolCallRequest, RpcHostToolDefinition, AgentToolResult } from './types';
import type { SubsysDiscovery } from './discovery';
import { NoopDiscovery } from './discovery';
import type { PluginBackedSimulation, PluginBackedCoverage } from '../plugin-adapters';
import type { CoverageManager } from '../coverage/coverage-manager';
import type { CaseStatsService } from '../case/case-stats-service';
import type { HostToolEntry, ToolContext } from './tools/shared';
import { createSimTools } from './tools/sim-tools';
import { createDocTools } from './tools/doc-tools';
import { createCoverageAnalysisTools, createCaseStatsTools } from './tools/coverage-tools';
import { createContextTools } from './tools/context-tools';
import { createXlsxEditTools } from './tools/xlsx-edit-tools';

// ──────────────────────────────────────────────────────────────────────────
// HostToolsRegistry — thin registry that maps tool names to handlers.
//
// Deep module: small interface (register / unregister / handleToolCall),
// thin implementation (just a Map dispatch). All tool logic lives in
// focused tool modules under ./tools/.
//
// Conditional tools (coverage analysis, case stats, context) are
// registered/unregistered when their dependencies are set/cleared.
// ──────────────────────────────────────────────────────────────────────────

export class HostToolsRegistry {
  private tools = new Map<string, HostToolEntry>();
  /**
   * Live context object: handlers capture this reference, and adapter
   * mutations update its properties in-place so all handlers see the
   * latest state without re-registration.
   */
  private ctx: ToolContext;
  /** Working directory for resolving relative file paths in tools */
  cwd: string;

  constructor(discovery?: SubsysDiscovery, cwd?: string) {
    this.cwd = cwd ?? process.cwd();
    this.ctx = {
      discovery: discovery ?? new NoopDiscovery(),
      simulation: null,
      coverage: null,
      coverageManager: null,
      caseStatsService: null,
      cwd: this.cwd,
    };
    this.registerDefaults();
    // 条件注册上下文工具（ADR 0009 决策 6）——仅在传入 discovery 时注册，
    // 保持无参构造的默认工具数不变。
    if (discovery) {
      this.registerContextTools();
    }
  }

  setSimulationAdapter(sim: PluginBackedSimulation | null): void {
    this.ctx.simulation = sim;
  }

  setCoverageAdapter(cov: PluginBackedCoverage | null): void {
    this.ctx.coverage = cov;
  }

  /**
   * 注入 CoverageManager（ADR 0009 摘要优先策略）。
   * 设置后 get_coverage 返回摘要而非整个树，并注册 get_coverage_detail 工具。
   * 传 null 回退到旧的 coverage.parse() 行为并注销 get_coverage_detail。
   */
  setCoverageManager(mgr: CoverageManager | null): void {
    this.ctx.coverageManager = mgr;
    if (mgr) {
      this.registerCoverageAnalysisTools();
    } else {
      this.unregister('get_coverage_detail');
      this.unregister('get_coverage_uncovered');
      this.unregister('get_coverage_grade');
      this.unregister('get_coverage_csv');
    }
  }

  /**
   * 注入 CaseStatsService（用例聚合统计共享服务）。
   */
  setCaseStatsService(service: CaseStatsService | null): void {
    this.ctx.caseStatsService = service;
    if (service) {
      this.registerCaseStatsTools();
    } else {
      this.unregister('get_case_stats');
      this.unregister('get_project_overview');
    }
  }

  /** Register base + document + xlsx edit tools. */
  private registerDefaults(): void {
    for (const entry of createSimTools(this.ctx)) this.register(entry);
    for (const entry of createDocTools(this.ctx)) this.register(entry);
    for (const entry of createXlsxEditTools(this.ctx)) this.register(entry);
  }

  /** Register coverage analysis tools (conditional on CoverageManager). */
  private registerCoverageAnalysisTools(): void {
    for (const entry of createCoverageAnalysisTools(this.ctx)) {
      if (!this.hasTool(entry.definition.name)) this.register(entry);
    }
  }

  /** Register case stats tools (conditional on CaseStatsService). */
  private registerCaseStatsTools(): void {
    for (const entry of createCaseStatsTools(this.ctx)) {
      if (!this.hasTool(entry.definition.name)) this.register(entry);
    }
  }

  /** Register AI context tools (conditional on discovery). */
  private registerContextTools(): void {
    for (const entry of createContextTools(this.ctx)) this.register(entry);
  }

  register(entry: HostToolEntry): void {
    this.tools.set(entry.definition.name, entry);
  }

  registerCustom(name: string, description: string, parameters: Record<string, unknown>, handler: (args: Record<string, unknown>) => Promise<unknown>): void {
    this.tools.set(name, {
      definition: { name, description, parameters },
      handler: handler as HostToolEntry['handler'],
    });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  getDefinitions(): RpcHostToolDefinition[] {
    return Array.from(this.tools.values()).map((e) => e.definition);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async handleToolCall(request: RpcHostToolCallRequest): Promise<AgentToolResult | string> {
    const entry = this.tools.get(request.toolName);
    if (!entry) {
      return { content: [{ type: 'text', text: `Host tool "${request.toolName}" is not registered` }] };
    }
    return entry.handler(request.arguments);
  }
}
