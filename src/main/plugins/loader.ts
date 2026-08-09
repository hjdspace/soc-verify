import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
  UiPlugin,
  PluginContributions,
  PluginLifecycle,
  PluginHostEvent,
  PluginNotification,
  PluginOrigin,
} from '@shared/plugin-types';
import type { PluginConfig, PluginConfigEntry } from '@shared/types';
import {
  discoverPluginPackages,
  getBuiltinPluginsDir,
  getDefaultUserPluginsDir,
  type PluginPackageCandidate,
} from './catalog';

const SOCVERIFY_DIR = '.socverify';
const PLUGIN_CONFIG_FILE = 'plugins.json';
const PLUGIN_STATE_DIR = 'plugin-state';

type PluginCommandHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type PluginEventHandler = (payload: unknown) => unknown | Promise<unknown>;
type RegisteredCommand = { pluginId: string; handler: PluginCommandHandler };
type RegisteredEventHandler = { pluginId: string; handler: PluginEventHandler };

export type PluginLoaderOptions = {
  builtinPluginsDir?: string | null;
  userPluginsDir?: string | null;
};

type LoadedPluginRecord = {
  plugin: AnyPlugin;
  manifest: PluginManifest;
  source: 'node_modules' | 'local';
  path: string;
  contributes?: PluginContributions;
  result: PluginLoadResult;
  active: boolean;
  lifecycle: PluginLifecycle;
};

function emptyRegistry(): PluginRegistry {
  return {
    caseParsers: [],
    subsysDiscoverers: [],
    coverageParsers: [],
    simulationRunners: [],
    simOptionSchemaProviders: [],
    uiPlugins: [],
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
    (m.apiVersion === undefined || m.apiVersion === '1.0') &&
    ['case-parser', 'subsys-discoverer', 'coverage-parser', 'simulation-runner', 'sim-option-schema', 'ui'].includes(m.kind)
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
      if (
        typeof p.run === 'function' &&
        typeof p.getStatus === 'function' &&
        typeof p.getCompileErrors === 'function' &&
        typeof p.abort === 'function'
      ) return plugin as SimulationRunnerPlugin;
      break;
    case 'sim-option-schema':
      if (typeof p.getSchema === 'function') return plugin as SimOptionSchemaProvider;
      break;
    case 'ui':
      if (typeof p.activate === 'function' || manifest.contributes) return plugin as UiPlugin;
      break;
  }
  return null;
}

function resolveContributions(manifest: PluginManifest, packageRoot: string): PluginContributions | undefined {
  const contributions = manifest.contributes;
  if (!contributions) return undefined;

  const views = contributions.views?.flatMap((view) => {
    if (!view || typeof view.id !== 'string' || typeof view.name !== 'string') return [];
    const html = view.html ?? (view.entry
      ? (() => {
          try {
            const target = resolve(packageRoot, view.entry);
            const rel = relative(packageRoot, target);
            if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
            return readFileSync(target, 'utf-8');
          } catch {
            return undefined;
          }
        })()
      : undefined);
    return [{ ...view, html }];
  });

  return {
    commands: contributions.commands?.filter((command) => (
      typeof command?.command === 'string' && typeof command.title === 'string'
    )),
    views,
  };
}

function resolvePluginPath(source: 'node_modules' | 'local', pluginPath: string, projectRoot: string): string {
  if (source === 'local') {
    return isAbsolute(pluginPath) ? pluginPath : resolve(projectRoot, pluginPath);
  }

  try {
    return createRequire(import.meta.url).resolve(pluginPath, { paths: [projectRoot] });
  } catch {
    return pluginPath;
  }
}

