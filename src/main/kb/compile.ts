/**
 * KB 短来源编译管线（issue 08，spec §4）— 文字来源 → 两阶段模型调用
 * → 既有 staging。
 *
 * 职责边界（Smart zone M）：
 *  - 固定快照：任务绑定 kbId + 来源修订（sourceRef 由 manifest 固定，
 *    不接受模型输入）+ schema/purpose 快照（由 stageProposal 记 hash）；
 *  - 先简洁分析再生成（compile-prompts，无隐藏思维链）；
 *  - 读集：当前知识库目录（wiki/index.md）+ 必要既有页（本票以 index
 *    为上下文，跨来源正文合并待 issue 16）；
 *  - 输出只经既有 stageProposal（路径沙箱/frontmatter/归属固定），
 *    本模块不写 wiki/；
 *  - 基本坏输出必须拒绝：缺来源摘要页、伪造其他来源页、证据不符、
 *    未闭合块 —— 有界修复调用待 issue 09；
 *  - 模型失败/预算不足/无凭证/取消状态明确。
 *
 * 模型调用边界：本模块不解析配置 —— 调用方（队列/测试）显式传入
 * CompileLlm（无凭证传 null），凭证不进入任务文件或渲染端。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFileProposal } from './proposal-blocks';
import { parseWikiPage } from './wiki-page';
import { parseWikiSchema } from './wiki-schema';
import { WIKI_PAGE_TYPES } from './wiki-schema';
import { wikiLayout, readWikiManifest } from './wiki-layout';
import { readWikiParsed } from './source-import';
import { stageProposal } from './staging';
import { writeFileAtomic } from './atomic-commit';
import { callLlm, LlmCallError, type LlmUsage } from './llm-call';
import { resolveKbLlmConfig } from './llm-config';
import { buildAnalysisPrompt, buildGenerationPrompt } from './compile-prompts';
import type {
  WikiChangeSet,
  WikiPageType,
  WikiSourceRef,
  WikiStagingErrorCode,
} from '@shared/kb-types';

// ── 模型调用边界 ────────────────────────────────────────────────

/** 宽松调用结果（真实调用返回 LlmCallResult 超集兼容；测试可传字符串简写） */
export type LlmCallResultLike =
  | string
  | {
      text: string;
      finishReason?: string | null;
      usage?: LlmUsage | null;
    };

/** 编译用模型入口。调用方显式构造（真实凭证 / 可控假响应）；null = 无凭证。 */
export type CompileLlm = {
  /** 配置快照描述（仅供诊断，不写入任务文件） */
  readonly model: string;
  invoke: (req: { system: string; user: string; maxTokens: number }) => Promise<LlmCallResultLike>;
};

/**
 * 默认模型入口工厂（队列单例使用）。
 *
 * 每次 attempt 开始时调用一次 —— 在该次运行内固定配置快照
 * （baseUrl/model/凭证引用），解析结果由调用方显式传入编译管线；
 * 无可用凭证返回 null（任务以明确的 noCredential 失败）。
 * 凭证只存在于主进程内存中的 LlmConfig，不进入任务文件或渲染端。
 */
export function createDefaultCompileLlmFactory(): (signal: AbortSignal) => Promise<CompileLlm | null> {
  return async (signal) => {
    const config = await resolveKbLlmConfig();
    if (!config) return null;
    return {
      model: config.model,
      invoke: (req) => callLlm(config, {
        system: req.system,
        user: req.user,
        maxTokens: req.maxTokens,
        signal,
      }),
    };
  };
}

// ── 结果契约 ────────────────────────────────────────────────────

export type CompileErrorCode =
  | 'noCredential'
  | 'sourceNotFound'
  | 'manifestCorrupted'
  | 'sourceNotReady'
  | 'contextBudgetExceeded'
  | 'aborted'
  | 'llmFailed'
  | 'schemaUnavailable'
  | 'invalidTarget'
  | 'ioError';

