import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { createPluginLoader, pluginLoader } from '../../src/main/plugins/loader';

describe('PluginLoader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'socverify-test-'));
  });

  afterEach(async () => {
    pluginLoader.clearAll();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('readPluginConfig', () => {
    it('returns empty config when .socverify/plugins.json does not exist', async () => {
      const config = await pluginLoader.readPluginConfig(tempDir);
      expect(config.plugins).toEqual([]);
    });

    it('reads plugin config from .socverify/plugins.json', async () => {
      const socverifyDir = join(tempDir, '.socverify');
      await mkdir(socverifyDir, { recursive: true });
      await writeFile(
        join(socverifyDir, 'plugins.json'),
        JSON.stringify({
          plugins: [
            {
              id: 'test-plugin',
              name: 'Test Plugin',
              version: '1.0.0',
              kind: 'subsys-discoverer',
              source: 'local',
              path: './plugins/test.js',
              enabled: true,
            },
          ],
        }),
        'utf-8',
      );

      const config = await pluginLoader.readPluginConfig(tempDir);
      expect(config.plugins).toHaveLength(1);
      expect(config.plugins[0].id).toBe('test-plugin');
      expect(config.plugins[0].kind).toBe('subsys-discoverer');
    });
  });

  describe('savePluginConfig', () => {
    it('creates .socverify directory and saves config', async () => {
      await pluginLoader.savePluginConfig(tempDir, {
        plugins: [
          {
            id: 'new-plugin',
            name: 'New Plugin',
            version: '2.0.0',
            kind: 'case-parser',
            source: 'node_modules',
            path: '@socverify/case-parser',
            enabled: true,
          },
        ],
      });

      const configPath = join(tempDir, '.socverify', 'plugins.json');
      expect(existsSync(configPath)).toBe(true);
    });
  });

  describe('loadPlugins', () => {
    it('discovers user plugins without project configuration', async () => {
      const userPluginsDir = join(tempDir, 'user-plugins');
      const pluginDir = join(userPluginsDir, 'user-dashboard');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({
          name: 'user-dashboard',
          version: '1.2.3',
          main: 'index.cjs',
          socverify: { apiVersion: '1.0', id: 'user-dashboard', kind: 'ui' },
        }),
        'utf-8',
      );
      await writeFile(
        join(pluginDir, 'index.cjs'),
        `module.exports = {
  manifest: { apiVersion: '1.0', id: 'user-dashboard', name: 'User Dashboard', version: '1.2.3', kind: 'ui', contributes: { views: [] } }
};`,
        'utf-8',
      );
      const loader = createPluginLoader({ builtinPluginsDir: null, userPluginsDir });

      const results = await loader.loadPlugins(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        origin: 'user',
        enabled: true,
        active: true,
        manifest: { id: 'user-dashboard', version: '1.2.3' },
      });

      await loader.setPluginEnabled(tempDir, 'user-dashboard', false);
      const disabledResults = await loader.loadPlugins(tempDir);
      expect(disabledResults[0]).toMatchObject({
        origin: 'user',
        enabled: false,
        active: false,
      });
      loader.clearAll();
    });

    it('lets project configuration override a user plugin with the same id', async () => {
      const userPluginsDir = join(tempDir, 'user-plugins');
      const userPluginDir = join(userPluginsDir, 'shared-plugin');
      const projectPluginDir = join(tempDir, 'project-plugin');
      await mkdir(userPluginDir, { recursive: true });
      await mkdir(projectPluginDir, { recursive: true });
      await writeFile(
        join(userPluginDir, 'package.json'),
        JSON.stringify({
          name: 'shared-plugin',
          version: '1.0.0',
          main: 'index.cjs',
          socverify: { apiVersion: '1.0', id: 'shared-plugin', kind: 'ui' },
        }),
        'utf-8',
      );
      await writeFile(
        join(userPluginDir, 'index.cjs'),
        `module.exports = { manifest: { apiVersion: '1.0', id: 'shared-plugin', name: 'User Plugin', version: '1.0.0', kind: 'ui', contributes: {} } };`,
        'utf-8',
      );
      await writeFile(
        join(projectPluginDir, 'index.cjs'),
        `module.exports = { manifest: { apiVersion: '1.0', id: 'shared-plugin', name: 'Project Plugin', version: '2.0.0', kind: 'ui', contributes: {} } };`,
        'utf-8',
      );
      await mkdir(join(tempDir, '.socverify'), { recursive: true });
      await writeFile(
        join(tempDir, '.socverify', 'plugins.json'),
        JSON.stringify({ plugins: [{
          id: 'shared-plugin',
          name: 'Project Plugin',
          version: '2.0.0',
          kind: 'ui',
          source: 'local',
          path: join(projectPluginDir, 'index.cjs'),
          enabled: true,
        }] }),
        'utf-8',
      );
      const loader = createPluginLoader({ builtinPluginsDir: null, userPluginsDir });

      const results = await loader.loadPlugins(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        origin: 'project',
        manifest: { id: 'shared-plugin', version: '2.0.0' },
      });
      loader.clearAll();
    });

    it('isolates malformed user packages and continues loading healthy plugins', async () => {
      const userPluginsDir = join(tempDir, 'user-plugins');
      const brokenDir = join(userPluginsDir, 'broken-plugin');
      const healthyDir = join(userPluginsDir, 'healthy-plugin');
      await mkdir(brokenDir, { recursive: true });
      await mkdir(healthyDir, { recursive: true });
      await writeFile(join(brokenDir, 'package.json'), '{ not json', 'utf-8');
      await writeFile(
        join(healthyDir, 'package.json'),
        JSON.stringify({
          name: 'healthy-plugin',
          version: '1.0.0',
          main: 'index.cjs',
          socverify: { apiVersion: '1.0', id: 'healthy-plugin', kind: 'ui' },
        }),
        'utf-8',
      );
      await writeFile(
        join(healthyDir, 'index.cjs'),
        `module.exports = { manifest: { apiVersion: '1.0', id: 'healthy-plugin', name: 'Healthy Plugin', version: '1.0.0', kind: 'ui', contributes: {} } };`,
        'utf-8',
      );
      const loader = createPluginLoader({ builtinPluginsDir: null, userPluginsDir });

      const results = await loader.loadPlugins(tempDir);

      expect(results.find((result) => result.manifest.id === 'healthy-plugin')?.error).toBeUndefined();
      expect(results.find((result) => result.manifest.id === 'broken-plugin')?.error).toContain('Invalid package.json');
      loader.clearAll();
    });

    it('rolls back registrations from a plugin that fails activation', async () => {
      const pluginDir = join(tempDir, 'plugins');
      await mkdir(pluginDir, { recursive: true });
      const pluginPath = join(pluginDir, 'broken-activation.cjs');
      await writeFile(
        pluginPath,
        `module.exports = {
  manifest: { apiVersion: '1.0', id: 'broken-activation', name: 'Broken Activation', version: '1.0.0', kind: 'ui', contributes: {} },
  activate(context) {
    context.registerCommand('broken-activation.partial', () => 'should not run');
    context.on('test.event', () => { throw new Error('should not run'); });
    throw new Error('activation failed');
  }
};`,
        'utf-8',
      );
      await mkdir(join(tempDir, '.socverify'), { recursive: true });
      await writeFile(
        join(tempDir, '.socverify', 'plugins.json'),
        JSON.stringify({ plugins: [{
          id: 'broken-activation',
          apiVersion: '1.0',
          name: 'Broken Activation',
          version: '1.0.0',
          kind: 'ui',
          source: 'local',
          path: pluginPath,
          enabled: true,
        }] }),
        'utf-8',
      );
      const loader = createPluginLoader({ builtinPluginsDir: null, userPluginsDir: null });

      const results = await loader.loadPlugins(tempDir);

      expect(results[0].error).toContain('activation failed');
      await expect(loader.executeCommand(tempDir, 'broken-activation.partial')).rejects.toThrow('not found');
      const notificationCount = loader.getNotifications(tempDir).length;
      await loader.emitEvent(tempDir, 'test.event');
      expect(loader.getNotifications(tempDir)).toHaveLength(notificationCount);
      loader.clearAll();
    });

    it('keeps a project-disabled user plugin visible but out of the registry', async () => {
      const userPluginsDir = join(tempDir, 'user-plugins');
      const pluginDir = join(userPluginsDir, 'user-discoverer');
      const pluginPath = join(pluginDir, 'index.cjs');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({
          name: 'user-discoverer',
          version: '1.0.0',
          main: 'index.cjs',
          socverify: { apiVersion: '1.0', id: 'user-discoverer', kind: 'subsys-discoverer' },
        }),
        'utf-8',
      );
      await writeFile(
        pluginPath,
        `module.exports = {
  manifest: { apiVersion: '1.0', id: 'user-discoverer', name: 'User Discoverer', version: '1.0.0', kind: 'subsys-discoverer' },
  async discover() { return []; }
};`,
        'utf-8',
      );
      await mkdir(join(tempDir, '.socverify'), { recursive: true });
      await writeFile(
        join(tempDir, '.socverify', 'plugins.json'),
        JSON.stringify({ plugins: [{
          id: 'user-discoverer',
          name: 'User Discoverer',
          version: '1.0.0',
          kind: 'subsys-discoverer',
          source: 'local',
          path: pluginPath,
          enabled: false,
        }] }),
        'utf-8',
      );
      const loader = createPluginLoader({ builtinPluginsDir: null, userPluginsDir });

      const results = await loader.loadPlugins(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ origin: 'user', enabled: false, active: false });
      expect(loader.getRegistry(tempDir).subsysDiscoverers).toEqual([]);
      loader.clearAll();
    });

    it('loads bundled plugins when no project plugins are configured', async () => {
      const results = await pluginLoader.loadPlugins(tempDir);

      expect(results.some((result) => result.manifest.id === 'unisoc-subsys-discoverer')).toBe(true);
      expect(results.find((result) => result.manifest.id === 'unisoc-subsys-discoverer')?.manifest.apiVersion).toBe('1.0');
      expect(results.every((result) => result.manifest.apiVersion === '1.0')).toBe(true);
      expect(
        pluginLoader
          .getRegistry(tempDir)
          .subsysDiscoverers.some(
            (plugin) => plugin.manifest.id === 'unisoc-subsys-discoverer',
          ),
      ).toBe(true);
    });

    it('returns error result for non-existent plugin path', async () => {
      const socverifyDir = join(tempDir, '.socverify');
      await mkdir(socverifyDir, { recursive: true });
      await writeFile(
        join(socverifyDir, 'plugins.json'),
        JSON.stringify({
          plugins: [
            {
              id: 'missing-plugin',
              name: 'Missing Plugin',
              version: '1.0.0',
              kind: 'subsys-discoverer',
              source: 'local',
              path: './non-existent.js',
              enabled: true,
            },
          ],
        }),
        'utf-8',
      );

      const results = await pluginLoader.loadPlugins(tempDir);
      const missingPlugin = results.find((result) => result.manifest.id === 'missing-plugin');
      expect(missingPlugin?.error).toBeDefined();
      expect(missingPlugin?.error).toContain('not found');
    });

    it('loads a valid subsys-discoverer plugin', async () => {
      // Create a mock plugin file
      const pluginDir = join(tempDir, 'plugins');
      await mkdir(pluginDir, { recursive: true });
      const pluginPath = join(pluginDir, 'mock-discoverer.mjs');
      await writeFile(
        pluginPath,
        `export default {
  manifest: {
    id: 'mock-discoverer',
    name: 'Mock Discoverer',
    version: '1.0.0',
    kind: 'subsys-discoverer',
  },
  async discover(projectRoot) {
    return [{ id: 'cpu', name: 'cpu', path: projectRoot + '/cpu', kind: 'subsys' }];
  },
};`,
        'utf-8',
      );

      // Create config
      const socverifyDir = join(tempDir, '.socverify');
      await mkdir(socverifyDir, { recursive: true });
      await writeFile(
        join(socverifyDir, 'plugins.json'),
        JSON.stringify({
          plugins: [
            {
              id: 'mock-discoverer',
              name: 'Mock Discoverer',
              version: '1.0.0',
              kind: 'subsys-discoverer',
              source: 'local',
              path: pluginPath,
              enabled: true,
            },
          ],
        }),
        'utf-8',
      );

      const results = await pluginLoader.loadPlugins(tempDir);
      const mockPlugin = results.find((result) => result.manifest.id === 'mock-discoverer');
      expect(mockPlugin?.error).toBeUndefined();
      expect(mockPlugin?.manifest.kind).toBe('subsys-discoverer');

      // Verify it's in the registry
      const registry = pluginLoader.getRegistry(tempDir);
      expect(
        registry.subsysDiscoverers.some(
          (plugin) => plugin.manifest.id === 'mock-discoverer',
        ),
      ).toBe(true);
    });

    it('resolves plugins declared by package name from the project node_modules', async () => {
      const packageDir = join(tempDir, 'node_modules', '@example', 'mock-plugin');
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: '@example/mock-plugin', main: 'index.cjs' }),
        'utf-8',
      );
      await writeFile(
        join(packageDir, 'index.cjs'),
        `module.exports = { manifest: { id: 'node-module-plugin', name: 'Node Module Plugin', version: '1.0.0', kind: 'ui', contributes: { views: [] } } };`,
        'utf-8',
      );

      const socverifyDir = join(tempDir, '.socverify');
      await mkdir(socverifyDir, { recursive: true });
      await writeFile(
        join(socverifyDir, 'plugins.json'),
        JSON.stringify({
          plugins: [{
            id: 'node-module-plugin',
            name: 'Node Module Plugin',
            version: '1.0.0',
            kind: 'ui',
            source: 'node_modules',
            path: '@example/mock-plugin',
            enabled: true,
          }],
        }),
        'utf-8',
      );

      const results = await pluginLoader.loadPlugins(tempDir);
      const plugin = results.find((result) => result.manifest.id === 'node-module-plugin');
      expect(plugin?.error).toBeUndefined();
    });

    it('keeps disabled project plugins visible without loading them', async () => {
      const socverifyDir = join(tempDir, '.socverify');
      await mkdir(socverifyDir, { recursive: true });
      await writeFile(
        join(socverifyDir, 'plugins.json'),
        JSON.stringify({
          plugins: [
            {
              id: 'disabled-plugin',
              name: 'Disabled Plugin',
              version: '1.0.0',
              kind: 'case-parser',
              source: 'local',
              path: './disabled.js',
              enabled: false,
            },
          ],
        }),
        'utf-8',
      );

      const results = await pluginLoader.loadPlugins(tempDir);
      expect(results.find((result) => result.manifest.id === 'disabled-plugin')).toMatchObject({
        enabled: false,
        active: false,
      });
      expect(
        pluginLoader.getRegistry(tempDir).caseParsers.some(
          (plugin) => plugin.manifest.id === 'disabled-plugin',
        ),
      ).toBe(false);
    });

    it('loads a UI-only plugin, resolves its view HTML, and activates commands', async () => {
      const pluginDir = join(tempDir, 'plugins');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, 'view.html'), '<button>Plugin UI</button>', 'utf-8');
      const pluginPath = join(pluginDir, 'ui-plugin.cjs');
      await writeFile(
        pluginPath,
        `module.exports = {
  manifest: {
    id: 'ui-plugin',
    name: 'UI Plugin',
    version: '1.0.0',
    kind: 'ui',
    contributes: {
      commands: [{ command: 'ui-plugin.hello', title: 'Hello' }],
      views: [{ id: 'hello', name: 'Hello View', location: 'center', entry: 'view.html' }]
    }
  },
  activate(context) {
    context.registerCommand('ui-plugin.hello', (name) => 'hello ' + name);
  }
};`,
        'utf-8',
      );

      const socverifyDir = join(tempDir, '.socverify');
      await mkdir(socverifyDir, { recursive: true });
      await writeFile(
        join(socverifyDir, 'plugins.json'),
        JSON.stringify({
          plugins: [{
            id: 'ui-plugin',
            name: 'UI Plugin',
            version: '1.0.0',
            kind: 'ui',
            source: 'local',
            path: pluginPath,
            enabled: true,
          }],
        }),
        'utf-8',
      );

      const results = await pluginLoader.loadPlugins(tempDir);
      const plugin = results.find((result) => result.manifest.id === 'ui-plugin');
      expect(plugin?.error).toBeUndefined();
      expect(plugin?.contributes?.views?.[0].html).toContain('Plugin UI');
      await expect(pluginLoader.executeCommand(tempDir, 'ui-plugin.hello', ['world'])).resolves.toBe('hello world');
      await expect(
        pluginLoader.executeCommand(tempDir, 'ui-plugin.hello', ['world'], 'other-plugin'),
      ).rejects.toThrow('cannot invoke command owned by ui-plugin');
    });

    it('exposes state, events, notifications, and guarded project file access to plugins', async () => {
      const pluginDir = join(tempDir, 'plugins');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(tempDir, 'input.txt'), 'from project', 'utf-8');
      const pluginPath = join(pluginDir, 'host-api-plugin.cjs');
      await writeFile(
        pluginPath,
        `module.exports = {
  manifest: { id: 'host-api-plugin', name: 'Host API Plugin', version: '1.0.0', kind: 'ui', contributes: {} },
  async activate(context) {
    context.on('test.event', async () => context.setState('event', 'seen'));
    context.notify({ level: 'info', message: 'activated' });
    context.registerCommand('host-api.read', () => context.readFile('input.txt'));
    context.registerCommand('host-api.read-path', (path) => context.readFile(String(path)));
    context.registerCommand('host-api.state', () => context.getState('event'));
  }
};`,
        'utf-8',
      );

      const socverifyDir = join(tempDir, '.socverify');
      await mkdir(socverifyDir, { recursive: true });
      await writeFile(
        join(socverifyDir, 'plugins.json'),
        JSON.stringify({
          plugins: [{
            id: 'host-api-plugin',
            name: 'Host API Plugin',
            version: '1.0.0',
            kind: 'ui',
            source: 'local',
            path: pluginPath,
            enabled: true,
          }],
        }),
        'utf-8',
      );

      await pluginLoader.loadPlugins(tempDir);
      await expect(pluginLoader.executeCommand(tempDir, 'host-api.read')).resolves.toBe('from project');
      await pluginLoader.emitEvent(tempDir, 'test.event');
      await expect(pluginLoader.executeCommand(tempDir, 'host-api.state')).resolves.toBe('seen');
      expect(pluginLoader.getNotifications(tempDir)).toEqual([{ level: 'info', message: 'activated' }]);
      await expect(pluginLoader.executeCommand(tempDir, 'host-api.read-path', ['../package.json'])).rejects.toThrow('limited to the project directory');
    });

    it('activates lazy plugins on declared events and deactivates them during reload', async () => {
      const pluginDir = join(tempDir, 'plugins');
      await mkdir(pluginDir, { recursive: true });
      const pluginPath = join(pluginDir, 'lazy-plugin.cjs');
      await writeFile(
        pluginPath,
        `let activations = 0;
module.exports = {
  manifest: {
    apiVersion: '1.0',
    id: 'lazy-plugin',
    name: 'Lazy Plugin',
    version: '1.0.0',
    kind: 'ui',
    activationEvents: ['onView:overview'],
    contributes: { views: [{ id: 'overview', name: 'Overview', location: 'center' }] }
  },
  activate(context) {
    activations += 1;
    context.registerCommand('lazy-plugin.status', () => activations);
  },
  deactivate() {}
};`,
        'utf-8',
      );

      const socverifyDir = join(tempDir, '.socverify');
      await mkdir(socverifyDir, { recursive: true });
      await writeFile(
        join(socverifyDir, 'plugins.json'),
        JSON.stringify({
          plugins: [{
            id: 'lazy-plugin',
            name: 'Lazy Plugin',
            version: '1.0.0',
            kind: 'ui',
            source: 'local',
            path: pluginPath,
            enabled: true,
          }],
        }),
        'utf-8',
      );

      const firstLoad = await pluginLoader.loadPlugins(tempDir);
      expect(firstLoad.find((result) => result.manifest.id === 'lazy-plugin')?.active).toBe(false);
      await expect(pluginLoader.executeCommand(tempDir, 'lazy-plugin.status')).rejects.toThrow('not found');

      await pluginLoader.activateForView(tempDir, 'lazy-plugin', 'overview');
      expect(firstLoad.find((result) => result.manifest.id === 'lazy-plugin')?.active).toBe(true);
      await expect(pluginLoader.executeCommand(tempDir, 'lazy-plugin.status')).resolves.toBe(1);

      const secondLoad = await pluginLoader.loadPlugins(tempDir);
      await pluginLoader.activateForView(tempDir, 'lazy-plugin', 'overview');
      expect(secondLoad.find((result) => result.manifest.id === 'lazy-plugin')?.active).toBe(true);
      await expect(pluginLoader.executeCommand(tempDir, 'lazy-plugin.status')).resolves.toBe(1);
    });
  });

  describe('getRegistry', () => {
    it('returns empty registry for unloaded project', () => {
      const registry = pluginLoader.getRegistry(tempDir);
      expect(registry.caseParsers).toEqual([]);
      expect(registry.subsysDiscoverers).toEqual([]);
      expect(registry.coverageParsers).toEqual([]);
      expect(registry.simulationRunners).toEqual([]);
      expect(registry.simOptionSchemaProviders).toEqual([]);
    });
  });
});
