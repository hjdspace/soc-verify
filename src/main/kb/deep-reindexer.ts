/**
 * Deep Reindexer — 深度索引重建。
 *
 * 手动触发 → 创建临时 omp Agent 会话（独立进程、完成后销毁）
 * → Agent 逐文档深读 docs/ Markdown
 * → 重写每文档摘要与关键词
 * → 按分类体系重写完整 index.md
 * → 原子替换（写临时文件后 rename，失败不影响原 index.md）。
 *
 * 进度通过回调推送（router 层连接到 webContents.send）。
 *
 * @see ADR 0021 — anydoc 文档知识库
 * @see Issue #7 — Deep Reindex
 */

import { join } from 'node:path';
import { readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ensureV1Prefix } from '../agent/openai-compatible';
import { kbLayout } from './layout';
import { extractSkeleton } from './indexer';
import { sessionManager } from '../agent/session-manager';
import { credentialManager } from '../credentials/credential-manager';
import { pluginLoader } from '../plugins/loader';

// ── 类型 ────────────────────────────────────────────────────────

/** 深度重建进度事件 */
export type DeepReindexEvent =
  | { phase: 'processing'; current: number; total: number; message: string }
  | { phase: 'completed'; message: string }
  | { phase: 'failed'; message: string; error?: string };

/** 进度通知回调 */
export type DeepReindexNotifier = (event: DeepReindexEvent) => void;

/** 无操作通知器 */
const noopNotifier: DeepReindexNotifier = () => {};

/** deepReindex 输入参数 */
export type DeepReindexParams = {
  /** 知识库根目录绝对路径 */
  kbPath: string;
  /** 项目 ID */
  projectId: string;
  /** 工作目录（omp 会话的 cwd） */
  cwd: string;
  /** 进度通知回调 */
  notify?: DeepReindexNotifier;
};

/** deepReindex 结果 */
export type DeepReindexResult =
  | { ok: true; sessionId: string; documentCount: number }
  | { ok: false; error: { code: string; message: string } };

// ── 会话工厂依赖（延迟导入，避免循环依赖） ─────────────────────

type _SessionManagerLike = {
  createSession: (options: Record<string, unknown>) => Promise<string>;
  destroySession: (sessionId: string) => Promise<void>;
  getSession: (sessionId: string) => { client: { prompt: (message: string) => Promise<void>; onEvent?: (cb: (event: unknown) => void) => void } } | null;
  getClient: (sessionId: string) => { prompt: (message: string) => Promise<void>; onEvent?: (cb: (event: unknown) => void) => void } | null;
};

type _CredentialManagerLike = {
  getDefaultCredential: () => Promise<{ apiKey: string; baseUrl: string; providerId: string; provider?: string } | null>;
  buildEnvForAgent: () => Promise<Record<string, string>>;
  get: (id: string) => Promise<{ apiKey: string; baseUrl: string; providerId: string; provider?: string } | null>;
  mapProviderForAgent: (providerId: string) => string;
};

type _PluginLoaderLike = {
  getRegistry: (cwd: string) => { discover: () => { subsystems: unknown[] } };
};

// ── Prompt 构建 ──────────────────────────────────────────────────

/**
 * 构建深度重建的 Agent prompt。
 *
 * 输入：现有 index.md + 文档清单（路径 + 骨架）。
 * 输出：要求 Agent 产出符合 index.md 既定格式的完整新索引。
 */
export function buildDeepReindexPrompt(
  existingIndex: string,
  docList: Array<{ path: string; skeleton: string }>,
): string {
  const docListStr = docList
    .map((d) => `### ${d.path}\n${d.skeleton.slice(0, 500)}`)
    .join('\n\n---\n\n');

  return `你是一个文档索引重建专家。请深度阅读以下所有文档内容，重写知识库索引。

任务要求：
1. 逐文档深读，为每个文档重写标题、一句话摘要、3-5 个关键词
2. 按分类体系组织条目，保持或合理演化分类
3. 产出完整的 index.md，格式严格如下：

\`\`\`
# 知识库索引

<!-- 此文件由 AI Agent 会话启动时注入为库地图 -->
<!-- 手动编辑可调整分类体系与条目 -->

## <分类名>

### <文档标题>
- **路径**: \`<相对路径>\`
- **摘要**: <一句话摘要>
- **关键词**: \`keyword1\` · \`keyword2\`

### ...
\`\`\`

现有 index.md（参考分类体系，但请基于文档内容重新生成）：
---
${existingIndex || '（空——首次重建）'}
---

文档清单与骨架（共 ${docList.length} 篇）：
---
${docListStr}
---

产出方式（必须严格遵守）：
使用 write_file 工具，把完整的 index.md 内容写入知识库根目录下的 \`.index.md.new\` 文件（宿主会校验该文件后原子替换正式 index.md）。
不要直接修改或覆盖 index.md 本身；也不要把索引内容作为对话消息输出。`;
}

