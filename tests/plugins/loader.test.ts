import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { pluginLoader } from '../../src/main/plugins/loader';

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
    it('loads bundled plugins when no project plugins are configured', async () => {
      const results = await pluginLoader.loadPlugins(tempDir);

      expect(results.some((result) => result.manifest.id === 'unisoc-subsys-discoverer')).toBe(true);
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

    it('skips disabled plugins', async () => {
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
      expect(results.some((result) => result.manifest.id === 'disabled-plugin')).toBe(false);
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
