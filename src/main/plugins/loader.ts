import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import type {
  PluginManifest,
  PluginRegistry,
  PluginLoadResult,
  AnyPlugin,
  CaseParserPlugin,
  SubsysDiscoveryPlugin,
  CoverageParserPlugin,
  SimulationRunnerPlugin,
  SimOptionSchemaProvider,
} from '@shared/plugin-types';
import type { PluginConfig, PluginConfigEntry } from '@shared/types';

const SOCVERIFY_DIR = '.socverify';
const PLUGIN_CONFIG_FILE = 'plugins.json';

function emptyRegistry(): PluginRegistry {
  return {
    caseParsers: [],
    subsysDiscoverers: [],
    coverageParsers: [],
    simulationRunners: [],
    simOptionSchemaProviders: [],
  };
}

function validateManifest(manifest: unknown): manifest is PluginManifest {
  if (typeof manifest !== 'object' || manifest === null) return false;
  const m = manifest as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.name === 'string' &&
    typeof m.version === 'string' &&
    typeof m.kind === 'string' &&
    ['case-parser', 'subsys-discoverer', 'coverage-parser', 'simulation-runner', 'sim-option-schema'].includes(m.kind)
  );
}

function classifyPlugin(plugin: unknown, manifest: PluginManifest): AnyPlugin | null {
  if (typeof plugin !== 'object' || plugin === null) return null;
  const p = plugin as Record<string, unknown>;

  // Check if the plugin object has the manifest property and the expected method
  switch (manifest.kind) {
    case 'case-parser':
      if (typeof p.parse === 'function') return plugin as CaseParserPlugin;
      break;
    case 'subsys-discoverer':
      if (typeof p.discover === 'function') return plugin as SubsysDiscoveryPlugin;
      break;
    case 'coverage-parser':
      if (typeof p.parse === 'function') return plugin as CoverageParserPlugin;
      break;
    case 'simulation-runner':
      if (typeof p.run === 'function') return plugin as SimulationRunnerPlugin;
      break;
    case 'sim-option-schema':
      if (typeof p.getSchema === 'function') return plugin as SimOptionSchemaProvider;
      break;
  }
  return null;
}

async function loadPluginModule(
  source: 'node_modules' | 'local',
  pluginPath: string,
): Promise<{ plugin: unknown; manifest: PluginManifest } | { error: string }> {
  try {
    const fileUrl = pathToFileURL(pluginPath).href;
    const mod = await import(fileUrl);

    // The plugin module should export a default or named `plugin` / `default` object
    const exported = mod.default ?? mod.plugin ?? mod;
    const manifest: unknown = exported?.manifest;

    if (!validateManifest(manifest)) {
      return { error: `Invalid or missing manifest in plugin at ${pluginPath}` };
    }

    return { plugin: exported, manifest };
  } catch (err) {
    return { error: `Failed to load plugin from ${pluginPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

class PluginLoaderImpl {
  private registries = new Map<string, PluginRegistry>();
  private loadResults = new Map<string, PluginLoadResult[]>();

  async loadPlugins(projectRoot: string): Promise<PluginLoadResult[]> {
    const config = await this.readPluginConfig(projectRoot);
    const results: PluginLoadResult[] = [];
    const registry = emptyRegistry();

    for (const entry of config.plugins) {
      if (!entry.enabled) continue;

      const pluginPath = entry.source === 'local'
        ? resolve(projectRoot, entry.path)
        : entry.path;

      if (!existsSync(pluginPath)) {
        results.push({
          manifest: {
            id: entry.id,
            name: entry.name,
            version: entry.version,
            kind: entry.kind,
          },
          plugin: null as never,
          source: entry.source,
          path: entry.path,
          error: `Plugin path not found: ${pluginPath}`,
        });
        continue;
      }

      const loadResult = await loadPluginModule(entry.source, pluginPath);
      if ('error' in loadResult) {
        results.push({
          manifest: {
            id: entry.id,
            name: entry.name,
            version: entry.version,
            kind: entry.kind,
          },
          plugin: null as never,
          source: entry.source,
          path: entry.path,
          error: loadResult.error,
        });
        continue;
      }

      const { plugin, manifest } = loadResult;
      const classified = classifyPlugin(plugin, manifest);
      if (!classified) {
        results.push({
          manifest,
          plugin: null as never,
          source: entry.source,
          path: entry.path,
          error: `Plugin does not implement required interface for kind: ${manifest.kind}`,
        });
        continue;
      }

      // Add to registry
      switch (manifest.kind) {
        case 'case-parser':
          registry.caseParsers.push(classified as CaseParserPlugin);
          break;
        case 'subsys-discoverer':
          registry.subsysDiscoverers.push(classified as SubsysDiscoveryPlugin);
          break;
        case 'coverage-parser':
          registry.coverageParsers.push(classified as CoverageParserPlugin);
          break;
        case 'simulation-runner':
          registry.simulationRunners.push(classified as SimulationRunnerPlugin);
          break;
        case 'sim-option-schema':
          registry.simOptionSchemaProviders.push(classified as SimOptionSchemaProvider);
          break;
      }

      results.push({
        manifest,
        plugin: classified,
        source: entry.source,
        path: entry.path,
      });
    }

    this.registries.set(projectRoot, registry);
    this.loadResults.set(projectRoot, results);
    return results;
  }

  getRegistry(projectRoot: string): PluginRegistry {
    return this.registries.get(projectRoot) ?? emptyRegistry();
  }

  getLoadResults(projectRoot: string): PluginLoadResult[] {
    return this.loadResults.get(projectRoot) ?? [];
  }

  async readPluginConfig(projectRoot: string): Promise<PluginConfig> {
    const configPath = join(projectRoot, SOCVERIFY_DIR, PLUGIN_CONFIG_FILE);
    try {
      const content = await readFile(configPath, 'utf-8');
      return JSON.parse(content) as PluginConfig;
    } catch {
      return { plugins: [] };
    }
  }

  async savePluginConfig(projectRoot: string, config: PluginConfig): Promise<void> {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const configDir = join(projectRoot, SOCVERIFY_DIR);
    if (!existsSync(configDir)) {
      await mkdir(configDir, { recursive: true });
    }
    const configPath = join(configDir, PLUGIN_CONFIG_FILE);
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  clearProject(projectRoot: string): void {
    this.registries.delete(projectRoot);
    this.loadResults.delete(projectRoot);
  }

  clearAll(): void {
    this.registries.clear();
    this.loadResults.clear();
  }
}

export const pluginLoader = new PluginLoaderImpl();

// Legacy exports for backward compatibility
export const pluginRegistry: PluginRegistry = emptyRegistry();

export async function loadPlugins(projectRoot: string): Promise<void> {
  await pluginLoader.loadPlugins(projectRoot);
}

export function registerPlugin(_manifest: PluginManifest): void {
  // Deprecated: use PluginLoader.loadPlugins() instead
}

export function clearPlugins(): void {
  pluginRegistry.caseParsers.length = 0;
  pluginRegistry.subsysDiscoverers.length = 0;
  pluginRegistry.coverageParsers.length = 0;
  pluginRegistry.simulationRunners.length = 0;
  pluginRegistry.simOptionSchemaProviders.length = 0;
}
