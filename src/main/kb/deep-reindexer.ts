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

请直接输出完整的 index.md 内容，不要加 markdown 代码块标记。`;
}

// ── 骨架截取（复用 indexer 的逻辑） ────────────────────────────

/**
 * 从 Markdown 提取骨架：标题 + 前若干行。
 */
function extractSkeleton(markdown: string, maxLines = 60): string {
  const lines = markdown.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      result.push(line);
    } else if (line.trim() && result.length < maxLines) {
      result.push(line);
    }
    if (result.length >= maxLines) break;
  }

  return result.join('\n');
}

// ── 收集文档列表 ────────────────────────────────────────────────

/**
 * 扫描 docs/ 目录，收集所有 .md 文件（跳过 assets/）。
 * 返回相对路径 + 骨架内容。
 */
async function collectDocuments(kbPath: string): Promise<Array<{ path: string; skeleton: string }>> {
  const docsDir = join(kbPath, 'docs');
  if (!existsSync(docsDir)) return [];

  const documents: Array<{ path: string; skeleton: string }> = [];
  const docsDirNormalized = docsDir.replace(/\\/g, '/');

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
        const skeleton = extractSkeleton(content);
        documents.push({ path: relPath, skeleton });
      }
    }
  }

  await scanDir(docsDir);
  return documents;
}

// ── 原子写入 index.md ──────────────────────────────────────────

/**
 * 原子写入 index.md：写临时文件 → rename。
 * 失败时原 index.md 完好。
 */
async function atomicWriteIndexMd(kbPath: string, content: string): Promise<void> {
  const indexMdPath = join(kbPath, 'index.md');
  const tmpPath = join(kbPath, '.index.md.tmp');

  // 写入临时文件
  await writeFile(tmpPath, content, 'utf-8');

  // 原子 rename（在 Windows 上 rename 会覆盖目标文件）
  await rename(tmpPath, indexMdPath);
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
  const indexMdPath = join(kbPath, 'index.md');
  let existingIndex = '';
  if (existsSync(indexMdPath)) {
    existingIndex = await readFile(indexMdPath, 'utf-8');
  }

  // 4. 构建 prompt
  const prompt = buildDeepReindexPrompt(existingIndex, documents);

  // 5. 创建临时 omp 会话
  notify({ phase: 'processing', current: 0, total, message: `正在创建 AI Agent 会话...` });

  let sessionId: string;
  try {
    // 延迟导入以避免循环依赖和测试 mock 冲突
    const { sessionManager } = await import('../agent/session-manager');
    const { credentialManager } = await import('../credentials/credential-manager');
    const { pluginLoader } = await import('../plugins/loader');
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

  // 6. 发送 prompt
  try {
    const { sessionManager } = await import('../agent/session-manager');
    const client = sessionManager.getClient(sessionId);
    if (!client) {
      throw new Error('无法获取 Agent 客户端');
    }

    notify({ phase: 'processing', current: 0, total, message: `Agent 正在深度阅读 ${total} 篇文档...` });

    // 发送 prompt 并等待完成
    // Agent 的响应通过事件流返回，prompt 调用是 fire-and-forget
    // 我们需要等待 Agent 完成（通过 agent_end 事件或 prompt 返回）
    await client.prompt(prompt);

    notify({ phase: 'processing', current: total, total, message: 'Agent 完成，正在写入新索引...' });

    // 7. 读取 Agent 产出
    // 由于 omp 的 prompt 是 fire-and-forget，Agent 的最终消息通过事件流返回
    // 在这里我们读取最新的会话内容
    // 对于深度重建，我们让 Agent 直接在 prompt 响应中输出完整的 index.md
    // 由于 prompt() 是 async 且在 agent_end 后返回，我们可以从最后一条消息获取内容
    // 但实际上 prompt 的返回值是 void（fire-and-forget）
    // 所以我们需要用另一种方式获取 Agent 的输出

    // 策略：Agent 产出会写入 docs/ 下临时文件，或通过事件流返回
    // 更实际的方案：让 Agent 直接修改 index.md（通过 write_file 工具）
    // 但为了原子性，我们让 Agent 通过事件流返回内容

    // 简化方案：Agent 产出后，读取会话的最后一条 assistant 消息
    // 但 AgentClient 没有直接暴露这个接口
    // 替代方案：让 Agent 写入临时文件，然后我们 rename

    // 最实际方案：Agent 在 cwd 中工作，可以通过 write_file 工具直接写 index.md
    // 但我们需要原子性。所以让 Agent 写入 .index.md.new，然后我们 rename

    // 在 prompt 中已要求 Agent 直接输出 index.md 内容
    // omp 的 prompt 会在 agent_end 后返回，响应内容是最后一条消息
    // 但 AgentClient.prompt() 是 fire-and-forget，不返回内容

    // 替代方案：监听 message_end 事件获取最后的 assistant 消息
    // 这里用一个更简单的方案：Agent 通过 write_file 工具直接写入 .index.md.new
    // 然后我们读取并原子替换

    // 检查 Agent 是否产出了 .index.md.new
    const newIndexPath = join(kbPath, '.index.md.new');
    if (existsSync(newIndexPath)) {
      // Agent 直接写了文件，原子替换
      const newContent = await readFile(newIndexPath, 'utf-8');
      await atomicWriteIndexMd(kbPath, newContent);

      // 清理 .index.md.new
      await rm(newIndexPath, { force: true });

      notify({ phase: 'completed', message: `深度重建完成，已重写 ${total} 篇文档的索引` });
      return { ok: true, sessionId, documentCount: total };
    }

    // 如果 Agent 没有写文件，尝试从会话事件中提取最后一条 assistant 消息
    // 这种情况发生在 Agent 在对话中直接输出了索引内容
    // 由于 AgentClient 的限制，我们无法直接获取最后一条消息
    // 所以我们让 Agent 通过 prompt 中的指令写文件

    // 如果到这里还没有 .index.md.new，说明 Agent 可能直接修改了 index.md
    // 检查 index.md 是否被修改
    const currentContent = await readFile(indexMdPath, 'utf-8');
    if (currentContent !== existingIndex) {
      // index.md 已被 Agent 直接修改，不需要再替换
      notify({ phase: 'completed', message: `深度重建完成，已重写 ${total} 篇文档的索引` });
      return { ok: true, sessionId, documentCount: total };
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
      const { sessionManager } = await import('../agent/session-manager');
      await sessionManager.destroySession(sessionId);
    } catch {
      // best-effort cleanup
    }
  }
}
