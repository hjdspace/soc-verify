/**
 * KB Settings — 知识库应用级设置（app-global）。
 *
 * 与凭证同一存储族（<userData>/socverify-data/*.json），管理：
 *  - convertEngine：文档转换引擎（anydoc）
 *  - llm：AI 分类模型显式配置（providerId + model；均空 = 自动跟随
 *    AI Agent 面板，保持既有默认逻辑不变）
 *
 * 读取失败回退默认值（不缓存脏值），保存时全量覆写。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { ConvertEngineId, KbLlmSettings, KbSettings } from '@shared/kb-types';

// Re-export for backwards compatibility (main process callers import from kb-settings)
export type { KbLlmSettings, KbSettings } from '@shared/kb-types';

const SETTINGS_FILE = 'kb-settings.json';

/** 合法的引擎 ID 集合（router 校验与默认值共用，新增引擎只改这里） */
export const ENGINE_IDS: ReadonlySet<string> = new Set(['anydoc']);

export const DEFAULT_KB_SETTINGS: KbSettings = {
  convertEngine: 'anydoc',
  llm: {},
};

/** 角色规范化：字符串 trim、空串清空（compile/vision 角色共用） */
function normalizeRole(raw: Partial<KbLlmSettings> | undefined): KbLlmSettings {
  const providerId = typeof raw?.providerId === 'string' ? raw.providerId.trim() : '';
  const model = typeof raw?.model === 'string' ? raw.model.trim() : '';
  return {
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
  };
}

/** 规范化外部输入：未知引擎回退默认、字符串 trim、空串清空 */
function normalize(input: unknown): KbSettings {
  const raw = (input ?? {}) as Partial<KbSettings> & {
    llm?: Partial<KbLlmSettings>;
    vision?: Partial<KbLlmSettings>;
  };
  const convertEngine = typeof raw.convertEngine === 'string' && ENGINE_IDS.has(raw.convertEngine)
    ? (raw.convertEngine as ConvertEngineId)
    : DEFAULT_KB_SETTINGS.convertEngine;
  const llm = normalizeRole(raw.llm);
  const vision = normalizeRole(raw.vision);
  return {
    convertEngine,
    llm,
    // vision 角色显式保存（issue 12）；完全未配置时不产生字段（= 未配置）
    ...(vision.providerId || vision.model ? { vision } : {}),
  };
}

class KbSettingsManagerImpl {
  private cached: KbSettings | null = null;

  private get filePath(): string {
    return join(app.getPath('userData'), 'socverify-data', SETTINGS_FILE);
  }

  async load(): Promise<KbSettings> {
    if (this.cached) return this.cached;
    try {
      const content = await readFile(this.filePath, 'utf-8');
      this.cached = normalize(JSON.parse(content));
    } catch {
      // 文件不存在 / JSON 损坏 — 回退默认（不缓存，下次读取可感知修复）
      return { ...DEFAULT_KB_SETTINGS, llm: {} };
    }
    return this.cached;
  }

  async save(input: KbSettings): Promise<KbSettings> {
    const normalized = normalize(input);
    const dir = join(app.getPath('userData'), 'socverify-data');
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(this.filePath, JSON.stringify(normalized, null, 2), 'utf-8');
    this.cached = normalized;
    return normalized;
  }

  /** 测试辅助：清空内存缓存 */
  resetCache(): void {
    this.cached = null;
  }
}

export const kbSettingsManager = new KbSettingsManagerImpl();
