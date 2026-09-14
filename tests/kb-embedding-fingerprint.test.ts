/**
 * embedding-fingerprint 测试（issue 21，spec §8/§11）。
 *
 * 验收映射 A16：
 *  - 指纹包含 endpoint identity、model、维度、距离度量、分块/预处理版本
 *  - 同维度换模型不得共用空间（指纹 hash 不同）
 *  - API key 轮换不影响指纹（不参与签名）
 *  - 分块参数变化产生不同指纹
 */
import { describe, it, expect } from 'vitest';
import { computeEmbeddingFingerprint } from '../src/main/kb/embedding-fingerprint';
import type { EmbeddingRuntimeConfig } from '@shared/kb-types';

function baseConfig(overrides: Partial<EmbeddingRuntimeConfig> = {}): EmbeddingRuntimeConfig {
  return {
    endpoint: 'https://api.example.com/v1/embeddings',
    apiKey: 'secret-key',
    model: 'text-embedding-3-small',
    expectedDimensions: 1536,
    maxChunkChars: 1000,
    overlapChunkChars: 200,
    concurrency: 1,
    ...overrides,
  };
}

describe('computeEmbeddingFingerprint', () => {
  it('相同配置产生相同指纹', () => {
    const cfg = baseConfig();
    const a = computeEmbeddingFingerprint(cfg);
    const b = computeEmbeddingFingerprint(cfg);
    expect(a.hash).toBe(b.hash);
  });

  it('同维度换模型产生不同指纹', () => {
    const cfgA = baseConfig({ model: 'text-embedding-3-small' });
    const cfgB = baseConfig({ model: 'text-embedding-3-large' });
    expect(cfgA.expectedDimensions).toBe(cfgB.expectedDimensions);
    const fpA = computeEmbeddingFingerprint(cfgA);
    const fpB = computeEmbeddingFingerprint(cfgB);
    expect(fpA.hash).not.toBe(fpB.hash);
  });

  it('换端点产生不同指纹（同模型同维度）', () => {
    const cfgA = baseConfig({ endpoint: 'https://api.openai.com/v1/embeddings' });
    const cfgB = baseConfig({ endpoint: 'https://gateway.example.com/v1/embeddings' });
    const fpA = computeEmbeddingFingerprint(cfgA);
    const fpB = computeEmbeddingFingerprint(cfgB);
    expect(fpA.hash).not.toBe(fpB.hash);
  });

  it('API key 不参与指纹（轮换不影响）', () => {
    const cfgA = baseConfig({ apiKey: 'key-aaa' });
    const cfgB = baseConfig({ apiKey: 'key-bbb' });
    const fpA = computeEmbeddingFingerprint(cfgA);
    const fpB = computeEmbeddingFingerprint(cfgB);
    expect(fpA.hash).toBe(fpB.hash);
  });

  it('分块参数变化产生不同指纹', () => {
    const cfgA = baseConfig({ maxChunkChars: 1000 });
    const cfgB = baseConfig({ maxChunkChars: 800 });
    const fpA = computeEmbeddingFingerprint(cfgA);
    const fpB = computeEmbeddingFingerprint(cfgB);
    expect(fpA.hash).not.toBe(fpB.hash);
  });

  it('重叠参数变化产生不同指纹', () => {
    const cfgA = baseConfig({ overlapChunkChars: 200 });
    const cfgB = baseConfig({ overlapChunkChars: 100 });
    const fpA = computeEmbeddingFingerprint(cfgA);
    const fpB = computeEmbeddingFingerprint(cfgB);
    expect(fpA.hash).not.toBe(fpB.hash);
  });

  it('维度变化产生不同指纹', () => {
    const cfgA = baseConfig({ expectedDimensions: 1536 });
    const cfgB = baseConfig({ expectedDimensions: 768 });
    const fpA = computeEmbeddingFingerprint(cfgA);
    const fpB = computeEmbeddingFingerprint(cfgB);
    expect(fpA.hash).not.toBe(fpB.hash);
  });

  it('无 expectedDimensions 也能计算指纹', () => {
    const cfg = baseConfig({ expectedDimensions: undefined });
    const fp = computeEmbeddingFingerprint(cfg);
    expect(fp.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.signature.expectedDimensions).toBeUndefined();
  });

  it('指纹 signature 包含所有参与签名的字段', () => {
    const cfg = baseConfig();
    const fp = computeEmbeddingFingerprint(cfg);
    expect(fp.signature.endpoint).toBe(cfg.endpoint);
    expect(fp.signature.model).toBe(cfg.model);
    expect(fp.signature.expectedDimensions).toBe(cfg.expectedDimensions);
    expect(fp.signature.distanceMetric).toBe('cosine');
    expect(fp.signature.maxChunkChars).toBe(cfg.maxChunkChars);
    expect(fp.signature.overlapChunkChars).toBe(cfg.overlapChunkChars);
    expect(fp.signature.chunkerVersion).toBeTypeOf('number');
  });

  it('指纹 hash 格式为 sha256 hex', () => {
    const fp = computeEmbeddingFingerprint(baseConfig());
    expect(fp.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
