/**
 * kb-settings 服务测试 — 应用级设置（引擎 + LLM 显式配置）的
 * 默认值、持久化 round-trip、坏文件回退与规范化。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const { dataDir } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(os.tmpdir(), `sv-kb-settings-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return { dataDir: dir };
});

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => dataDir) },
}));

import { kbSettingsManager } from '../src/main/kb/kb-settings';

const settingsPath = join(dataDir, 'socverify-data', 'kb-settings.json');

describe('kb-settings', () => {
  beforeEach(() => {
    kbSettingsManager.resetCache();
    rmSync(settingsPath, { force: true });
  });

  it('无配置文件时返回默认值（anydoc + 空 llm）', async () => {
    const settings = await kbSettingsManager.load();
    expect(settings).toEqual({ convertEngine: 'anydoc', llm: {} });
  });

  it('save → load round-trip 持久化', async () => {
    await kbSettingsManager.save({ convertEngine: 'markitdown', llm: { providerId: 'openai', model: 'glm-4.7' } });

    // 清缓存模拟重启
    kbSettingsManager.resetCache();
    const settings = await kbSettingsManager.load();
    expect(settings.convertEngine).toBe('markitdown');
    expect(settings.llm.providerId).toBe('openai');
    expect(settings.llm.model).toBe('glm-4.7');

    // 文件确实落盘
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(raw.convertEngine).toBe('markitdown');
  });

  it('save 规范化：未知引擎回退 anydoc、字符串 trim、空串清除字段', async () => {
    const saved = await kbSettingsManager.save({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 故意传非法值验证规范化
      convertEngine: 'unknown-engine' as any,
      llm: { providerId: '  openai  ', model: '' },
    });
    expect(saved.convertEngine).toBe('anydoc');
    expect(saved.llm.providerId).toBe('openai');
    expect(saved.llm.model).toBeUndefined();
  });

  it('损坏 JSON 回退默认值且不缓存坏值（修复后可重新读取）', async () => {
    writeFileSync(settingsPath, '{not valid json', 'utf-8');
    expect(await kbSettingsManager.load()).toEqual({ convertEngine: 'anydoc', llm: {} });

    // save 后能正常读回
    await kbSettingsManager.save({ convertEngine: 'markitdown', llm: {} });
    kbSettingsManager.resetCache();
    expect((await kbSettingsManager.load()).convertEngine).toBe('markitdown');
  });

  it('load 后缓存生效（文件被外部删除仍返回缓存值）', async () => {
    await kbSettingsManager.save({ convertEngine: 'markitdown', llm: { model: 'm1' } });
    rmSync(settingsPath, { force: true });
    const settings = await kbSettingsManager.load();
    expect(settings.convertEngine).toBe('markitdown');
    expect(existsSync(settingsPath)).toBe(false);
  });
});