async function loadPluginModule(
  pluginPath: string,
): Promise<{ plugin: unknown; manifest: PluginManifest } | { error: string }> {
  try {
    const require = createRequire(import.meta.url);
    let mod: unknown;
    if (pluginPath.endsWith('.mjs')) {
      mod = await import(/* @vite-ignore */ `${pathToFileURL(pluginPath).href}?reload=${Date.now()}`);
    } else {
      const resolvedPath = require.resolve(pluginPath);
      delete require.cache[resolvedPath];
      try {
        mod = require(resolvedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_REQUIRE_ESM') throw error;
        mod = await import(/* @vite-ignore */ `${pathToFileURL(resolvedPath).href}?reload=${Date.now()}`);
      }
    }

    // The plugin module should export a default or named `plugin` / `default` object
    const moduleRecord = mod as Record<string, unknown> | null;
    const exported = moduleRecord?.default ?? moduleRecord?.plugin ?? mod;
    const manifest: unknown = (exported as Record<string, unknown> | null)?.manifest;

    if (!validateManifest(manifest)) {
      return { error: `Invalid or missing manifest in plugin at ${pluginPath}` };
    }

    return { plugin: exported, manifest };
  } catch (err) {
    return { error: `Failed to load plugin from ${pluginPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function manifestFromEntry(entry: PluginConfigEntry): PluginManifest {
  return {
    apiVersion: entry.apiVersion,
    id: entry.id,
    name: entry.name,
    version: entry.version,
    kind: entry.kind,
  };
}

function validateConfigEntry(entry: unknown): entry is PluginConfigEntry {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const value = entry as Record<string, unknown>;
  return validateManifest(value) &&
    (value.source === 'local' || value.source === 'node_modules') &&
    typeof value.path === 'string' &&
    typeof value.enabled === 'boolean';
}

function pluginTargetsMatch(
  left: PluginConfigEntry,
  right: PluginConfigEntry,
  projectRoot: string,
): boolean {
  return left.source === right.source &&
    resolvePluginPath(left.source, left.path, projectRoot) === resolvePluginPath(right.source, right.path, projectRoot);
}

class PluginLoaderImpl {
  private registries = new Map<string, PluginRegistry>();
  private loadResults = new Map<string, PluginLoadResult[]>();
  private loadedPlugins = new Map<string, Map<string, LoadedPluginRecord>>();
  private commandHandlers = new Map<string, Map<string, RegisteredCommand>>();
  private activePlugins = new Map<string, Map<string, PluginLifecycle>>();
  private eventHandlers = new Map<string, Map<PluginHostEvent, Set<RegisteredEventHandler>>>();
  private pluginStates = new Map<string, Map<string, Record<string, unknown>>>();
  private notifications = new Map<string, PluginNotification[]>();

  constructor(private readonly options: PluginLoaderOptions = {}) {}

  get userPluginsDir(): string | null {
    return this.options.userPluginsDir === undefined
      ? getDefaultUserPluginsDir()
      : this.options.userPluginsDir;
  }

  async loadPlugins(projectRoot: string): Promise<PluginLoadResult[]> {
    await this.deactivateProject(projectRoot);
    const config = await this.readPluginConfig(projectRoot);
    const results: PluginLoadResult[] = [];
    const registry = emptyRegistry();
    const commandHandlers = new Map<string, RegisteredCommand>();
    const activePlugins = new Map<string, PluginLifecycle>();
    const eventHandlers = new Map<PluginHostEvent, Set<RegisteredEventHandler>>();
    const loadedPlugins = new Map<string, LoadedPluginRecord>();
    this.eventHandlers.set(projectRoot, eventHandlers);

    const builtinPluginsDir = this.options.builtinPluginsDir === undefined
      ? getBuiltinPluginsDir()
      : this.options.builtinPluginsDir;
    const userPluginsDir = this.userPluginsDir;
    if (userPluginsDir) {
      try {
        await mkdir(userPluginsDir, { recursive: true });
      } catch (error) {
        console.warn(`[plugin-loader] failed to create user plugin directory ${userPluginsDir}:`, error);
      }
    }
    const builtinCandidates = discoverPluginPackages(builtinPluginsDir, 'builtin');
    const userCandidates = discoverPluginPackages(userPluginsDir, 'user');
    const candidates = new Map<string, PluginPackageCandidate>();
    for (const candidate of [...builtinCandidates, ...userCandidates]) {
      candidates.set(candidate.entry.id, candidate);
    }
    for (const entry of config.plugins) {
      const existing = candidates.get(entry.id);
      const origin: PluginOrigin = existing && pluginTargetsMatch(existing.entry, entry, projectRoot)
        ? existing.origin
        : 'project';
      const pluginPath = resolvePluginPath(entry.source, entry.path, projectRoot);
      candidates.set(entry.id, {
        entry,
        origin,
        packageRoot: existing && origin !== 'project' ? existing.packageRoot : dirname(pluginPath),
      });
    }
    console.log(
      `[plugin-loader] discovered ${builtinCandidates.length} built-in, ${userCandidates.length} user, ` +
      `${config.plugins.length} project plugin entries`,
    );

    for (const candidate of candidates.values()) {
      const { entry, origin } = candidate;
      if (!entry.enabled) {
        results.push({
          manifest: manifestFromEntry(entry),
          source: entry.source,
          origin,
          path: entry.path,
          enabled: false,
          active: false,
        });
        continue;
      }
      if (candidate.error) {
        results.push({
          manifest: manifestFromEntry(entry),
          source: entry.source,
          origin,
          path: entry.path,
          enabled: true,
          active: false,
          error: candidate.error,
        });
        continue;
      }

      const pluginPath = resolvePluginPath(entry.source, entry.path, projectRoot);

      if (!existsSync(pluginPath)) {
        results.push({
          manifest: manifestFromEntry(entry),
          source: entry.source,
          origin,
          path: entry.path,
          enabled: true,
          active: false,
          error: `Plugin path not found: ${pluginPath}`,
        });
        continue;
      }

      const loadResult = await loadPluginModule(pluginPath);
      if ('error' in loadResult) {
        results.push({
          manifest: manifestFromEntry(entry),
          source: entry.source,
          origin,
          path: entry.path,
          enabled: true,
          active: false,
          error: loadResult.error,
        });
        continue;
      }

      const { plugin, manifest } = loadResult;
      if (manifest.id !== entry.id || manifest.kind !== entry.kind) {
        results.push({
          manifest,
          source: entry.source,
          origin,
          path: entry.path,
          enabled: true,
          active: false,
          error: `Plugin manifest does not match package metadata: expected ${entry.id}/${entry.kind}`,
        });
        continue;
      }
      const classified = classifyPlugin(plugin, manifest);
      if (!classified) {
        results.push({
          manifest,
          source: entry.source,
          origin,
          path: entry.path,
          enabled: true,
          active: false,
          error: `Plugin does not implement required interface for kind: ${manifest.kind}`,
        });
        continue;
      }

      const contributes = resolveContributions(manifest, candidate.packageRoot);
      const result: PluginLoadResult = {
        manifest,
        plugin: classified,
        source: entry.source,
        origin,
        path: entry.path,
        enabled: true,
        contributes,
        active: false,
      };
      const record: LoadedPluginRecord = {
        plugin: classified,
        manifest,
        source: entry.source,
        path: entry.path,
        contributes,
        result,
        active: false,
        lifecycle: plugin as AnyPlugin & PluginLifecycle,
      };
      results.push(result);
      loadedPlugins.set(manifest.id, record);
    }

    this.registries.set(projectRoot, registry);
    this.loadResults.set(projectRoot, results);
    this.commandHandlers.set(projectRoot, commandHandlers);
    this.activePlugins.set(projectRoot, activePlugins);
    this.loadedPlugins.set(projectRoot, loadedPlugins);
    await this.activateForEvent(projectRoot, 'onStartupFinished');
    return results;
  }

  getRegistry(projectRoot: string): PluginRegistry {
    return this.registries.get(projectRoot) ?? emptyRegistry();
  }

  getLoadResults(projectRoot: string): PluginLoadResult[] {
    return this.loadResults.get(projectRoot) ?? [];
  }

  async activateForEvent(projectRoot: string, event: PluginHostEvent): Promise<void> {
    const records = [...(this.loadedPlugins.get(projectRoot)?.values() ?? [])];
    for (const record of records) {
      if (this.activationMatches(record.manifest, event)) {
        await this.activateRecord(projectRoot, record);
      }
    }
  }

  async activatePlugin(projectRoot: string, pluginId: string, event: PluginHostEvent): Promise<void> {
    const record = this.loadedPlugins.get(projectRoot)?.get(pluginId);
    if (record && this.activationMatches(record.manifest, event)) {
      await this.activateRecord(projectRoot, record);
    }
  }

  async activateForView(projectRoot: string, pluginId: string, viewId: string): Promise<void> {
    await this.activatePlugin(projectRoot, pluginId, `onView:${viewId}`);
  }

  async activateForCommand(projectRoot: string, command: string): Promise<void> {
    await this.activateForEvent(projectRoot, `onCommand:${command}`);
  }

  async executeCommand(
    projectRoot: string,
    command: string,
    args: unknown[] = [],
    callerPluginId?: string,
  ): Promise<unknown> {
    await this.activateForCommand(projectRoot, command);
    const registered = this.commandHandlers.get(projectRoot)?.get(command);
    if (!registered) throw new Error(`Plugin command not found: ${command}`);
    if (callerPluginId && registered.pluginId !== callerPluginId) {
      throw new Error(`Plugin ${callerPluginId} cannot invoke command owned by ${registered.pluginId}`);
    }
    return registered.handler(...args);
  }

  private activationMatches(manifest: PluginManifest, event: PluginHostEvent): boolean {
    const activationEvents = manifest.activationEvents;
    return !activationEvents || activationEvents.length === 0 || activationEvents.includes(event) || activationEvents.includes('*');
  }

  private async activateRecord(projectRoot: string, record: LoadedPluginRecord): Promise<void> {
    if (record.active || record.result.error) return;

    const commandHandlers = this.commandHandlers.get(projectRoot) ?? new Map<string, RegisteredCommand>();
    const eventHandlers = this.eventHandlers.get(projectRoot) ?? new Map<PluginHostEvent, Set<RegisteredEventHandler>>();
    const state = await this.loadPluginState(projectRoot, record.manifest.id);
    try {
      await record.lifecycle.activate?.({
        pluginId: record.manifest.id,
        projectRoot,
        registerCommand: (command, handler) => {
          if (typeof command === 'string' && typeof handler === 'function') {
            const existing = commandHandlers.get(command);
            if (existing && existing.pluginId !== record.manifest.id) {
              throw new Error(`Plugin command already registered by ${existing.pluginId}: ${command}`);
            }
            commandHandlers.set(command, { pluginId: record.manifest.id, handler });
          }
        },
        on: (event, handler) => {
          const handlers = eventHandlers.get(event) ?? new Set<RegisteredEventHandler>();
          const registered = { pluginId: record.manifest.id, handler };
          handlers.add(registered);
          eventHandlers.set(event, handlers);
          return () => handlers.delete(registered);
        },
        getState: async <T>(key: string) => state[key] as T | undefined,
        setState: async <T>(key: string, value: T) => {
          state[key] = value;
          await this.savePluginState(projectRoot, record.manifest.id, state);
        },
        notify: (notification) => this.pushNotification(projectRoot, notification),
        readFile: (filePath) => this.readProjectFile(projectRoot, filePath),
        writeFile: (filePath, content) => this.writeProjectFile(projectRoot, filePath, content),
      });
      this.commandHandlers.set(projectRoot, commandHandlers);
      this.eventHandlers.set(projectRoot, eventHandlers);
      const activePlugins = this.activePlugins.get(projectRoot) ?? new Map<string, PluginLifecycle>();
      if (record.lifecycle.activate || record.lifecycle.deactivate) {
        activePlugins.set(record.manifest.id, record.lifecycle);
      }
      this.activePlugins.set(projectRoot, activePlugins);
      this.registerPlugin(projectRoot, record);
      record.active = true;
      record.result.active = true;
    } catch (err) {
      for (const [command, registered] of commandHandlers) {
        if (registered.pluginId === record.manifest.id) commandHandlers.delete(command);
      }
      for (const handlers of eventHandlers.values()) {
        for (const registered of handlers) {
          if (registered.pluginId === record.manifest.id) handlers.delete(registered);
        }
      }
      record.result.error = `Failed to activate plugin ${record.manifest.id}: ${err instanceof Error ? err.message : String(err)}`;
      record.result.active = false;
      this.pushNotification(projectRoot, {
        level: 'error',
        message: record.result.error,
      });
    }
  }

  private registerPlugin(projectRoot: string, record: LoadedPluginRecord): void {
    const registry = this.registries.get(projectRoot);
    if (!registry) return;
    switch (record.manifest.kind) {
      case 'case-parser':
        if (!registry.caseParsers.some((plugin) => plugin.manifest.id === record.manifest.id)) {
          registry.caseParsers.push(record.plugin as CaseParserPlugin);
        }
        break;
      case 'subsys-discoverer':
        if (!registry.subsysDiscoverers.some((plugin) => plugin.manifest.id === record.manifest.id)) {
          registry.subsysDiscoverers.push(record.plugin as SubsysDiscoveryPlugin);
        }
        break;
      case 'coverage-parser':
        if (!registry.coverageParsers.some((plugin) => plugin.manifest.id === record.manifest.id)) {
          registry.coverageParsers.push(record.plugin as CoverageParserPlugin);
        }
        break;
      case 'simulation-runner':
        if (!registry.simulationRunners.some((plugin) => plugin.manifest.id === record.manifest.id)) {
          registry.simulationRunners.push(record.plugin as SimulationRunnerPlugin);
        }
        break;
      case 'sim-option-schema':
        if (!registry.simOptionSchemaProviders.some((plugin) => plugin.manifest.id === record.manifest.id)) {
          registry.simOptionSchemaProviders.push(record.plugin as SimOptionSchemaProvider);
        }
        break;
      case 'ui':
        if (!registry.uiPlugins?.some((plugin) => plugin.manifest.id === record.manifest.id)) {
          registry.uiPlugins?.push(record.plugin as UiPlugin);
        }
        break;
    }
  }

  async emitEvent(projectRoot: string, event: PluginHostEvent, payload: unknown = {}): Promise<void> {
    const handlers = [...(this.eventHandlers.get(projectRoot)?.get(event) ?? [])];
    for (const registered of handlers) {
      try {
        await registered.handler(payload);
      } catch (err) {
        this.pushNotification(projectRoot, {
          level: 'error',
          message: `Plugin ${registered.pluginId} event handler failed: ${event}`,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  getNotifications(projectRoot: string): PluginNotification[] {
    return [...(this.notifications.get(projectRoot) ?? [])];
  }

  clearNotifications(projectRoot: string): void {
    this.notifications.delete(projectRoot);
  }

  async deactivateProject(projectRoot: string): Promise<void> {
    const activePlugins = this.activePlugins.get(projectRoot);
    if (!activePlugins) return;
    for (const [pluginId, lifecycle] of activePlugins) {
      try {
        await lifecycle.deactivate?.();
      } catch (err) {
        this.pushNotification(projectRoot, {
          level: 'error',
          message: `Failed to deactivate plugin ${pluginId}`,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.activePlugins.delete(projectRoot);
    this.eventHandlers.delete(projectRoot);
    this.commandHandlers.delete(projectRoot);
  }

  async deactivateAll(): Promise<void> {
    for (const projectRoot of [...this.activePlugins.keys()]) {
      await this.deactivateProject(projectRoot);
    }
  }

  private async loadPluginState(projectRoot: string, pluginId: string): Promise<Record<string, unknown>> {
    const projectStates = this.pluginStates.get(projectRoot) ?? new Map<string, Record<string, unknown>>();
    const existing = projectStates.get(pluginId);
    if (existing) return existing;

    const statePath = join(projectRoot, SOCVERIFY_DIR, PLUGIN_STATE_DIR, `${encodeURIComponent(pluginId)}.json`);
    let state: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(statePath, 'utf-8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        state = parsed as Record<string, unknown>;
      }
    } catch {
      // Missing or invalid state starts from an empty object.
    }
    projectStates.set(pluginId, state);
    this.pluginStates.set(projectRoot, projectStates);
    return state;
  }

  private async savePluginState(projectRoot: string, pluginId: string, state: Record<string, unknown>): Promise<void> {
    const stateDir = join(projectRoot, SOCVERIFY_DIR, PLUGIN_STATE_DIR);
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, `${encodeURIComponent(pluginId)}.json`), JSON.stringify(state, null, 2), 'utf-8');
  }

  private projectPath(projectRoot: string, filePath: string): string {
    if (isAbsolute(filePath)) throw new Error('Plugin file access requires a project-relative path');
    const target = resolve(projectRoot, filePath);
    const rel = relative(projectRoot, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Plugin file access is limited to the project directory');
    }
    return target;
  }

  private readProjectFile(projectRoot: string, filePath: string): Promise<string> {
    return readFile(this.projectPath(projectRoot, filePath), 'utf-8');
  }

  private async writeProjectFile(projectRoot: string, filePath: string, content: string): Promise<void> {
    const target = this.projectPath(projectRoot, filePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf-8');
  }

  private pushNotification(projectRoot: string, notification: PluginNotification): void {
    const notifications = this.notifications.get(projectRoot) ?? [];
    notifications.push(notification);
    if (notifications.length > 100) notifications.splice(0, notifications.length - 100);
    this.notifications.set(projectRoot, notifications);
  }

  async readPluginConfig(projectRoot: string): Promise<PluginConfig> {
    const configPath = join(projectRoot, SOCVERIFY_DIR, PLUGIN_CONFIG_FILE);
    try {
      const parsed: unknown = JSON.parse(await readFile(configPath, 'utf-8'));
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { plugins?: unknown }).plugins)) {
        return { plugins: [] };
      }
      return {
        plugins: (parsed as { plugins: unknown[] }).plugins.filter(validateConfigEntry),
      };
    } catch {
      return { plugins: [] };
    }
  }

  async savePluginConfig(projectRoot: string, config: PluginConfig): Promise<void> {
    const configDir = join(projectRoot, SOCVERIFY_DIR);
    if (!existsSync(configDir)) {
      await mkdir(configDir, { recursive: true });
    }
    const configPath = join(configDir, PLUGIN_CONFIG_FILE);
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  async setPluginEnabled(projectRoot: string, pluginId: string, enabled: boolean): Promise<PluginConfigEntry> {
    const config = await this.readPluginConfig(projectRoot);
    let entry = config.plugins.find((plugin) => plugin.id === pluginId);
    if (!entry) {
      const result = this.getLoadResults(projectRoot).find((plugin) => plugin.manifest.id === pluginId);
      if (!result) throw new Error(`Plugin not found: ${pluginId}`);
      entry = {
        id: result.manifest.id,
        apiVersion: result.manifest.apiVersion,
        name: result.manifest.name,
        version: result.manifest.version,
        kind: result.manifest.kind,
        source: result.source,
        path: result.path,
        enabled,
      };
      config.plugins.push(entry);
    } else {
      entry.enabled = enabled;
    }
    await this.savePluginConfig(projectRoot, config);
    return entry;
  }

  /**
   * 获取指定类型的已加载插件的解析后绝对路径。
   * 用于 Worker Thread 等需要独立加载插件模块的场景。
   */
  getResolvedPluginPath(projectRoot: string, kind: string): string | null {
    const records = this.loadedPlugins.get(projectRoot);
    if (!records) return null;
    for (const record of records.values()) {
      if (record.manifest.kind === kind && !record.result.error) {
        return resolvePluginPath(record.source, record.path, projectRoot);
      }
    }
    return null;
  }

  clearProject(projectRoot: string): void {
    void this.deactivateProject(projectRoot);
    this.registries.delete(projectRoot);
    this.loadResults.delete(projectRoot);
    this.loadedPlugins.delete(projectRoot);
    this.commandHandlers.delete(projectRoot);
    this.pluginStates.delete(projectRoot);
    this.notifications.delete(projectRoot);
  }

  clearAll(): void {
    this.registries.clear();
    this.loadResults.clear();
    this.loadedPlugins.clear();
    this.commandHandlers.clear();
    this.activePlugins.clear();
    this.eventHandlers.clear();
    this.pluginStates.clear();
    this.notifications.clear();
  }
}

export function createPluginLoader(options: PluginLoaderOptions = {}): PluginLoaderImpl {
  return new PluginLoaderImpl(options);
}

export const pluginLoader = createPluginLoader();
