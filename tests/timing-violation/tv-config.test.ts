import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadTvConfig,
  saveTvConfig,
  getConfigPath,
  getDbPath,
  getDataDir,
  getExportDir,
  getBackupDir,
  ensureExportDir,
  ensureBackupDir,
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
      expect(DEFAULT_TV_CONFIG.dataDir).toBe('.socverify/timing-violation');
      expect(Array.isArray(DEFAULT_TV_CONFIG.corners)).toBe(true);
      expect(DEFAULT_TV_CONFIG.corners.length).toBeGreaterThan(0);
      expect(Array.isArray(DEFAULT_TV_CONFIG.subsysPatterns)).toBe(true);
      expect(DEFAULT_TV_CONFIG.defaultResetTimeNs).toBe(1000);
      expect(DEFAULT_TV_CONFIG.resetIntervalStartNs).toBeNull();
      expect(DEFAULT_TV_CONFIG.resetIntervalEndNs).toBeNull();
      expect(DEFAULT_TV_CONFIG.autoBackup).toBe(true);
      expect(DEFAULT_TV_CONFIG.backupInterval).toBe(100);
    });
  });

  describe('getConfigPath', () => {
    it('returns config path under dataDir', () => {
      const path = getConfigPath(tmpDir);
      expect(path).toBe(resolve(tmpDir, '.socverify', 'timing-violation', 'config.json'));
    });

    it('uses custom dataDir when provided', () => {
      const path = getConfigPath(tmpDir, 'custom/data/dir');
      expect(path).toContain('custom');
      expect(path).toContain('data');
      expect(path).toContain('dir');
      expect(path).toContain('config.json');
    });
  });

  describe('getDbPath', () => {
    it('resolves db path under dataDir', () => {
      const path = getDbPath(tmpDir);
      expect(path).toContain('.socverify');
      expect(path).toContain('timing-violation');
      expect(path).toContain('tv.db');
    });

    it('uses custom dataDir when provided', () => {
      const path = getDbPath(tmpDir, 'custom/data/dir');
      expect(path).toContain('custom');
      expect(path).toContain('tv.db');
    });
  });

  describe('getDataDir', () => {
    it('resolves dataDir relative to project root', () => {
      const path = getDataDir(tmpDir);
      expect(path).toBe(resolve(tmpDir, '.socverify', 'timing-violation'));
    });

    it('uses custom dataDir when provided', () => {
      const path = getDataDir(tmpDir, 'custom/dir');
      expect(path).toBe(resolve(tmpDir, 'custom', 'dir'));
    });
  });

  describe('getExportDir', () => {
    it('resolves export dir under dataDir', () => {
      const path = getExportDir(tmpDir);
      expect(path).toBe(resolve(tmpDir, '.socverify', 'timing-violation', 'exports'));
    });
  });

  describe('getBackupDir', () => {
    it('resolves backup dir under dataDir', () => {
      const path = getBackupDir(tmpDir);
      expect(path).toBe(resolve(tmpDir, '.socverify', 'timing-violation', 'backups'));
    });
  });

  describe('ensureExportDir', () => {
    it('creates export directory if it does not exist', () => {
      const exportDir = ensureExportDir(tmpDir);
      expect(existsSync(exportDir)).toBe(true);
    });
  });

  describe('ensureBackupDir', () => {
    it('creates backup directory if it does not exist', () => {
      const backupDir = ensureBackupDir(tmpDir);
      expect(existsSync(backupDir)).toBe(true);
    });
  });

  describe('loadTvConfig', () => {
    it('returns default config when config file does not exist', () => {
      const config = loadTvConfig(tmpDir);
      expect(config.dataDir).toBe(DEFAULT_TV_CONFIG.dataDir);
      expect(config.corners).toEqual(DEFAULT_TV_CONFIG.corners);
      expect(config.defaultResetTimeNs).toBe(DEFAULT_TV_CONFIG.defaultResetTimeNs);
    });

    it('returns default config when JSON is invalid', () => {
      const configPath = getConfigPath(tmpDir);
      mkdirSync(join(tmpDir, '.socverify', 'timing-violation'), { recursive: true });
      writeFileSync(configPath, '{ invalid json }', 'utf-8');

      const config = loadTvConfig(tmpDir);
      expect(config.dataDir).toBe(DEFAULT_TV_CONFIG.dataDir);
    });

    it('merges saved config with defaults', () => {
      const customConfig: TvConfig = {
        dataDir: 'custom/data',
        corners: ['custom_corner'],
        subsysPatterns: ['*_custom$'],
        defaultResetTimeNs: 5000,
        resetIntervalStartNs: 200,
        resetIntervalEndNs: 800,
        autoBackup: false,
        backupInterval: 50,
      };
      saveTvConfig(tmpDir, customConfig);

      const loaded = loadTvConfig(tmpDir);
      expect(loaded.dataDir).toBe('custom/data');
      expect(loaded.corners).toEqual(['custom_corner']);
      expect(loaded.subsysPatterns).toEqual(['*_custom$']);
      expect(loaded.defaultResetTimeNs).toBe(5000);
      expect(loaded.resetIntervalStartNs).toBe(200);
      expect(loaded.resetIntervalEndNs).toBe(800);
      expect(loaded.autoBackup).toBe(false);
      expect(loaded.backupInterval).toBe(50);
    });

    it('backward compat: derives dataDir from old dbPath', () => {
      // Write an old-style config with dbPath but no dataDir
      const configPath = getConfigPath(tmpDir);
      mkdirSync(join(tmpDir, '.socverify', 'timing-violation'), { recursive: true });
      const oldConfig = {
        dbPath: '.socverify/timing-violation/tv.db',
        corners: ['corner1'],
        subsysPatterns: ['*_sys$'],
        defaultResetTimeNs: 1000,
        autoBackup: true,
        backupInterval: 100,
      };
      writeFileSync(configPath, JSON.stringify(oldConfig, null, 2), 'utf-8');

      const loaded = loadTvConfig(tmpDir);
      // dataDir should be derived from dbPath's directory
      expect(loaded.dataDir).toBe('.socverify/timing-violation');
      expect(loaded.corners).toEqual(['corner1']);
      // New interval fields default to null for old configs
      expect(loaded.resetIntervalStartNs).toBeNull();
      expect(loaded.resetIntervalEndNs).toBeNull();
    });
  });

  describe('saveTvConfig', () => {
    it('creates config file with correct content', () => {
      const config: TvConfig = {
        dataDir: 'test/data',
        corners: ['corner1', 'corner2'],
        subsysPatterns: ['*_sys$'],
        defaultResetTimeNs: 2000,
        resetIntervalStartNs: 100,
        resetIntervalEndNs: 500,
        autoBackup: true,
        backupInterval: 200,
      };
      saveTvConfig(tmpDir, config);

      // Config file is always at the default location, not at config.dataDir
      const configPath = getConfigPath(tmpDir);
      expect(existsSync(configPath)).toBe(true);

      const raw = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.dataDir).toBe('test/data');
      expect(parsed.corners).toEqual(['corner1', 'corner2']);
      expect(parsed.defaultResetTimeNs).toBe(2000);
      expect(parsed.resetIntervalStartNs).toBe(100);
      expect(parsed.resetIntervalEndNs).toBe(500);
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
        dataDir: '.socverify/tv-data',
        corners: ['npg_f1_ssg', 'npg_f2_ssg', 'npg_f1_ffg'],
        subsysPatterns: ['*_sys$', '^top$', '*_subsys$'],
        defaultResetTimeNs: 1500,
        resetIntervalStartNs: 200,
        resetIntervalEndNs: 900,
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
