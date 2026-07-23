/**
 * Coverage Registry — per-project CoverageManager lifecycle.
 *
 * Mirrors SimulationRegistry: one CoverageManager per projectRoot,
 * created lazily on first access, cached for subsequent calls.
 */

import { CoverageManager } from './coverage-manager';
import type { PluginBackedCoverage } from '../plugin-adapters';
import { CoverageReportGenerator } from './coverage-report-generator';

class CoverageRegistryImpl {
  private managers = new Map<string, CoverageManager>();

  getOrCreate(
    projectRoot: string,
    coverageAdapter: PluginBackedCoverage | null,
  ): CoverageManager {
    let manager = this.managers.get(projectRoot);
    if (!manager) {
      manager = new CoverageManager({
        projectRoot,
        coverageAdapter,
        reportGenerator: new CoverageReportGenerator({ projectRoot }),
      });
      this.managers.set(projectRoot, manager);
    } else {
      // Keep adapter up-to-date (plugins may have been reloaded)
      manager.setAdapter(coverageAdapter);
    }
    return manager;
  }

  get(projectRoot: string): CoverageManager | null {
    return this.managers.get(projectRoot) ?? null;
  }

  remove(projectRoot: string): void {
    this.managers.delete(projectRoot);
  }

  clearAll(): void {
    this.managers.clear();
  }
}

export const coverageRegistry = new CoverageRegistryImpl();
