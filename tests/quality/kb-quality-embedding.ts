/**
 * issue 29 — 确定性嵌入端点 fixture（spec §Testing Decisions「CI 默认使用可控假流」）。
 *
 * 为什么需要它：真实嵌入端点在当前环境不可用（无端点配置；agnes `/embeddings`
 * 无 channel，issue 21 已记录）。为了能**分开报告混合检索的 Recall@10**，
 * 这里提供一个本地 OpenAI 兼容 `/embeddings` 服务，其向量是**确定性 token 哈希**，
 * 用于跑通真实链路（embedding-endpoint → embedding-service → vector-store →
 * wiki-search 的 RRF 与图配额）。
 *
 * ⚠️ 这不是模型质量结论：它只度量「融合与排序管线」，模型的语义泛化能力
 * 必须用真实端点复述（见 issue 29 交接的「未覆盖」）。
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { EmbeddingRuntimeConfig } from '@shared/kb-types';

/** 向量维度（fixture 固定，仅用于同空间可比） */
export const FIXTURE_EMBEDDING_DIMS = 128;
export const FIXTURE_EMBEDDING_MODEL = 'fixture-token-hash-v1';

/** 分词：ASCII 词 + CJK 相邻双字（与产品分词解耦的独立实现） */
export function fixtureTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const word of lower.split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
    if (!word) continue;
    out.push(word);
    const cjk = word.match(/[\u4e00-\u9fa5]+/g);
    for (const run of cjk ?? []) {
      for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

function tokenIndex(token: string): number {
  const digest = createHash('sha256').update(token, 'utf-8').digest();
  return digest.readUInt32BE(0) % FIXTURE_EMBEDDING_DIMS;
}

/** 确定性嵌入：token 哈希累加 + 平方根缩放 + L2 归一化 */
export function fixtureEmbedding(text: string): number[] {
  const vec = new Array<number>(FIXTURE_EMBEDDING_DIMS).fill(0);
  const counts = new Map<number, number>();
  for (const token of fixtureTokens(text)) {
    const idx = tokenIndex(token);
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }
  for (const [idx, count] of counts) vec[idx] = Math.sqrt(count);

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export type FixtureEmbeddingServer = {
  endpoint: string;
  close: () => Promise<void>;
  requests: () => number;
  /** 收到的输入条数（诊断：确认真实走了 HTTP 而不是 mock） */
  inputs: () => number;
};

/** 启动本地 OpenAI 兼容嵌入服务（127.0.0.1 + 随机端口） */
export async function startFixtureEmbeddingServer(): Promise<FixtureEmbeddingServer> {
  let requests = 0;
  let inputs = 0;

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end('{}');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests++;
      let payload: { input?: unknown } = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { input?: unknown };
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid json' } }));
        return;
      }
      const input = payload.input;
      const list = Array.isArray(input) ? input.map(String) : [String(input ?? '')];
      inputs += list.length;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        model: FIXTURE_EMBEDDING_MODEL,
        data: list.map((text, index) => ({ object: 'embedding', index, embedding: fixtureEmbedding(text) })),
      }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture embedding server 未能取得端口');
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/embeddings`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
    requests: () => requests,
    inputs: () => inputs,
  };
}

/** 指向 fixture 服务的嵌入运行时配置 */
export function fixtureEmbeddingConfig(endpoint: string): EmbeddingRuntimeConfig {
  return {
    endpoint,
    apiKey: 'fixture-key',
    model: FIXTURE_EMBEDDING_MODEL,
    expectedDimensions: FIXTURE_EMBEDDING_DIMS,
    maxChunkChars: 800,
    overlapChunkChars: 100,
    concurrency: 4,
  };
}

/** 未配置嵌入（真实降级路径：关键词/图保持可用，vectorStatus.degraded=true） */
export const UNCONFIGURED_EMBEDDING: EmbeddingRuntimeConfig = {
  endpoint: '',
  apiKey: '',
  model: '',
  maxChunkChars: 800,
  overlapChunkChars: 100,
  concurrency: 4,
};
