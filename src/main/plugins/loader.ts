import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
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

/** Resolve the app's built-in plugins directory (plugins/ at app root). */
function getBuiltinPluginsDir(): string | null {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath ? join(resourcesPath, 'plugins') : null,
    // Source: src/main/plugins/loader.ts -> repository plugins/
    resolve(__dirname, '../../../plugins'),
    // electron-vite output: out/main/index.cjs -> repository plugins/
    resolve(__dirname, '../../plugins'),
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Discover built-in plugins from the app's plugins/ directory. */
function discoverBuiltinPlugins(): PluginConfigEntry[] {
  const pluginsDir = getBuiltinPluginsDir();
  if (!pluginsDir) return [];

  const entries: PluginConfigEntry[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const dir of dirs) {
    const pkgPath = join(pluginsDir, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      const sv = pkg.socverify as Record<string, unknown> | undefined;
      if (!sv || typeof sv.kind !== 'string' || typeof sv.id !== 'string') continue;

      const mainFile = (typeof pkg.main === 'string' ? pkg.main : 'index.js');
      const pluginPath = join(pluginsDir, dir, mainFile);

      entries.push({
        id: sv.id,
        name: (typeof pkg.name === 'string' ? pkg.name : sv.id),
        version: (typeof pkg.version === 'string' ? pkg.version : '0.0.0'),
        kind: sv.kind as PluginConfigEntry['kind'],
        source: 'local',
        path: pluginPath,
        enabled: true,
      });
    } catch {
      // Skip invalid package.json
    }
  }

  return entries;
}

async function loadPluginModule(
  source: 'node_modules' | 'local',
  pluginPath: string,
): Promise<{ plugin: unknown; manifest: PluginManifest } | { error: string }> {
  try {
    // Use createRequire for CJS plugins — import() of file:// URLs is unreliable
    // in electron-vite's bundled CJS output.
    const require = createRequire(import.meta.url);
    const mod = require(pluginPath);

    // The plugin module should export a default or named `plugin` / `default` object
    const exported = mod?.default ?? mod?.plugin ?? mod;
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

    // Merge built-in plugins with project-level config.
    // Project-level config entries with the same id override built-in entries.
    const builtinEntries = discoverBuiltinPlugins();
    console.log(`[plugin-loader] built-in plugins discovered: ${builtinEntries.length}`);
    for (const b of builtinEntries) {
      console.log(`[plugin-loader]   - ${b.id} (${b.kind}) → ${b.path}`);
    }
    const projectIds = new Set(config.plugins.map((p) => p.id));
    const mergedEntries = [
      ...builtinEntries.filter((b) => !projectIds.has(b.id)),
      ...config.plugins,
    ];
    console.log(`[plugin-loader] total entries to load: ${mergedEntries.length} (project: ${config.plugins.length})`);

    for (const entry of mergedEntries) {
      if (!entry.enabled) continue;

      // For local plugins, resolve relative to projectRoot only if path is relative.
      // Built-in plugins already have absolute paths.
      const pluginPath = entry.source === 'local' && !isAbsolute(entry.path)
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
        console.log(`[plugin-loader] FAILED to classify ${manifest.id} (kind: ${manifest.kind})`);
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
      console.log(`[plugin-loader] loaded OK: ${manifest.id} (kind: ${manifest.kind})`);
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
