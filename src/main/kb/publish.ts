/**
 * KB Publish — 整页提案的安全发布与页面历史（spec §6，issue 06）。
 *
 * 一次发布 = 一次原子提交（`atomic-commit`）：**旧内容快照、事务清单与
 * commitId 全部持久后才替换目标**，写集固定包含
 *
 *   wiki/<路由目录>/<pageId>.md   正式页（新建或覆盖）
 *   wiki/index.md / overview.md   由已发布页面确定性重建的聚合页
 *   wiki/log.md                   追加日志（同 commitId 幂等）
 *   .kb/page-history/<pageId>.jsonl  页面历史（旧内容 hash / 来源修订 / 操作类型）
 *   .kb/manifest.json             库身份 + 发布 revision
 *   .kb/reviews/<changeSetId>.json 用户选择 + 发布记录
 *
 * 因此不存在「页面已换、索引未换」的中间态：崩溃恢复把事务收敛为
 * **完整旧版或完整新版**，恢复期间由 `read-gate` 暂停同库读取。
 *
 * 发布前校验**实际读/写集与来源/规则基线**（见 `checkBaselines`）：
 * 任一基线变动即转 `stale`，并把该变更集的旧批准重置为 pending
 * （失效的批准不得覆盖新内容），不静默做 LLM merge。
 *
 * issue 07 扩展（spec §6）：
 *  - **多页变更集**：从用户选择重建每页最终候选（`rebuildWikiPage`），
 *    所有未决页须处置（`pendingDecisions`）；同一 commit 更新全部页面、
 *    聚合、历史与 manifest，部分接受标 `published_partial`（`partial`）。
 *  - **跨页链接校验**：本次新增链接按「发布后目录视图」（已发布页 +
 *    最终候选集）解析；目标被拒绝/不存在/歧义 → 阻止发布并定位 hunk。
 *    预先存在的断链不阻断整库，只作 warning（finding 侧处置）。
 *  - **差异指纹**：选择持久时记录 `wikiPageDiffFingerprint`；发布前重算
 *    不一致 = 差异已重新生成，旧 hunk 决定失效转 stale。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §6
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareCommit, completeCommit, runAtomicCommit } from './atomic-commit';
import type { AtomicWritePlan } from './atomic-commit';
import { wikiLayout, readWikiManifest, withManifestLock } from './wiki-layout';
import { readChangeSet, readReview, invalidateReview } from './staging';
import { scanWikiCatalog } from './wiki-catalog';
import { parseWikiPage } from './wiki-page';
import { readTypeDirs, validateProposalTarget } from './proposal-blocks';
import { validateManagedRelPath } from './path-guard';
import { assertReadGateOpen, WikiReadGateError } from './read-gate';
import { resolveCandidateSet, validateCandidateLinks } from './candidate-set';
import type { CandidatePage } from './candidate-set';
import {
  saveCompileCache,
  recordRejection,
  type CompileCacheEntry,
} from './compile-cache';
import {
  buildWikiIndex,
  buildWikiOverview,
  buildWikiLogEntry,
  appendLogEntryIdempotent,
} from './wiki-aggregates';
import type {
  WikiCatalog,
  WikiCatalogPage,
  WikiChangeSet,
  WikiChangeSetReview,
  WikiPageHistoryEntry,
  WikiPageType,
  WikiPublishError,
  WikiPublishErrorCode,
  WikiPublishResult,
  WikiPublishedPage,
} from '@shared/kb-types';

// ── 输入 / 输出契约 ──────────────────────────────────────────────

export type PublishChangeSetInput = {
  /** 当前挂载库身份；与变更集不符时拒绝（不跨库发布） */
  kbId: string;
  changeSetId: string;
  /** 注入时钟（测试用）；生产由应用生成 */
  now?: string;
  /** 注入 commitId（测试用）；生产用 UUID，保证日志/历史/事件中唯一 */
  commitId?: string;
};

/** 一次发布的完整写集（同一次提交的全部目标） */
export type PublishPlan = {
  commitId: string;
  changeSetId: string;
  revision: number;
  pages: WikiPublishedPage[];
  /** 部分接受：存在被拒绝 hunk 的候选页（published_partial） */
  partial: boolean;
  writes: AtomicWritePlan['writes'];
  /** 持久进事务清单的审计字段（读/写集 hash、基线 hash、目标 revision） */
  meta: Record<string, unknown>;
  warnings: string[];
};

