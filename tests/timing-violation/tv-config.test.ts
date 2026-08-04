import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadTvConfig,
  saveTvConfig,
  getConfigPath,
  getDbPath,
  DEFAULT_TV_CONFIG,
} from '../../src/main/timing-violation/tv-config';
import type { TvConfig } from '../../src/main/timing-violation/types';

describe('TV Config Management', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tmpdir() + `/sv-tv-config-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('DEFAULT_TV_CONFIG', () => {
    it('has all required fields', () => {
      expect(DEFAULT_TV_CONFIG.dbPath).toBe('.socverify/timing-violation/tv.db');
      expect(Array.isArray(DEFAULT_TV_CONFIG.corners)).toBe(true);
      expect(DEFAULT_TV_CONFIG.corners.length).toBeGreaterThan(0);
      expect(Array.isArray(DEFAULT_TV_CONFIG.subsysPatterns)).toBe(true);
      expect(DEFAULT_TV_CONFIG.defaultResetTimeNs).toBe(1000);
      expect(DEFAULT_TV_CONFIG.autoBackup).toBe(true);
      expect(DEFAULT_TV_CONFIG.backupInterval).toBe(100);
    });
  });

  describe('getConfigPath', () => {
    it('returns config path under project root', () => {
      const path = getConfigPath(tmpDir);
      expect(path).toBe(join(tmpDir, '.socverify', 'timing-violation', 'config.json'));
    });
  });

  describe('getDbPath', () => {
    it('resolves db path relative to project root', () => {
      const path = getDbPath(tmpDir);
      expect(path).toContain('.socverify');
      expect(path).toContain('timing-violation');
      expect(path).toContain('tv.db');
    });

    it('uses custom dbPath when provided', () => {
      const path = getDbPath(tmpDir, 'custom/path/tv.db');
      expect(path).toContain('custom');
      expect(path).toContain('tv.db');
    });
  });

  describe('loadTvConfig', () => {
    it('returns default config when config file does not exist', () => {
      const config = loadTvConfig(tmpDir);
      expect(config.dbPath).toBe(DEFAULT_TV_CONFIG.dbPath);
      expect(config.corners).toEqual(DEFAULT_TV_CONFIG.corners);
      expect(config.defaultResetTimeNs).toBe(DEFAULT_TV_CONFIG.defaultResetTimeNs);
    });

    it('returns default config when JSON is invalid', () => {
      const configPath = getConfigPath(tmpDir);
      mkdirSync(join(tmpDir, '.socverify', 'timing-violation'), { recursive: true });
      // Write invalid JSON
      const { writeFileSync } = require('node:fs');
      writeFileSync(configPath, '{ invalid json }', 'utf-8');

      const config = loadTvConfig(tmpDir);
      expect(config.dbPath).toBe(DEFAULT_TV_CONFIG.dbPath);
    });

    it('merges saved config with defaults', () => {
      const customConfig: TvConfig = {
        dbPath: 'custom/tv.db',
        corners: ['custom_corner'],
        subsysPatterns: ['*_custom$'],
        defaultResetTimeNs: 5000,
        autoBackup: false,
        backupInterval: 50,
      };
      saveTvConfig(tmpDir, customConfig);

      const loaded = loadTvConfig(tmpDir);
      expect(loaded.dbPath).toBe('custom/tv.db');
      expect(loaded.corners).toEqual(['custom_corner']);
      expect(loaded.subsysPatterns).toEqual(['*_custom$']);
      expect(loaded.defaultResetTimeNs).toBe(5000);
      expect(loaded.autoBackup).toBe(false);
      expect(loaded.backupInterval).toBe(50);
    });
  });

  describe('saveTvConfig', () => {
    it('creates config file with correct content', () => {
      const config: TvConfig = {
        dbPath: 'test/tv.db',
        corners: ['corner1', 'corner2'],
        subsysPatterns: ['*_sys$'],
        defaultResetTimeNs: 2000,
        autoBackup: true,
        backupInterval: 200,
      };
      saveTvConfig(tmpDir, config);

      const configPath = getConfigPath(tmpDir);
      expect(existsSync(configPath)).toBe(true);

      const raw = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.dbPath).toBe('test/tv.db');
      expect(parsed.corners).toEqual(['corner1', 'corner2']);
      expect(parsed.defaultResetTimeNs).toBe(2000);
    });

    it('creates directory if it does not exist', () => {
      const config: TvConfig = { ...DEFAULT_TV_CONFIG };
      saveTvConfig(tmpDir, config);

      const configPath = getConfigPath(tmpDir);
      expect(existsSync(configPath)).toBe(true);
    });

    it('overwrites existing config', () => {
      const config1: TvConfig = { ...DEFAULT_TV_CONFIG, defaultResetTimeNs: 100 };
      saveTvConfig(tmpDir, config1);

      const config2: TvConfig = { ...DEFAULT_TV_CONFIG, defaultResetTimeNs: 5000 };
      saveTvConfig(tmpDir, config2);

      const loaded = loadTvConfig(tmpDir);
      expect(loaded.defaultResetTimeNs).toBe(5000);
    });
  });

  describe('Round-trip: save → load', () => {
    it('preserves all fields through save and load', () => {
      const original: TvConfig = {
        dbPath: '.socverify/tv.db',
        corners: ['npg_f1_ssg', 'npg_f2_ssg', 'npg_f1_ffg'],
        subsysPatterns: ['*_sys$', '^top$', '*_subsys$'],
        defaultResetTimeNs: 1500,
        autoBackup: false,
        backupInterval: 75,
      };
      saveTvConfig(tmpDir, original);
      const loaded = loadTvConfig(tmpDir);

      expect(loaded).toEqual(original);
    });
  });
});

// ─── AI 辅助确认接口骨架测试 ──────────────────────────────

describe('AI Suggest Confirmation (skeleton)', () => {
  it('returns empty result skeleton', async () => {
    // The suggestConfirmation procedure is a skeleton that returns:
    // { confirmer: undefined, result: undefined, reason: undefined, confidence: 0 }
    // This test documents the expected interface for future AI integration.
    const skeletonResult = {
      confirmer: undefined as string | undefined,
      result: undefined as string | undefined,
      reason: undefined as string | undefined,
      confidence: 0,
    };

    expect(skeletonResult.confirmer).toBeUndefined();
    expect(skeletonResult.result).toBeUndefined();
    expect(skeletonResult.reason).toBeUndefined();
    expect(skeletonResult.confidence).toBe(0);
  });
});
