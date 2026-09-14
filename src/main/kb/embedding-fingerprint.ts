/**
 * Embedding Fingerprint — 嵌入空间指纹（spec §8/§11，issue 21）。
 *
 * 指纹包含参与签名所有配置维度：endpoint identity、model、维度、距离度量、
 * 分块/预处理版本。同维度换模型不得共用空间。
 *
 * API key 不参与签名（轮换不应使向量索引失效）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §8
 */

import { createHash } from 'node:crypto';
import type { EmbeddingFingerprint, EmbeddingRuntimeConfig } from '@shared/kb-types';

/** 分块器版本（分块逻辑变化时递增，使旧向量不与新分块混用） */
export const CHUNKER_VERSION = 1;

/** 默认距离度量（本期固定 cosine，同一代内禁止混用向量空间） */
const DEFAULT_DISTANCE_METRIC = 'cosine';

/**
 * 计算嵌入空间指纹。
 *
 * 参与签名的字段：
 *  - endpoint（端点 URL，去掉尾部斜杠统一）
 *  - model（嵌入模型 ID）
 *  - expectedDimensions（输出维度；undefined 也参与签名以区分「未指定」与「指定了某值」）
 *  - distanceMetric（距离度量，本期固定 cosine）
 *  - maxChunkChars / overlapChunkChars（分块参数）
 *  - chunkerVersion（分块器版本号）
 *
 * 不参与签名：
 *  - apiKey（轮换不应使向量索引失效）
 *  - concurrency（并发是运行时参数，不影响向量内容）
 *  - extraHeaders（路由头不影响向量空间）
 */
export function computeEmbeddingFingerprint(
  cfg: EmbeddingRuntimeConfig,
): EmbeddingFingerprint {
  const endpoint = cfg.endpoint.trim().replace(/\/+$/, '');
  const signature = {
    endpoint,
    model: cfg.model.trim(),
    expectedDimensions: cfg.expectedDimensions,
    distanceMetric: DEFAULT_DISTANCE_METRIC,
    maxChunkChars: cfg.maxChunkChars,
    overlapChunkChars: cfg.overlapChunkChars,
    chunkerVersion: CHUNKER_VERSION,
  };

  const json = JSON.stringify(signature);
  const hash = createHash('sha256').update(json, 'utf-8').digest('hex');

  return { hash, signature };
}