export type CompileSuccess = {
  ok: true;
  changeSet: WikiChangeSet;
  /** 各阶段可获得的 usage（未返回 usage 的阶段不占位，不伪造 0） */
  usage: LlmUsage[];
};

export type CompileFailure = { ok: false; code: CompileErrorCode; message: string };

export type CompileResult = CompileSuccess | CompileFailure;

export type CompileInput = {
  kbId: string;
  /** 队列 taskId（staging 任务身份） */
  taskId: string;
  sourceId: string;
};

export type CompileDeps = {
  /** 模型入口；null = 未配置凭证 */
  llm: CompileLlm | null;
  /** 外部取消信号（队列取消/暂停共用） */
  signal?: AbortSignal;
  /** 注入时钟（测试用） */
  now?: string;
};

/** 短来源全文上限（字符）。超限进入明确的 contextBudgetExceeded（分段编译待 issue 10）。 */
export const SHORT_SOURCE_MAX_CHARS = 40_000;

const ANALYSIS_MAX_TOKENS = 4_096;
const GENERATION_MAX_TOKENS = 8_192;

const ANALYSIS_SYSTEM = '你是严谨的研究分析员。只输出最终结构化分析，不输出思考过程。';
const GENERATION_SYSTEM = '你是 wiki 维护者。只输出 FILE 块，不输出思考过程或其他文字。';

class CompileAborted extends Error {}

function fail(code: CompileErrorCode, message: string): CompileFailure {
  return { ok: false, code, message };
}

async function readFileOrNull(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

async function resultText(r: LlmCallResultLike): Promise<string> {
  return typeof r === 'string' ? r : r.text;
}

function resultUsage(r: LlmCallResultLike): LlmUsage | null {
  return typeof r === 'string' ? null : r.usage ?? null;
}

/** 单阶段模型调用：取消优先于错误（signal.aborted 时一律报 aborted）。
 *  网络错误/429/5xx 等可重试失败做有界退避重试（对齐 spec §5，最多 3 次尝试）。 */
const LLM_MAX_ATTEMPTS = 3;
const LLM_RETRY_DELAY_MS = 1_000;

async function invokePhase(
  llm: CompileLlm,
  req: { system: string; user: string; maxTokens: number },
  signal: AbortSignal | undefined,
): Promise<{ ok: true; text: string; usage: LlmUsage | null } | CompileFailure> {
  let lastMessage = '';
  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
    try {
      const r = await llm.invoke(req);
      if (signal?.aborted) return fail('aborted', '编译已被取消');
      return { ok: true, text: await resultText(r), usage: resultUsage(r) };
    } catch (err) {
      if (signal?.aborted) return fail('aborted', '编译已被取消');
      const retryable = err instanceof LlmCallError && err.retryable;
      lastMessage = err instanceof Error ? err.message : String(err);
      if (!retryable || attempt === LLM_MAX_ATTEMPTS) break;
      await new Promise<void>((resolve) => setTimeout(resolve, LLM_RETRY_DELAY_MS));
    }
  }
  return fail('llmFailed', `模型调用失败: ${lastMessage}`);
}

// ── 坏输出预检（staging 是权威校验；此处拦截明显坏输出避免脏 staging） ──

type ProposalPrecheck =
  | { ok: true; extraWarnings: string[] }
  | { ok: false; message: string };

