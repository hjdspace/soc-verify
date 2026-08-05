/**
 * Tool Registry — maps tool IDs to their React components.
 *
 * Each tool component receives a `projectRoot` prop (the auto-injected
 * project path, which the user can override in the tool UI).
 *
 * Tools not yet implemented show a "coming soon" placeholder.
 */

import type { ComponentType } from 'react';
import { EnvChecker } from './env-checker/EnvChecker';
import { CodeLineCounter } from './code-line-counter/CodeLineCounter';
import { FindReplace } from './find-replace/FindReplace';
import { PerformanceMonitor } from './performance-monitor/PerformanceMonitor';
import { LogAnalyzer } from './log-analyzer/LogAnalyzer';
import { TimeAnalyzer } from './time-analyzer/TimeAnalyzer';
import { CoverageMerger } from './coverage-merger/CoverageMerger';
import { BatchExecution } from './batch-execution/BatchExecution';
import { RegressionAnalyzer } from './regression-analyzer/RegressionAnalyzer';
import { RegressionListGen } from './regression-list-gen/RegressionListGen';
import { ToolPlaceholder } from './ToolPlaceholder';

export type ToolComponentProps = {
  projectRoot: string | null;
  onProjectRootChange: (path: string) => void;
};

export type ToolRegistryEntry = {
  component: ComponentType<ToolComponentProps>;
};

const registry: Record<string, ToolRegistryEntry> = {
  // ── Batch 1 (implemented) ──
  'env-checker': { component: EnvChecker },
  'code-line-counter': { component: CodeLineCounter },
  'find-replace': { component: FindReplace },
  'performance-monitor': { component: PerformanceMonitor },

  // ── Batch 1 (remaining tools, implemented) ──
  'log-analyzer': { component: LogAnalyzer },
  'time-analyzer': { component: TimeAnalyzer },
  'coverage-merger': { component: CoverageMerger },
  'batch-execution': { component: BatchExecution },

  // ── Batch 2 (implemented) ──
  'regression-analyzer': { component: RegressionAnalyzer },
  'regression-list-gen': { component: RegressionListGen },

  // ── Batch 3 (placeholders) ──
  'git-manager': { component: ToolPlaceholder },
  'git-diff': { component: ToolPlaceholder },
  'git-quick-pull': { component: ToolPlaceholder },
  'register-table-parser': { component: ToolPlaceholder },
  'reg2c': { component: ToolPlaceholder },
  'c-sv-converter': { component: ToolPlaceholder },
  'sv-ifdef-checker': { component: ToolPlaceholder },
};

export function getToolComponent(toolId: string): ComponentType<ToolComponentProps> | null {
  return registry[toolId]?.component ?? null;
}
