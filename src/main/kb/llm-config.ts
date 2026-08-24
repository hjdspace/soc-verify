/**
 * KB LLM 配置推导链 — ADR 0022 产品决策的单一拥有者。
 *
 * 模型优先级（五级回退）：
 *   KB 设置显式配置 > 凭证 model 字段 > Agent 会话持久化模型
 *   > API 拉取的第一个可用模型 > provider 默认
 *
 * 凭证优先级（未在 KB 设置显式指定时）：
 *   Agent 会话 providerId > 默认凭证
 *
 * 无配置时返回 null（上传时降级为占位条目）。
 *
 * @see ADR 0022 — 双转换引擎 + KB AI 模型配置
 */

import { credentialManager } from '../credentials/credential-manager';
import { kbSettingsManager } from './kb-settings';
import { ensureV1Prefix, fetchOpenAICompatibleModels } from '../agent/openai-compatible';
import type { ConfiguredModel } from '@shared/types';
import { loadSessions } from '../agent/session-persistence';
import { projectManager } from '../project/project-manager';

// ── 类型 ──────────────────────────────────────────────────────

/** LLM 调用配置 */
export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 凭证 providerId — 决定调用协议（anthropic / gemini 走原生协议，其余走 openai-compatible） */
  providerId?: string;
  fetchFn?: typeof fetch;
};

/** credentialManager 返回的凭证结构（模块内使用） */
type ActiveCredential = {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  models?: ConfiguredModel[];
};

/** resolveActiveCredential 结果：生效凭证 + Agent 面板实际使用的模型 ID */
type ResolvedLlm = {
  credential: ActiveCredential;
  /** 最近 AI 会话持久化的 model.id（Agent 面板当前对话所用、已验证可用的模型） */
  sessionModelId?: string;
};

/** LLM 协议（按凭证 providerId 推导） */
type LlmProtocol = 'openai' | 'anthropic' | 'gemini';

export function protocolForProvider(providerId: string | undefined): LlmProtocol {
  const lower = (providerId ?? '').toLowerCase();
  if (lower === 'anthropic' || lower === 'claude') return 'anthropic';
  if (lower === 'google' || lower === 'gemini') return 'gemini';
  return 'openai';
}

// ── 内部辅助 ──────────────────────────────────────────────────

/**
 * 获取当前活跃项目的 rootPath。
 * 单用户桌面应用：取最近打开的项目。无项目时返回 null。
 */
function getActiveProjectRoot(): string | null {
  const projects = projectManager.listProjects();
  if (projects.length === 0) return null;
  // 取最近打开的项目
  const latest = projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
  return latest.rootPath;
}

/**
 * 根据 providerId 推导默认模型名。
 * 用户未显式配置 model 时使用此映射。
 */
function defaultModelForProvider(providerId: string): string {
  const lower = providerId.toLowerCase();
  if (lower === 'openai' || lower === 'openai-compatible') return 'gpt-4o-mini';
  if (lower === 'anthropic' || lower === 'claude') return 'claude-sonnet-4-20250514';
  if (lower === 'google' || lower === 'gemini') return 'gemini-2.5-flash';
  if (lower === 'deepseek') return 'deepseek-chat';
  if (lower === 'ollama') return 'llama3.2';
  return 'gpt-4o-mini';
}

/**
 * 解析当前生效的 LLM 凭证 — 与右侧 AI Agent 面板保持一致：
 * 优先用项目最近 AI 会话持久化的 providerId（用户在 Agent 面板
 * 实际选择且验证可用的凭证），回退到默认凭证（列表第一条）。
 *
 * 同时带回该会话的 model.id，供 KB 分类复用 Agent 面板的模型选择。
 */