// ── 收集文档列表 ────────────────────────────────────────────────

/**
 * 扫描 docs/ 目录，收集所有 .md 文件（跳过 assets/）。
 * 返回相对路径 + 骨架内容。
 */
async function collectDocuments(kbPath: string): Promise<Array<{ path: string; skeleton: string }>> {
  const layout = kbLayout(kbPath);
  if (!existsSync(layout.docsDir)) return [];

  const documents: Array<{ path: string; skeleton: string }> = [];
  const docsDirNormalized = layout.docsDir.replace(/\\/g, '/');

  async function scanDir(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'assets') continue;
        await scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const relPath = fullPath.replace(/\\/g, '/').replace(docsDirNormalized + '/', '');
        const content = await readFile(fullPath, 'utf-8');
        const skeleton = extractSkeleton(content, 60);
        documents.push({ path: relPath, skeleton });
      }
    }
  }

  await scanDir(layout.docsDir);
  return documents;
}

// ── 原子写入 index.md ──────────────────────────────────────────

/**
 * 原子写入 index.md：写临时文件 → rename。
 * 失败时原 index.md 完好。
 */
async function atomicWriteIndexMd(kbPath: string, content: string): Promise<void> {
  const layout = kbLayout(kbPath);
  const tmpPath = join(kbPath, '.index.md.tmp');

  // 写入临时文件
  await writeFile(tmpPath, content, 'utf-8');

  // 原子 rename（在 Windows 上 rename 会覆盖目标文件）
  await rename(tmpPath, layout.indexMdPath);
}

// ── 核心函数 ─────────────────────────────────────────────────────

/**
 * 深度索引重建。
 *
 * 流程：
 *  1. 扫描 docs/ 收集文档列表 + 骨架
 *  2. 无文档时直接返回成功（空库）
 *  3. 读取现有 index.md
 *  4. 构建 prompt
 *  5. 创建临时 omp 会话
 *  6. 发送 prompt，等待 Agent 产出新索引
 *  7. 原子替换 index.md
 *  8. 销毁临时会话
 *  9. 推送进度事件
 *
 * 失败保护：任何步骤失败时原 index.md 完好，临时会话被销毁。
 *
 * @param params 重建参数
 * @returns 成功返回 sessionId + 文档数；失败返回错误码 + 信息
 */
