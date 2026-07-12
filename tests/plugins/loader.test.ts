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
    it('returns empty array when no plugins configured', async () => {
      const results = await pluginLoader.loadPlugins(tempDir);
      expect(results).toEqual([]);
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
      expect(results).toHaveLength(1);
      expect(results[0].error).toBeDefined();
      expect(results[0].error).toContain('not found');
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
      expect(results).toHaveLength(1);
      expect(results[0].error).toBeUndefined();
      expect(results[0].manifest.kind).toBe('subsys-discoverer');

      // Verify it's in the registry
      const registry = pluginLoader.getRegistry(tempDir);
      expect(registry.subsysDiscoverers).toHaveLength(1);
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
      expect(results).toHaveLength(0);
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
