/**
 * 转换引擎注册表 — 引擎 ID → 实现。
 *
 * 深模块 seam：converter.ts / kb-router 通过本模块获取引擎，
 * 不直接依赖具体引擎实现。当前引擎选择来自 kb-settings（用户可配）。
 *
 * @see ADR 0022 — 双转换引擎（anydoc / markitdown）
 */

import { anydocEngine } from './anydoc-engine';
import { markitdownEngine } from './markitdown-engine';
import { kbSettingsManager } from '../kb-settings';
import type { ConvertEngine, ConvertEngineId, ConvertEngineInfo } from './types';

export type { ConvertEngineId, ConvertEngineInfo } from './types';

const ENGINES: Record<ConvertEngineId, ConvertEngine> = {
  anydoc: anydocEngine,
  markitdown: markitdownEngine,
};

/** 全部引擎元信息（设置页展示用） */
export function listConvertEngines(): ConvertEngineInfo[] {
  return Object.values(ENGINES).map(({ id, label, description, supportedExtensions }) => ({
    id,
    label,
    description,
    supportedExtensions: [...supportedExtensions],
  }));
}

/** 按 ID 取引擎；未知 ID 回退默认引擎（anydoc），保证旧配置不致崩 */
export function getConvertEngine(id: string): ConvertEngine {
  return ENGINES[id as ConvertEngineId] ?? anydocEngine;
}

/** 当前生效引擎（读取用户设置） */
export async function getActiveConvertEngine(): Promise<ConvertEngine> {
  const settings = await kbSettingsManager.load();
  return getConvertEngine(settings.convertEngine);
}