async function resolveActiveCredential(): Promise<ResolvedLlm | null> {
  const rootPath = getActiveProjectRoot();
  if (rootPath) {
    try {
      const sessions = await loadSessions(rootPath);
      const latest = sessions
        .filter((s) => s.model?.providerId)
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
      const modelRef = latest?.model;
      if (modelRef?.providerId) {
        const cred = await credentialManager.get(modelRef.providerId);
        if (cred) {
          // setModel 持久化时 id 可能为空串，视为未指定
          return { credential: cred, sessionModelId: modelRef.id || undefined };
        }
      }
    } catch {
      // 项目未打开等 — 回退默认凭证
    }
  }
  const fallback = await credentialManager.getDefaultCredential();
  return fallback ? { credential: fallback } : null;
}

/**
 * 从 openai-compatible 端点拉取第一个可用模型 — 与设置页 fetchModels /
 * omp 自动选模行为一致。硬编码默认模型（如 gpt-4o-mini）在中转网关上
 * 常不存在，会导致 404 "model is not found"。
 * anthropic / gemini 原生端点或拉取失败时回退 provider 默认模型。
 */
async function firstAvailableModel(
  cred: ActiveCredential,
  baseUrl: string,
): Promise<string> {
  if (protocolForProvider(cred.providerId) !== 'openai') {
    return defaultModelForProvider(cred.providerId);
  }
  try {
    const models = await fetchOpenAICompatibleModels({
      baseUrl,
      apiKey: cred.apiKey,
    });
    if (models.length > 0) return models[0].id;
  } catch {
    // 网络失败等 — 回退硬编码默认
  }
  return defaultModelForProvider(cred.providerId);
}

/**
 * 解析凭证的对话端点。
 * gemini 原生端点用 /v1beta 版本前缀，不能强加 /v1。
 * 调用方需先确认 cred.baseUrl 非空。
 */
function baseUrlForCredential(cred: ActiveCredential): string {
  const baseUrl = cred.baseUrl ?? '';
  return protocolForProvider(cred.providerId) === 'gemini'
    ? baseUrl.replace(/\/+$/, '')
    : ensureV1Prefix(baseUrl);
}

// ── 公开接口 ──────────────────────────────────────────────────

/**
 * 解析 KB 分类用的 LLM 配置（五级回退链）。
 *
 * 模型优先级：KB 设置显式配置（设置页知识库 Tab）> 凭证 model 字段
 * （凭证表单显式配置）> Agent 会话持久化模型 > API 拉取的第一个可用
 * 模型（openai-compatible）> provider 默认。
 *
 * 凭证优先级（未在 KB 设置显式指定时）：Agent 会话 providerId > 默认凭证。
 * 无配置时返回 null（上传时降级为占位条目）。
 * 注意 model 解析用 `||` 而非 `??` — 空字符串视为未指定，需继续回退。
 */
export async function resolveKbLlmConfig(): Promise<LlmConfig | null> {
  // 1. KB 设置显式配置 — 用户在设置页知识库 Tab 指定的凭证与模型
  const kbSettings = await kbSettingsManager.load();
  if (kbSettings.llm.providerId) {
    const cred = await credentialManager.get(kbSettings.llm.providerId);
    if (cred?.baseUrl && cred.apiKey) {
      const baseUrl = baseUrlForCredential(cred);
      const model = kbSettings.llm.model?.trim()
        || cred.models?.[0]?.id.trim()
        || await firstAvailableModel(cred, baseUrl);
      return { baseUrl, apiKey: cred.apiKey, model, providerId: cred.providerId };
    }
    // 凭证已被删除 — 落回自动推导链
  }

  // 2. 自动推导（既有默认逻辑，行为不变）
  const resolved = await resolveActiveCredential();
  if (!resolved) return null;
  const { credential: cred, sessionModelId } = resolved;
  if (!cred.baseUrl || !cred.apiKey) {
    return null;
  }
  const baseUrl = baseUrlForCredential(cred);
  const model = cred.model?.trim()
    || sessionModelId
    || await firstAvailableModel(cred, baseUrl);
  return {
    baseUrl,
    apiKey: cred.apiKey,
    model,
    providerId: cred.providerId,
  };
}