function precheckProposal(
  proposalText: string,
  sourceId: string,
  sourceRef: WikiSourceRef,
): ProposalPrecheck {
  const parsed = parseFileProposal(proposalText);
  if (!parsed.ok) {
    return { ok: false, message: `模型提案解析失败: ${parsed.error.message}` };
  }
  if (parsed.truncated.length > 0) {
    return {
      ok: false,
      message: `提案存在未闭合块（流截断）: ${parsed.truncated.join('、')} — 拒绝接受（不发布不完整文件）`,
    };
  }

  // 来源摘要页路径由应用固定
  const summaryRelPath = `wiki/sources/${sourceId}.md`;
  const normalized = (p: string): string => p.trim().replace(/\\/g, '/');
  const hasSummary = parsed.files.some((f) => normalized(f.path) === summaryRelPath);
  if (!hasSummary) {
    return {
      ok: false,
      message: `模型提案缺少必需的来源摘要页 ${summaryRelPath}（路径由应用固定）`,
    };
  }

  // 证据绑定：每个提案页的 frontmatter sources 必须包含应用给定的 sourceRef
  for (const file of parsed.files) {
    const page = parseWikiPage(file.content);
    if (!page.ok) {
      return {
        ok: false,
        message: `提案页 frontmatter 非法: ${file.path} — ${page.issues.map((i) => i.message).join('；')}`,
      };
    }
    const bound = page.frontmatter.sources.some(
      (s) =>
        s.sourceId === sourceRef.sourceId
        && s.sourceRevision === sourceRef.sourceRevision
        && s.parsedHash === sourceRef.parsedHash,
    );
    if (!bound) {
      return {
        ok: false,
        message: `提案页证据与来源不符: ${file.path}（frontmatter sources 必须包含应用给定的 sourceRef）`,
      };
    }
  }

  return { ok: true, extraWarnings: parsed.warnings };
}

/** staging 错误码 → 编译错误码 */
function mapStagingError(code: WikiStagingErrorCode): CompileErrorCode {
  if (code === 'schemaUnavailable') return 'schemaUnavailable';
  if (code === 'ioError') return 'ioError';
  return 'invalidTarget';
}

// ── 公开接口 ────────────────────────────────────────────────────

/**
 * 编译一个已就绪来源：分析 → 生成 → staging。
 *
 * 前置：来源 status=ready 且 parsedRevision === currentRevision
 * （队列路径先跑 convertWikiSource 保证就绪）。
 * 成功返回持久化 changeSet（审阅入口见 kb.stagedChangeSet）。
 */
