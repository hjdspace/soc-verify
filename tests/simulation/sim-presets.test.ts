import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Integration test for sim-option preset save/load logic.
 *
 * Tests the same file-system operations that the tRPC router's
 * saveSimOptionPreset and getSimOptionPresets procedures use.
 */
async function savePreset(
  projectRoot: string,
  name: string,
  options: Record<string, unknown>,
): Promise<void> {
  const presetPath = join(projectRoot, '.socverify', 'sim-presets.json');
  let presets: Record<string, Record<string, unknown>> = {};
  try {
    const content = await readFile(presetPath, 'utf-8');
    presets = JSON.parse(content);
  } catch {
    // file doesn't exist yet
  }
  presets[name] = options;
  await mkdir(join(projectRoot, '.socverify'), { recursive: true });
  await writeFile(presetPath, JSON.stringify(presets, null, 2), 'utf-8');
}

async function loadPresets(
  projectRoot: string,
): Promise<Record<string, Record<string, unknown>>> {
  const presetPath = join(projectRoot, '.socverify', 'sim-presets.json');
  try {
    const content = await readFile(presetPath, 'utf-8');
    return JSON.parse(content) as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}

describe('Sim Option Presets (file-system integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = `${tmpdir()}/sv-preset-test-${Date.now()}`;
    require('node:fs').mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function rmSync(path: string, opts: { recursive: boolean; force: boolean }) {
    try {
      require('node:fs').rmSync(path, opts);
    } catch {
      // best-effort
    }
  }

  it('saves a preset to .socverify/sim-presets.json', async () => {
    await savePreset(tmpDir, 'default', { seed: 42, waveform: true });

    const presetPath = join(tmpDir, '.socverify', 'sim-presets.json');
    expect(existsSync(presetPath)).toBe(true);

    const content = await readFile(presetPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.default).toEqual({ seed: 42, waveform: true });
  });

  it('loads presets from .socverify/sim-presets.json', async () => {
    await savePreset(tmpDir, 'fast', { timeout: '5000' });
    await savePreset(tmpDir, 'thorough', { timeout: '60000', verbose: true });

    const presets = await loadPresets(tmpDir);
    expect(Object.keys(presets)).toHaveLength(2);
    expect(presets.fast).toEqual({ timeout: '5000' });
    expect(presets.thorough).toEqual({ timeout: '60000', verbose: true });
  });

  it('returns empty object when no presets file exists', async () => {
    const presets = await loadPresets(tmpDir);
    expect(presets).toEqual({});
  });

  it('overwrites a preset with the same name', async () => {
    await savePreset(tmpDir, 'preset_a', { seed: 1 });
    await savePreset(tmpDir, 'preset_a', { seed: 2 });

    const presets = await loadPresets(tmpDir);
    expect(Object.keys(presets)).toHaveLength(1);
    expect(presets.preset_a).toEqual({ seed: 2 });
  });

  it('preserves existing presets when saving a new one', async () => {
    await savePreset(tmpDir, 'preset_a', { seed: 1 });
    await savePreset(tmpDir, 'preset_b', { seed: 2 });
    await savePreset(tmpDir, 'preset_c', { seed: 3 });

    const presets = await loadPresets(tmpDir);
    expect(Object.keys(presets)).toHaveLength(3);
    expect(presets.preset_a.seed).toBe(1);
    expect(presets.preset_b.seed).toBe(2);
    expect(presets.preset_c.seed).toBe(3);
  });

  it('creates .socverify directory if it does not exist', async () => {
    const socverifyDir = join(tmpDir, '.socverify');
    expect(existsSync(socverifyDir)).toBe(false);

    await savePreset(tmpDir, 'test', { foo: 'bar' });

    expect(existsSync(socverifyDir)).toBe(true);
    expect(existsSync(join(socverifyDir, 'sim-presets.json'))).toBe(true);
  });
});