export async function deepReindex(params: DeepReindexParams): Promise<DeepReindexResult> {
  const { kbPath, projectId, cwd, notify = noopNotifier } = params;

  // 1. 收集文档列表
  const documents = await collectDocuments(kbPath);
  const total = documents.length;

  // 2. 空库直接返回
  if (total === 0) {
    notify({ phase: 'completed', message: '知识库无文档，跳过深度重建' });
    return { ok: true, sessionId: '', documentCount: 0 };
  }

  // 3. 读取现有 index.md
  const layout = kbLayout(kbPath);
  let existingIndex = '';
  if (existsSync(layout.indexMdPath)) {
    existingIndex = await readFile(layout.indexMdPath, 'utf-8');
  }

  // 4. 构建 prompt
  const prompt = buildDeepReindexPrompt(existingIndex, documents);

  // 5. 创建临时 omp 会话
  notify({ phase: 'processing', current: 0, total, message: `正在创建 AI Agent 会话...` });

  let sessionId: string;
  try {
    // 使用静态导入替代动态导入
    const { PluginBackedDiscovery } = await import('../plugin-adapters');

    const credEnv = await credentialManager.buildEnvForAgent();
    const selectedCred = await credentialManager.getDefaultCredential();

    if (!selectedCred || !selectedCred.apiKey || !selectedCred.baseUrl) {
      notify({ phase: 'failed', message: 'LLM 配置异常：未找到有效的 API 凭证' });
      return { ok: false, error: { code: 'noCredentials', message: '未找到有效的 LLM API 凭证，请在设置中配置' } };
    }

    const provider = credentialManager.mapProviderForAgent(selectedCred.providerId);

    const registry = pluginLoader.getRegistry(cwd);
    const discovery = new PluginBackedDiscovery(cwd, registry);

    sessionId = await sessionManager.createSession({
      projectId,
      cwd,
      provider,
      apiKey: selectedCred.apiKey,
      baseUrl: ensureV1Prefix(selectedCred.baseUrl),
      discovery,
      env: credEnv,
      systemPrompt: '你是一个文档索引重建专家。请深度阅读文档内容，产出高质量的知识库索引。',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify({ phase: 'failed', message: `会话创建失败: ${msg}`, error: msg });
    return { ok: false, error: { code: 'sessionFailed', message: `会话创建失败: ${msg}` } };
  }

  // 6. 发送 prompt 并等待 Agent 完成本轮
  try {
    notify({ phase: 'processing', current: 0, total, message: `Agent 正在深度阅读 ${total} 篇文档...` });

    // sendPromptAndWait 阻塞到 agent_end / error / 超时（默认 10 分钟）。
    // 必须等待：Agent 通过 write_file 工具产出 .index.md.new，
    // 不等待会导致第 7 步在 Agent 尚未写完时检查文件 → 误报 noOutput。
    await sessionManager.sendPromptAndWait(sessionId, prompt, undefined);

    notify({ phase: 'processing', current: total, total, message: 'Agent 完成，正在写入新索引...' });

    // 7. 读取 Agent 产出（prompt 要求写入 .index.md.new，宿主校验后原子替换 index.md）
    const newIndexPath = join(kbPath, '.index.md.new');
    if (existsSync(newIndexPath)) {
      const newContent = (await readFile(newIndexPath, 'utf-8')).trim();
      if (newContent.length === 0) {
        notify({ phase: 'failed', message: 'Agent 产出的索引内容为空', error: 'noOutput' });
        return { ok: false, error: { code: 'noOutput', message: 'Agent 产出的索引内容为空' } };
      }

      // 原子替换（写 .index.md.tmp → rename），失败时原 index.md 完好
      await atomicWriteIndexMd(kbPath, newContent);

      // 清理 Agent 产出的临时文件
      await rm(newIndexPath, { force: true });

      notify({ phase: 'completed', message: `深度重建完成，已重写 ${total} 篇文档的索引` });
      return { ok: true, sessionId, documentCount: total };
    }

    // 兜底：Agent 未写 .index.md.new。
    // 若它无视指令直接覆写了 index.md，旧索引已被破坏且不可信任——
    // 用 prompt 前的快照恢复原索引（覆写内容不静默生效），并按未产出处理。
    const currentContent = await readFile(layout.indexMdPath, 'utf-8');
    if (currentContent !== existingIndex) {
      await atomicWriteIndexMd(kbPath, existingIndex);
      const msg = 'Agent 未按指令写入 .index.md.new（直接修改了 index.md），已恢复原索引';
      notify({ phase: 'failed', message: msg, error: 'noOutput' });
      return { ok: false, error: { code: 'noOutput', message: msg } };
    }

    // Agent 没有产出任何文件变更
    notify({ phase: 'failed', message: 'Agent 未产出索引内容', error: 'noOutput' });
    return { ok: false, error: { code: 'noOutput', message: 'Agent 未产出索引内容' } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify({ phase: 'failed', message: `重建失败: ${msg}`, error: msg });

    // 失败保护：确保原 index.md 完好
    // 如果 Agent 部分写入了 .index.md.new，清理它
    const newIndexPath = join(kbPath, '.index.md.new');
    if (existsSync(newIndexPath)) {
      await rm(newIndexPath, { force: true });
    }

    return { ok: false, error: { code: 'reindexFailed', message: `重建失败: ${msg}` } };
  } finally {
    // 8. 销毁临时会话（无论成功还是失败）
    try {
      await sessionManager.destroySession(sessionId);
    } catch {
      // best-effort cleanup
    }
  }
}