export async function compileWikiSource(
  kbPath: string,
  input: CompileInput,
  deps: CompileDeps,
): Promise<CompileResult> {
  const { signal } = deps;
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new CompileAborted();
  };

  try {
    if (!deps.llm) {
      return fail('noCredential', '未配置 LLM 凭证（设置 → 凭证管理），无法编译');
    }
    throwIfAborted();

    const layout = wikiLayout(kbPath);
    const read = await readWikiManifest(kbPath);
    if (!read.ok) {
      return fail('manifestCorrupted', `库 manifest 不可读（${read.reason}）`);
    }
    const rec = read.manifest.sources?.[input.sourceId];
    if (!rec) {
      return fail('sourceNotFound', `来源不存在: ${input.sourceId}`);
    }
    if (rec.status !== 'ready' || rec.parsedRevision !== rec.currentRevision || !rec.parsedHash) {
      return fail('sourceNotReady', `来源尚未就绪（status=${rec.status}），无法编译: ${rec.sourcePath}`);
    }

    // 固定来源快照：修订 + parsed 指纹由应用从 manifest 读取
    const parsedView = await readWikiParsed(kbPath, { sourceId: input.sourceId });
    if (parsedView.parsedHash !== rec.parsedHash || parsedView.revision !== rec.currentRevision) {
      return fail('sourceNotReady', `parsed 全文与 manifest 记录不一致: ${rec.sourcePath}`);
    }
    const sourceRef: WikiSourceRef = {
      sourceId: input.sourceId,
      sourceRevision: rec.currentRevision,
      parsedHash: rec.parsedHash,
    };

    // 预算：短来源全文直接进提示词；超限明确报错（长文档分段待 issue 10）
    if (parsedView.content.length > SHORT_SOURCE_MAX_CHARS) {
      return fail(
        'contextBudgetExceeded',
        `来源全文 ${parsedView.content.length} 字符超过短来源编译上限 ${SHORT_SOURCE_MAX_CHARS}，分段编译待后续版本`,
      );
    }

    // 读集：purpose / schema / 当前知识库目录
    const purpose = await readFileOrNull(layout.purposeMdPath);
    const schema = await readFileOrNull(layout.schemaMdPath);
    const index = await readFileOrNull(join(kbPath, 'wiki', 'index.md'));
    const now = deps.now ?? new Date().toISOString();

    // ── 阶段 1：简洁结构化分析 ──
    throwIfAborted();
    const analysis = await invokePhase(deps.llm, {
      system: ANALYSIS_SYSTEM,
      user: buildAnalysisPrompt({ purpose, schema, index, sourceContent: parsedView.content }),
      maxTokens: ANALYSIS_MAX_TOKENS,
    }, signal);
    if (!analysis.ok) return analysis;

    // schema 允许的页面类型（schema 可解析则用其路由类型，否则固定八类）
    let pageTypes: readonly WikiPageType[] = WIKI_PAGE_TYPES;
    if (schema) {
      const s = parseWikiSchema(schema);
      if (s.ok) {
        const keys = Object.keys(s.routing.typeDirs) as WikiPageType[];
        if (keys.length > 0) pageTypes = keys;
      }
    }

    // ── 阶段 2：FILE 提案生成 ──
    throwIfAborted();
    const generation = await invokePhase(deps.llm, {
      system: GENERATION_SYSTEM,
      user: buildGenerationPrompt({
        purpose,
        schema,
        index,
        analysis: analysis.text,
        sourceName: rec.sourcePath,
        sourceSummaryRelPath: `wiki/sources/${input.sourceId}.md`,
        sourceRefYaml: [
          'sources:',
          `  - sourceId: "${sourceRef.sourceId}"`,
          `    sourceRevision: "${sourceRef.sourceRevision}"`,
          `    parsedHash: "${sourceRef.parsedHash}"`,
        ].join('\n'),
        today: now,
        pageTypes,
      }),
      maxTokens: GENERATION_MAX_TOKENS,
    }, signal);
    if (!generation.ok) return generation;

    // ── 坏输出预检（缺摘要页/伪造来源/证据不符/未闭合 → 拒绝） ──
    const pre = precheckProposal(generation.text, input.sourceId, sourceRef);
    if (!pre.ok) return fail('llmFailed', pre.message);

    // ── 阶段 3：校验并落既有 staging（路径沙箱/frontmatter/归属固定） ──
    throwIfAborted();
    const staged = await stageProposal(kbPath, {
      kbId: input.kbId,
      taskId: input.taskId,
      origin: 'compile',
      sourceRefs: [sourceRef],
      proposalText: generation.text,
      fixedSourcePageId: `sources/${input.sourceId}`,
      extraWarnings: pre.extraWarnings,
    });
    if (!staged.ok) {
      return fail(mapStagingError(staged.error.code), staged.error.message);
    }

    const changeSet = staged.value.changeSet;
    // 既有同页更新提示：跨来源正文合并能力待 issue 16
    if (changeSet.pages.some((p) => p.before !== null)) {
      changeSet.warnings.push(
        '提案包含既有同页更新：跨来源正文合并能力待后续版本，请逐 hunk 审阅确认。',
      );
      // staging 文件已写入 —— 补写一次把提示持久化（原子替换）
      await writeFileAtomic(
        join(layout.stagingDir, `${changeSet.changeSetId}.json`),
        JSON.stringify(changeSet, null, 2),
      );
    }

    const usage = [analysis.usage, generation.usage].filter((u): u is LlmUsage => u !== null);
    return { ok: true, changeSet, usage };
  } catch (err) {
    if (err instanceof CompileAborted) {
      return fail('aborted', '编译已被取消');
    }
    return fail('ioError', `编译过程异常: ${err instanceof Error ? err.message : String(err)}`);
  }
}