export type BuildPublishPlanResult =
  | { ok: true; plan: PublishPlan }
  | { ok: false; error: WikiPublishError };

// ── 错误工具 ────────────────────────────────────────────────────

function fail(code: WikiPublishErrorCode, message: string, detail?: string[]): { ok: false; error: WikiPublishError } {
  return { ok: false, error: { code, message, ...(detail ? { detail } : {}) } };
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

async function hashFileOrNull(filePath: string): Promise<string | null> {
  try {
    return sha256Text(await readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ── 页面历史 ────────────────────────────────────────────────────

/** 页面历史的落盘路径：`.kb/page-history/<pageId 展平>.jsonl` */
export function historyFilePath(kbPath: string, pageId: string): string {
  return join(wikiLayout(kbPath).pageHistoryDir, `${pageId.replace(/[/\\]/g, '__')}.jsonl`);
}

/**
 * 幂等追加页面历史：已有同一 commitId 的行时原样返回。
 *
 * 崩溃恢复的 roll-forward 会重放同一 after 镜像；重放不得产生重复历史。
 */
export function appendHistoryEntryIdempotent(
  existing: string | null,
  entry: WikiPageHistoryEntry,
): string {
  if (existing !== null && existingHasCommitId(existing, entry.commitId)) return existing;
  const line = JSON.stringify(entry);
  const base = existing === null || existing.length === 0
    ? ''
    : existing.endsWith('\n') ? existing : `${existing}\n`;
  return `${base}${line}\n`;
}

function existingHasCommitId(jsonl: string, commitId: string): boolean {
  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { commitId?: unknown };
      if (parsed.commitId === commitId) return true;
    } catch {
      // 坏行不参与判定（不静默删除现场）
    }
  }
  return false;
}

// ── 发布串行化 ──────────────────────────────────────────────────

const publishLocks = new Map<string, Promise<unknown>>();

/**
 * 串行化同一库的发布：并发 prepare/rename 会互相看到半成品页集。
 *
 * `prev.then(fn, fn)` 的 onRejected 也用 `fn`：前一次发布失败不应让
 * 后续发布被 unhandled rejection 卡住（锁链只关心「排到队尾」）。
 */
export async function withPublishLock<T>(kbPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = publishLocks.get(kbPath) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  publishLocks.set(kbPath, run.catch(() => undefined));
  return run;
}

// ── 规划 ────────────────────────────────────────────────────────

/** 发布写集的最小单位：candidate-set 的最终候选 + 沙箱/路由/frontmatter 校验结果 */
type PublishCandidate = CandidatePage & {
  relPath: string;
  pageId: string;
  routeType: WikiPageType;
  parse: Extract<ReturnType<typeof parseWikiPage>, { ok: true }>;
};

/**
 * 校验并构建发布写集（**不改动磁盘**，仅做 schema 沙箱所需的目录创建）。
 *
 * 失败即返回结构化错误；`stale` 的批准失效由 `publishChangeSet` 负责落盘
 * ——本函数保持可重放，方便测试逐步注入故障。
 */
export async function buildPublishPlan(
  kbPath: string,
  input: PublishChangeSetInput,
): Promise<BuildPublishPlanResult> {
  const csRes = await readChangeSet(kbPath, input.changeSetId);
  if (!csRes.ok) return fail(mapStagingError(csRes.error.code), csRes.error.message);
  const cs = csRes.value;

  if (cs.kbId !== input.kbId) {
    return fail('kbIdMismatch', `变更集 ${cs.changeSetId} 不属于库 ${input.kbId}`);
  }
  if (cs.pages.length === 0) {
    return fail('invalidTarget', '变更集没有任何页面候选');
  }

  const reviewRes = await readReview(kbPath, input.changeSetId);
  if (!reviewRes.ok) return fail(mapStagingError(reviewRes.error.code), reviewRes.error.message);
  const review = reviewRes.value;
  if (review.published) {
    return fail('alreadyPublished', `变更集已发布（commitId ${review.published.commitId}），不重复发布`);
  }

  // ── 从用户选择重建最终候选（issue 07，candidate-set 纯函数）────
  // 判定顺序：差异指纹不符 → stale；没有任何接受页 → nothingAccepted；
  // 另有未决页 → pendingDecisions（所有未决项必须明确处置才能发布）。
  const resolved = resolveCandidateSet(cs, review);
  if (!resolved.ok) {
    if (resolved.error.code === 'stale') {
      return fail('stale', resolved.error.message, resolved.error.detail);
    }
    if (resolved.error.code === 'unsettled') {
      return fail('pendingDecisions', resolved.error.message, resolved.error.detail);
    }
    return fail('nothingAccepted', resolved.error.message, resolved.error.detail);
  }

  // ── 候选页逐个过沙箱与 frontmatter 校验 ────────────────────────
  // 沙箱再校验：schema 可能在 staging 之后变化（变动亦会由基线校验判 stale）
  const typeDirs = await readTypeDirs(kbPath);
  if (typeDirs === null) return fail('invalidTarget', 'schema.md 无法解析，拒绝发布（不回退无约束）');

  const candidates: PublishCandidate[] = [];
  for (const base of resolved.pages) {
    const page = base.page;
    const target = await validateProposalTarget(kbPath, page.relPath, typeDirs);
    if (!target.ok) return fail('invalidTarget', `发布目标不可写: ${page.relPath} — ${target.reason}`);
    const relPath = target.relPath;
    const pageId = pageIdOf(relPath);

    const routeType = routeTypeOf(relPath, typeDirs);
    if (routeType === null) return fail('invalidTarget', `发布目标目录不在 schema 路由内: ${relPath}`);

    // frontmatter 契约校验基于**重建后的最终候选**（逐 hunk 取舍后的内容）
    const parse = parseWikiPage(base.content);
    if (!parse.ok) {
      return fail('invalidTarget', `提案页 frontmatter 非法: ${relPath} — ${parse.issues.map((i) => i.message).join('；')}`);
    }

    candidates.push({ ...base, relPath, pageId, routeType, parse });
  }

  // ── 基线校验（读/写集、来源、规则）────────────────────────────
  const staleReasons = await checkBaselines(kbPath, cs, candidates);
  if (staleReasons.length > 0) {
    return fail('stale', '发布前基线校验未通过：读/写集或来源/规则基线已变动，旧批准已失效。', staleReasons);
  }

  // ── 发布后目录视图（已发布页 + 最终候选集）────────────────────
  const scan = await scanWikiCatalog(kbPath);
  if (!scan.ok) {
    return fail('invalidTarget', `wiki/ 或 schema 无法解析，无法生成聚合页: ${scan.schemaIssues.map((i) => i.message).join('；')}`);
  }
  const candidateIds = new Set(candidates.map((c) => c.pageId));
  const postCatalog: WikiCatalog = {
    ...scan.catalog,
    pages: [
      ...scan.catalog.pages.filter((p) => !candidateIds.has(p.pageId)),
      ...candidates.map((c) => ({
        pageId: c.pageId,
        relPath: c.relPath,
        type: c.routeType,
        kind: 'page' as const,
        parse: c.parse,
        routeMismatch: c.parse.frontmatter.type !== c.routeType,
      } satisfies WikiCatalogPage)),
    ].sort((a, b) => a.pageId.localeCompare(b.pageId)),
  };

  // ── 跨页链接校验（本次新增链接按最终候选集解析，issue 07）──────
  const linkResult = validateCandidateLinks({
    candidates,
    published: scan.catalog.pages.map((p) => ({
      pageId: p.pageId,
      relPath: p.relPath,
      title: p.parse.ok ? p.parse.frontmatter.title : null,
    })),
  });
  if (!linkResult.ok) {
    return fail(
      'unresolvedLink',
      '本次新增链接存在无法解析的目标（目标被拒绝、不存在或歧义），已阻止发布。',
      linkResult.errors.map((e) => `${e.relPath} hunk ${e.hunkId ?? '?'}：${e.message}`),
    );
  }

  // ── 其余写集内容 ─────────────────────────────────────────────
  const layout = wikiLayout(kbPath);
  const now = input.now ?? new Date().toISOString();
  const commitId = input.commitId ?? randomUUID();
  const warnings = [...linkResult.warnings];

  const manifestRes = await readWikiManifest(kbPath);
  if (!manifestRes.ok) {
    return fail('manifestCorrupted', `库 manifest 不可读（${manifestRes.reason}），拒绝发布`);
  }
  const revision = (manifestRes.manifest.publish?.revision ?? 0) + 1;

  // log.md（同 commitId 幂等）；多页 subject 为各页 relPath 的稳定序列
  const logPath = join(layout.wikiDir, 'log.md');
  const logExisting = await readTextOrNull(logPath);
  const logSubject = candidates.map((c) => c.relPath).join(', ');
  const logEntry = buildWikiLogEntry({ at: now, operation: 'publish', subject: logSubject, commitId });
  if (logExisting !== null && logExisting.includes(commitId)) {
    warnings.push(`wiki/log.md 已存在 commitId ${commitId}（重放），跳过重复追加。`);
  }
  const logContent = appendLogEntryIdempotent(logExisting, logEntry, commitId);

  // 页面历史（每页一条，同 commitId 幂等）
  const historyWrites: Array<{ relPath: string; content: string }> = [];
  for (const c of candidates) {
    const historyPath = historyFilePath(kbPath, c.pageId);
    const historyExisting = await readTextOrNull(historyPath);
    if (historyExisting !== null && existingHasCommitId(historyExisting, commitId)) {
      warnings.push(`页面历史已存在 commitId ${commitId}（重放），跳过重复追加。`);
    }
    const historyContent = appendHistoryEntryIdempotent(historyExisting, {
      commitId,
      changeSetId: cs.changeSetId,
      pageId: c.pageId,
      relPath: c.relPath,
      operation: c.operation,
      beforeHash: c.beforeHash,
      afterHash: c.afterHash,
      sources: c.page.sources,
      at: now,
    } satisfies WikiPageHistoryEntry);
    historyWrites.push({ relPath: relativeTo(kbPath, historyPath), content: historyContent });
  }

  const manifestContent = JSON.stringify({
    ...manifestRes.manifest,
    updatedAt: now,
    publish: { revision, commitId, at: now },
  }, null, 2);

  const partial = candidates.some((c) => c.partial);
  const reviewContent = JSON.stringify({
    ...review,
    stale: null,
    published: { commitId, revision, at: now, partial },
    updatedAt: now,
  } satisfies WikiChangeSetReview, null, 2);

  const writes: AtomicWritePlan['writes'] = [
    // 页面前置：保证 rename 失败注入时「页已应用 → 回滚」路径真实可达
    ...candidates.map((c) => ({ relPath: c.relPath, content: c.content })),
    { relPath: join('wiki', 'index.md').replace(/\\/g, '/'), content: buildWikiIndex(postCatalog) },
    { relPath: 'wiki/overview.md', content: buildWikiOverview(postCatalog) },
    { relPath: 'wiki/log.md', content: logContent },
    ...historyWrites,
    { relPath: relativeTo(kbPath, layout.manifestPath), content: manifestContent },
    { relPath: relativeTo(kbPath, join(layout.reviewsDir, `${cs.changeSetId}.json`)), content: reviewContent },
  ];

  // 权限边界：写集只能落在受管范围内（不得扩到项目外任意路径）
  for (const w of writes) {
    const lexical = validateManagedRelPath(w.relPath);
    if (!lexical.ok) return fail('invalidTarget', `写集目标非法: ${w.relPath} — ${lexical.reason}`);
    const allowed = w.relPath.startsWith('wiki/') || w.relPath.startsWith('.kb/');
    if (!allowed) return fail('invalidTarget', `写集目标越出受管范围: ${w.relPath}`);
  }

  // 事务清单审计字段（spec §6：commitId、读/写集 hash、before/after、
  // 目标 revision、状态）。before/after 与状态由 atomic-commit 落盘，
  // 读/写集与基线 hash 在这里算好后随 meta 一起持久。
  const publishedPages: WikiPublishedPage[] = candidates.map((c) => ({
    pageId: c.pageId,
    relPath: c.relPath,
    operation: c.operation,
    beforeHash: c.beforeHash,
    afterHash: c.afterHash,
  }));
  const meta: Record<string, unknown> = {
    changeSetId: cs.changeSetId,
    taskId: cs.taskId,
    origin: cs.origin,
    revision,
    changeSetRevision: revision,
    schemaHash: cs.schemaHash,
    purposeHash: cs.purposeHash,
    readSetHash: sha256Text(JSON.stringify({
      readBaseline: cs.readBaseline,
      sources: cs.sources,
    })),
    writeSetHash: sha256Text(writes.map((w) => `${w.relPath}\n${w.content}`).join('\n')),
    pages: publishedPages,
  };

  return {
    ok: true,
    plan: {
      commitId,
      changeSetId: cs.changeSetId,
      revision,
      pages: publishedPages,
      partial,
      writes,
      meta,
      warnings,
    },
  };
}

// ── 发布 ────────────────────────────────────────────────────────

/**
 * 发布一个整页变更集。
 *
 * 顺序：读取门禁 → 规划/基线校验 → （stale 时失效旧批准）→
 * 原子提交（旧快照与清单持久 → 逐文件 rename → committed 标记与清理）。
 * 任一步失败返回结构化错误，不把部分结果报告为成功。
 *
 * 并发：`withPublishLock` 串行化同库发布（并发 prepare/rename 会互相看到
 * 半成品页集）；`withManifestLock` 与来源导入/转换的 manifest 读改写串行，
 * 避免用旧的 `sources` 视图覆盖并发写入的来源修订。
 */
export async function publishChangeSet(
  kbPath: string,
  input: PublishChangeSetInput,
): Promise<WikiPublishResult> {
  return withPublishLock(kbPath, () => withManifestLock(kbPath, async (): Promise<WikiPublishResult> => {
    try {
      await assertReadGateOpen(kbPath);
    } catch (err) {
      if (err instanceof WikiReadGateError) {
        return fail('readGateBlocked', err.message);
      }
      throw err;
    }

    const built = await buildPublishPlan(kbPath, input);
    if (!built.ok) {
      if (built.error.code === 'stale') {
        await invalidateApproval(kbPath, input.changeSetId, built.error.detail ?? [], input.now);
      }
      // ── 全拒绝记录（issue 17：普通刷新不重新烧 token） ──
      // nothingAccepted = 所有页/hunk 均被拒绝 → 记录拒绝决定
      if (built.error.code === 'nothingAccepted') {
        await recordRejectionAfterPublish(kbPath, input.changeSetId, input.now);
      }
      return { ok: false, error: built.error };
    }

    const plan = built.plan;
    const committed = await runAtomicCommit(kbPath, { txId: plan.commitId, writes: plan.writes, meta: plan.meta });
    if (!committed.ok) {
      return fail('ioError', `发布提交失败（目标保持完整旧版）: ${committed.error.message}`);
    }

    // ── 编译缓存保存（issue 17，spec §4：成功才更新 compile-cache） ──
    // 只有 compile origin 且带指纹的变更集才写缓存；
    // published_partial 也写入但 partial=true（checkCompileCache 会跳过它）。
    // 全拒绝（无候选页）由 resolveCandidateSet 拦截，此处不会走到。
    await saveCompileCacheAfterPublish(kbPath, input.changeSetId, plan);

    return {
      ok: true,
      commitId: plan.commitId,
      revision: plan.revision,
      pages: plan.pages,
      partial: plan.partial,
      warnings: plan.warnings,
    };
  }));
}

/**
 * 准备阶段 + 完成阶段分离的发布入口。
 *
 * 与 `publishChangeSet` 等价，但把事务的两个阶段暴露给调用方/测试：
 * `prepareCommit` 之后目标仍未改变（只有旧快照与清单持久），
 * 便于在崩溃点与 rename 失败点注入故障验证「完整旧版 / 完整新版」。
 * 计划持久化/完成阶段由调用方负责（issue 07 的多页发布沿用同一写集）。
 *
 * **调用方约束**：本入口不取发布锁、不查读取门禁，也不在
 * prepare→complete 之间重新校验基线 —— 单进程内两步应连续调用，
 * 与并发发布/导入串行化由调用方（或 `publishChangeSet`）负责。
 */
export async function preparePublish(
  kbPath: string,
  input: PublishChangeSetInput,
): Promise<{ ok: true; plan: PublishPlan } | { ok: false; error: WikiPublishError }> {
  const built = await buildPublishPlan(kbPath, input);
  if (!built.ok) return built;
  const prepared = await prepareCommit(kbPath, {
    txId: built.plan.commitId,
    writes: built.plan.writes,
    meta: built.plan.meta,
  });
  if (!prepared.ok) {
    return fail('ioError', `发布准备失败（目标未改变）: ${prepared.error.message}`);
  }
  return { ok: true, plan: built.plan };
}

/** 完成 `preparePublish` 开启的事务；失败时进程内回滚保持完整旧版。 */
export async function completePublish(kbPath: string, commitId: string): Promise<{ ok: true } | { ok: false; error: WikiPublishError }> {
  const done = await completeCommit(kbPath, commitId);
  if (!done.ok) return fail('ioError', `发布提交失败（目标保持完整旧版）: ${done.error.message}`);
  return { ok: true };
}

// ── 基线校验 ────────────────────────────────────────────────────

/**
 * 校验实际读/写集与来源/规则基线。返回非空即 stale。
 *
 * 覆盖 spec §6：「校验写集基线与实际参与推断的读集。若其他编译、回滚、
 * 来源更新、规则修改或外部编辑改变基线，进入 stale」。
 *
 * issue 07 扩展：
 *  - 写集基线对**每个候选页**逐一校验（外部修改第二页同样转 stale）；
 *  - 读集基线按最终候选集验证：候选集内的页由写集基线保证其现势性，
 *    不再与磁盘重复比对（同一次提交内该页将以最终候选内容发布）。
 *  - 差异指纹（hunksHash）校验在 `resolveCandidateSet` 内完成。
 */
async function checkBaselines(
  kbPath: string,
  cs: WikiChangeSet,
  candidates: PublishCandidate[],
): Promise<string[]> {
  const layout = wikiLayout(kbPath);
  const reasons: string[] = [];

  // 规则基线（schema/purpose）
  if (await hashFileOrNull(layout.schemaMdPath) !== cs.schemaHash) {
    reasons.push('规则基线变动：schema.md 与生成提案时不一致。');
  }
  if (await hashFileOrNull(layout.purposeMdPath) !== cs.purposeHash) {
    reasons.push('规则基线变动：purpose.md 与生成提案时不一致。');
  }

  // 写集基线（外部编辑 / 目标被创建 / 目标被删除）—— 逐候选页
  for (const c of candidates) {
    const current = await readTextOrNull(join(kbPath, c.relPath));
    if (c.page.before === null) {
      if (current !== null) {
        reasons.push(`写集基线变动：新页目标 ${c.relPath} 已存在（提案基线为「不存在」）。`);
      }
    } else if (current === null) {
      reasons.push(`写集基线变动：${c.relPath} 已不存在（提案基线为已发布页）。`);
    } else if (sha256Text(current) !== c.page.baselineHash) {
      reasons.push(`写集基线变动：${c.relPath} 内容与提案基线不一致（可能被外部编辑）。`);
    }
  }

  // 来源基线：提案固定的 sourceRevision 必须是当前修订
  const manifest = await readWikiManifest(kbPath);
  if (manifest.ok) {
    for (const ref of cs.sources) {
      const record = manifest.manifest.sources?.[ref.sourceId];
      if (!record) {
        reasons.push(`来源基线变动：来源 ${ref.sourceId.slice(0, 8)} 已不存在（撤回或未登记）。`);
      } else if (record.currentRevision !== ref.sourceRevision) {
        reasons.push(
          `来源基线变动：来源 ${ref.sourceId.slice(0, 8)} 修订已更新`
          + `（${ref.sourceRevision.slice(0, 8)} → ${record.currentRevision.slice(0, 8)}）。`,
        );
      }
    }
  }

  // 读集基线：本变更集参考过的已发布页必须与读取时一致。
  // 候选集内的页由上面的写集基线保证（同一次提交会以最终候选发布）。
  const candidateIds = new Set(candidates.map((c) => c.pageId));
  for (const rb of cs.readBaseline) {
    if (candidateIds.has(rb.pageId)) continue;
    const currentContent = await readTextOrNull(join(kbPath, 'wiki', `${rb.pageId}.md`));
    if (currentContent === null) {
      reasons.push(`读集基线变动：已发布页 ${rb.pageId} 已不存在。`);
    } else if (sha256Text(currentContent) !== rb.hash) {
      reasons.push(`读集基线变动：已发布页 ${rb.pageId} 内容已变化。`);
    }
  }

  return reasons;
}

/**
 * 基线变动时失效旧批准：决策全部重置为 pending 并记录 stale 原因。
 *
 * `staging.invalidateReview` 是 `.kb/reviews/` 的唯一写入口（展示/发布两侧
 * 都不直接改审阅状态）；「不在批准之后悄悄做 LLM merge」——失效后必须
 * 重新生成差异并重新批准。失效标记写失败不改变「不发布」的结论：旧批准
 * 每次发布都会重新校验基线，不会因此被误用。
 */
async function invalidateApproval(
  kbPath: string,
  changeSetId: string,
  reasons: string[],
  now?: string,
): Promise<void> {
  await invalidateReview(kbPath, changeSetId, reasons, now);
}

// ── 内部工具 ────────────────────────────────────────────────────

function pageIdOf(relPath: string): string {
  return relPath.slice('wiki/'.length, -3);
}

function routeTypeOf(relPath: string, typeDirs: Record<WikiPageType, string>): WikiPageType | null {
  const pageId = pageIdOf(relPath);
  const dir = pageId.includes('/') ? pageId.slice(0, pageId.lastIndexOf('/')) : '';
  const normalized = normalizeDir(dir);
  for (const [type, d] of Object.entries(typeDirs) as Array<[WikiPageType, string]>) {
    if (normalizeDir(d) === normalized) return type;
  }
  return null;
}

function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

/** 库内相对路径（统一 `/`），用于写集目标 */
function relativeTo(kbPath: string, absPath: string): string {
  const rel = absPath.slice(kbPath.length).replace(/^[/\\]+/, '');
  return rel.replace(/\\/g, '/');
}

function mapStagingError(code: string): WikiPublishErrorCode {
  if (code === 'changeSetNotFound') return 'changeSetNotFound';
  if (code === 'stagingCorrupted') return 'stagingCorrupted';
  return 'ioError';
}

// ── 编译缓存保存（issue 17）─────────────────────────────────────

/**
 * 发布成功后保存编译缓存或记录全拒绝。
 *
 * - compile origin + compileCacheFingerprint 存在 → saveCompileCache
 *   (partial=true 时写入但 checkCompileCache 会跳过)
 * - compile origin + 无候选页（全拒绝）→ recordRejection
 *   (spec §4：全拒绝记录决定，普通刷新不烧 token)
 * - saveQuery/fix origin → 不处理缓存
 *
 * 失败不阻断发布结果（缓存是派生数据，可重建）。
 */
async function saveCompileCacheAfterPublish(
  kbPath: string,
  changeSetId: string,
  plan: PublishPlan,
): Promise<void> {
  // 重新读取变更集以获取 origin 和 compileCacheFingerprint
  const csRes = await readChangeSet(kbPath, changeSetId);
  if (!csRes.ok) return;
  const cs = csRes.value;

  if (cs.origin !== 'compile') return;
  if (!cs.sources[0]) return;
  const sourceRef = cs.sources[0]!;

  // 全拒绝：resolveCandidateSet 会以 nothingAccepted 阻止发布。
  // 但如果走到这里且 plan.pages 为空（理论上不会），记录拒绝。
  if (plan.pages.length === 0) {
    const now = plan.meta.publishedAt as string | undefined ?? new Date().toISOString();
    await recordRejection(kbPath, sourceRef.sourceId, sourceRef.sourceRevision, now);
    return;
  }

  // 有编译缓存指纹 → 保存
  if (cs.compileCacheFingerprint) {
    const now = plan.meta.publishedAt as string | undefined ?? new Date().toISOString();
    const entry: CompileCacheEntry = {
      fingerprint: cs.compileCacheFingerprint,
      sourceId: sourceRef.sourceId,
      sourceRevision: sourceRef.sourceRevision,
      publishedPageIds: plan.pages.map((p) => p.pageId),
      publishedAt: now,
      partial: plan.partial,
    };
    await saveCompileCache(kbPath, sourceRef.sourceId, entry);
  }
}

/**
 * 全拒绝时记录拒绝决定（issue 17：普通刷新不重新烧 token）。
 * 只有 compile origin 的变更集参与拒绝记录。
 * 失败不阻断发布失败结果（拒绝记录是派生数据，可重建）。
 */
async function recordRejectionAfterPublish(
  kbPath: string,
  changeSetId: string,
  nowOverride?: string,
): Promise<void> {
  const csRes = await readChangeSet(kbPath, changeSetId);
  if (!csRes.ok) return;
  const cs = csRes.value;
  if (cs.origin !== 'compile') return;
  if (!cs.sources[0]) return;
  const sourceRef = cs.sources[0]!;
  const now = nowOverride ?? new Date().toISOString();
  await recordRejection(kbPath, sourceRef.sourceId, sourceRef.sourceRevision, now);
}
