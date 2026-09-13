/**
 * KB Source Import — 来源导入、修订保留与转换编排（issue 02，spec §1/§2）。
 *
 * 导入管线（每个来源，状态先于切换持久化）：
 *   1. 规范化相对路径（path-guard 词法校验 + NFC）→ sourceId（含目录/扩展名）
 *   2. 能力校验：文本直通（.md/.markdown/.txt）或引擎 supportedExtensions；
 *      不宣称不支持的格式（unsupportedFormat）
 *   3. 碰撞检测：NFC+大小写折叠键相同而 sourceId 不同 → caseConflict
 *   4. 读原件字节（失败不留任何记录）→ revision = 原件字节 SHA256
 *   5. 幂等：同路径同字节同引擎指纹且 ready → reused（不新增修订、不落盘）
 *   6. 保留被引用证据：引用根（已发布页/page-history/staging）仍引用旧修订时，
 *      替换前把旧原件与旧 parsed 复制进 raw/revisions/<sid>/<rev>/
 *   7. 原件原子落盘 → manifest 先记 converting（崩溃后 parsedStale 可见可重试）
 *   8. 转换：anydoc（Markdown + 内容寻址 assets）或文本直通（剥 BOM）；
 *      parsed 保留源扩展名（notes.md → notes.md.md）；图片占位回写
 *      raw/assets/<sid>/<rev>/<hash>.<ext> 的相对路径
 *   9. manifest 终态：ready（parsedRevision = 当前修订）或 failed
 *      （错误码持久、parsedRevision 停留旧修订 —— 旧全文不标成新版）
 *
 * 转换产物先写临时文件再 rename（writeFileAtomic）；失败状态/错误码持久且
 * 重开可见；预览与原件解析全部从身份（sourceId/revision/parsedHash）出发，
 * 不接受任意路径。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §1、§2
 * @see .scratch/llm-wiki/issues/02-source-import-revisions.md
 */

import { basename, dirname, extname, join } from 'node:path';
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from './atomic-commit';
import {
  readWikiManifest,
  wikiLayout,
  writeWikiManifest,
  withManifestLock,
  type WikiKbManifest,
  type WikiLayoutPaths,
} from './wiki-layout';
import {
  isTextImportExtension,
  normalizeSourcePath,
  sourceCollisionKey,
  sourceIdFor,
  TEXT_IMPORT_EXTENSIONS,
} from './source-identity';
import { collectReferencedRevisions } from './source-refs';
import { getActiveConvertEngine, getConvertEngine } from './engines';
import type { ConvertEngine, EngineAsset } from './engines/types';
import type {
  WikiParsedView,
  WikiSourceErrorCode,
  WikiSourceRecord,
  WikiSourceRevisionInfo,
  WikiSourceSummary,
} from '@shared/kb-types';

// ── 类型 ────────────────────────────────────────────────────────

export type SourceImportInput = {
  /** 来源文件当前所在绝对路径（库外任意位置） */
  absolutePath: string;
  /** 库内相对路径（含目录与扩展名）；缺省取 absolutePath 的 basename */
  relPath?: string;
};

export type SourceImportError = { code: WikiSourceErrorCode; message: string };

export type SourceImportOutcome =
  | { ok: true; source: WikiSourceRecord; /** true = 同路径同字节幂等复用 */ reused: boolean }
  | { ok: false; error: SourceImportError };

export type SourceConvertOutcome =
  | { ok: true; source: WikiSourceRecord }
  | { ok: false; error: SourceImportError };

export type ReadWikiParsedQuery = {
  sourceId: string;
  /** 缺省 = 当前全文；指定历史修订时从 revisions 区解析 */
  revision?: string;
  /** 指定 parsed 快照（同修订多次转换的多个 parsedHash） */
  parsedHash?: string;
};

export type ResolveOriginalQuery = {
  sourceId: string;
  /** 缺省 = 当前原件；指定历史修订时从 revisions 区解析 */
  revision?: string;
};

/** 结构化错误（router 映射为 TRPCError；调用方可按 code 分支） */
export class WikiSourceError extends Error {
  constructor(
    readonly code: WikiSourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WikiSourceError';
  }
}

/**
 * 转换被中止（AbortSignal）。不落任何产物、不改失败状态：
 * manifest 停留 converting（parsedStale 可见，可重试）。
 * 队列据此判定「工作被中止」而非「转换失败」。
 */
export class WikiSourceAbortedError extends Error {
  /** 中止发生在任何转换工作开始之前（未落 parsed/assets，converting 标记可还原） */
  beforeStart = false;

  constructor() {
    super('转换已中止');
    this.name = 'WikiSourceAbortedError';
  }
}

function throwIfAborted(signal: AbortSignal | undefined, beforeStart = false): void {
  if (signal?.aborted) {
    const err = new WikiSourceAbortedError();
    err.beforeStart = beforeStart;
    throw err;
  }
}

/** 转换执行的可选控制（持久队列接入，issue 03） */
export type ConvertControl = {
  /** 中止信号：在可中止边界检查（引擎调用前后、产物落盘前）；
   *  最终 manifest 写入（提交临界区）不可中止 */
  signal?: AbortSignal;
  /** 进入提交临界区（最终 manifest 写入前）时通知 */
  onCommitting?: () => void;
};

// ── 工具 ────────────────────────────────────────────────────────

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 文本直通引擎指纹（文本管线无引擎版本概念，常量即可） */
const TEXT_FINGERPRINT = 'text:v1';

function engineFingerprintOf(engine: ConvertEngine): string {
  return `${engine.id}|${engine.supportedExtensions.join(',')}`;
}

function extOf(sourcePath: string): string {
  return extname(sourcePath).toLowerCase();
}

/** 剥离 UTF-8 BOM（文本直通机械全文不得携带 BOM） */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function failure(code: WikiSourceErrorCode, message: string): SourceImportError {
  return { code, message };
}

/** parsed 落盘路径：raw/parsed/<sourcePath>.md（保留源扩展名） */
function parsedAbsPath(layout: WikiLayoutPaths, sourcePath: string): string {
  return join(layout.rawParsedDir, ...(sourcePath + '.md').split('/'));
}

/** parsed → assets 的相对路径前缀（按 sourcePath 目录深度回写） */
function relAssetPrefix(sourcePath: string, sourceId: string, revision: string): string {
  const subDirCount = sourcePath.split('/').length - 1;
  return '../'.repeat(subDirCount + 1) + `assets/${sourceId}/${revision}/`;
}

/**
 * 把 Markdown 中的 `![alt](imageN)` 占位回写为 assets 相对路径。
 * N 与引擎输出 assets 的引用顺序（1 起）对应；越界占位保持原样。
 */
function rewriteImageRefs(
  markdown: string,
  entries: ReadonlyArray<{ file: string }>,
  relPrefix: string,
): string {
  return markdown.replace(/!\[([^\]]*)\]\(image(\d+)\)/g, (whole, alt: string, num: string) => {
    const entry = entries[Number.parseInt(num, 10) - 1];
    if (!entry) return whole;
    return `![${alt}](${relPrefix}${entry.file})`;
  });
}

// ── 证据保留 ────────────────────────────────────────────────────

/**
 * 替换前保留仍被引用的旧证据（spec §1「保存仍被引用的旧修订」）。
 *
 *  - 旧原件：引用根含 (sid, 旧 currentRevision) 且本次确实要换原件
 *    时，复制 raw/sources/<sourcePath> → revisions/<sid>/<旧rev>/<原文件名>
 *  - 旧 parsed：引用根含 (sid, 旧 parsedRevision) 时，复制
 *    raw/parsed/<sourcePath>.md → revisions/<sid>/<旧parsedRev>/parsed/<parsedHash>.md
 *
 * 引用扫描允许假阳性（多保留一份证据无害），绝不允许假阴性。
 * 证据复制失败必须向上抛出（调用方中止替换，不覆盖被引用证据）。
 */
async function preserveReferencedEvidence(
  kbPath: string,
  layout: WikiLayoutPaths,
  old: WikiSourceRecord,
  opts: { preserveOriginal: boolean },
): Promise<void> {
  const refs = await collectReferencedRevisions(kbPath);
  const referencedRevisions = refs.get(old.sourceId);
  if (!referencedRevisions || referencedRevisions.size === 0) return;

  const revDir = join(layout.rawRevisionsDir, old.sourceId, old.currentRevision);
  if (opts.preserveOriginal && referencedRevisions.has(old.currentRevision)) {
    const srcAbs = join(layout.rawSourcesDir, ...old.sourcePath.split('/'));
    await mkdir(revDir, { recursive: true });
    await copyFile(srcAbs, join(revDir, basename(old.sourcePath)));
  }
  if (old.parsedRevision && old.parsedHash && referencedRevisions.has(old.parsedRevision)) {
    const parsedDir = join(layout.rawRevisionsDir, old.sourceId, old.parsedRevision, 'parsed');
    const srcAbs = parsedAbsPath(layout, old.sourcePath);
    await mkdir(parsedDir, { recursive: true });
    await copyFile(srcAbs, join(parsedDir, `${old.parsedHash}.md`));
  }
}

// ── 转换执行（importOne / convertWikiSource 共用） ──────────────

async function writeAssets(
  layout: WikiLayoutPaths,
  sourceId: string,
  revision: string,
  assets: readonly EngineAsset[],
): Promise<Array<{ assetId: string; file: string; order: number }>> {
  if (assets.length === 0) return [];
  const dir = join(layout.rawAssetsDir, sourceId, revision);
  await mkdir(dir, { recursive: true });
  const entries: Array<{ assetId: string; file: string; order: number }> = [];
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i]!;
    const hash = sha256Hex(Buffer.from(asset.data));
    const file = `${hash}.${asset.ext}`;
    const abs = join(dir, file);
    // 内容寻址：同字节只存一份（同图多次引用复用）
    try {
      await stat(abs);
    } catch {
      await writeFileAtomic(abs, Buffer.from(asset.data));
    }
    entries.push({ assetId: hash, file, order: i + 1 });
  }
  await writeFileAtomic(join(dir, 'assets.json'), JSON.stringify({ assets: entries }, null, 2));
  return entries;
}

async function writeParsedFile(
  layout: WikiLayoutPaths,
  sourcePath: string,
  content: string,
): Promise<void> {
  const abs = parsedAbsPath(layout, sourcePath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFileAtomic(abs, content);
}

/** 记录失败终态。code 为 WikiSourceErrorCode 或引擎错误码（如 anydoc 的 'encrypted'） */
function markFailed(rec: WikiSourceRecord, code: string, message: string): void {
  rec.status = 'failed';
  rec.errorCode = code;
  rec.errorMessage = message;
  rec.assetCount = 0;
}

/** 把 src 的来源字段同步到 target（含可选字段的删除语义） */
function syncRecFields(target: WikiSourceRecord, src: WikiSourceRecord): void {
  Object.assign(target, structuredClone(src));
  if (src.errorCode === undefined) delete target.errorCode;
  if (src.errorMessage === undefined) delete target.errorMessage;
}

/**
 * 串行化的 manifest 读改写：取锁 → 以最新 manifest 为基 → apply 变更 →
 * 原子写回。并发转换/导入共享同一 manifest.json，直接以旧读为基写回会
 * 丢更新，同名 rename 在 Windows 上会 EPERM。
 */
async function commitManifestUpdate(
  kbPath: string,
  apply: (manifest: WikiKbManifest) => void,
): Promise<void> {
  await withManifestLock(kbPath, async () => {
    const read = await readWikiManifest(kbPath);
    if (!read.ok) {
      throw new Error(`库 manifest 不可读（${read.reason}）`);
    }
    apply(read.manifest);
    read.manifest.updatedAt = new Date().toISOString();
    await writeWikiManifest(kbPath, read.manifest);
  });
}

/**
 * 执行转换并写入 parsed/assets，把 rec 推到终态（ready/failed）。
 * engine = null 表示文本直通。返回 null = 成功；否则返回错误码字符串。
 * rec.currentRevision 必须已是新修订；parsedRevision/parsedHash 在失败时
 * 保持旧值（旧全文不标成新版）。
 *
 * 不直接写 manifest：调用方在拿到终态后经 commitManifestUpdate 以最新
 * manifest 为基提交（并发安全）。
 *
 * 可中止边界：引擎调用前后、assets/parsed 落盘前（此时 manifest 已是
 * converting，无半成品提交）。进入终态提交前触发 onCommitting，提交
 * 临界区不可中止（写一半丢弃会破坏「完整旧版或完整新版」语义）。
 */
async function finalizeConversion(
  kbPath: string,
  layout: WikiLayoutPaths,
  rec: WikiSourceRecord,
  bytes: Buffer,
  engine: ConvertEngine | null,
  fingerprint: string,
  control: ConvertControl = {},
): Promise<string | null> {
  const { signal, onCommitting } = control;
  try {
    if (engine === null) {
      // 文本直通：机械全文 = 原文本剥 BOM，无隐式特例
      throwIfAborted(signal, true);
      const parsed = stripBom(bytes.toString('utf-8'));
      await writeParsedFile(layout, rec.sourcePath, parsed);
      rec.engine = 'text';
      rec.engineFingerprint = TEXT_FINGERPRINT;
      rec.parsedRevision = rec.currentRevision;
      rec.parsedHash = sha256Hex(Buffer.from(parsed, 'utf-8'));
      rec.assetCount = 0;
      rec.status = 'ready';
      delete rec.errorCode;
      delete rec.errorMessage;
    } else {
      throwIfAborted(signal, true);
      const result = await engine.convert(bytes, rec.sourcePath);
      if (!result.ok) {
        const detail = result.error.detail ? `（${result.error.detail}）` : '';
        markFailed(rec, result.error.code, `${result.error.message}${detail}`);
      } else {
        throwIfAborted(signal);
        const entries = await writeAssets(layout, rec.sourceId, rec.currentRevision, result.output.assets);
        const relPrefix = relAssetPrefix(rec.sourcePath, rec.sourceId, rec.currentRevision);
        const parsed = rewriteImageRefs(result.output.markdown, entries, relPrefix);
        throwIfAborted(signal);
        await writeParsedFile(layout, rec.sourcePath, parsed);
        rec.engine = engine.id;
        rec.engineFingerprint = fingerprint;
        rec.parsedRevision = rec.currentRevision;
        rec.parsedHash = sha256Hex(Buffer.from(parsed, 'utf-8'));
        rec.assetCount = result.output.assets.length;
        rec.status = 'ready';
        delete rec.errorCode;
        delete rec.errorMessage;
      }
    }
  } catch (err) {
    // 中止不是失败：不落失败状态，向上传递（调用方负责还原 converting 标记）
    if (err instanceof WikiSourceAbortedError) {
      throw err;
    }
    // 产物写入失败同样持久失败状态（原件已保存，parsed 停留旧值）
    markFailed(rec, 'ioError', `转换产物写入失败: ${String(err)}`);
  }
  // 提交临界区：parsed/assets 已落盘，终态 manifest 必须写完（不可中止）
  onCommitting?.();
  rec.updatedAt = new Date().toISOString();
  return rec.status === 'ready' ? null : (rec.errorCode ?? 'ioError');
}

// ── 导入 ────────────────────────────────────────────────────────

/**
 * 批量导入来源；逐文件独立结果（部分失败不影响其余）。
 * 结果顺序与输入一致。同一调用内串行处理，manifest 逐文件推进。
 */
export async function importWikiSources(
  kbPath: string,
  items: readonly SourceImportInput[],
): Promise<SourceImportOutcome[]> {
  const read = await readWikiManifest(kbPath);
  if (!read.ok) {
    const error = failure('manifestCorrupted', `库 manifest 不可读（${read.reason}），拒绝导入`);
    return items.map(() => ({ ok: false as const, error }));
  }
  const manifest = read.manifest;
  manifest.sources ??= {};
  const layout = wikiLayout(kbPath);

  const outcomes: SourceImportOutcome[] = [];
  for (const item of items) {
    outcomes.push(await importOne(kbPath, layout, manifest, item));
  }
  return outcomes;
}

async function importOne(
  kbPath: string,
  layout: WikiLayoutPaths,
  manifest: WikiKbManifest,
  item: SourceImportInput,
): Promise<SourceImportOutcome> {
  // 1. 路径规范化与身份
  const rawRel = typeof item.relPath === 'string' && item.relPath.length > 0
    ? item.relPath
    : basename(item.absolutePath);
  const normalized = normalizeSourcePath(rawRel);
  if (!normalized.ok) {
    return { ok: false, error: failure('invalidPath', normalized.reason) };
  }
  const sourcePath = normalized.normalized;
  const sourceId = sourceIdFor(sourcePath);
  const ext = extOf(sourcePath);

  // 2. 能力校验（先于任何落盘；不宣称引擎不支持的格式）
  const isText = isTextImportExtension(ext);
  let engine: ConvertEngine | null = null;
  if (!isText) {
    engine = await getActiveConvertEngine();
    if (!engine.supportedExtensions.includes(ext)) {
      const shown = ext || '（无扩展名）';
      return {
        ok: false,
        error: failure('unsupportedFormat', `不支持的导入格式: ${shown}（引擎 ${engine.label}）`),
      };
    }
  }
  const fingerprint = isText || engine === null ? TEXT_FINGERPRINT : engineFingerprintOf(engine);

  // 3. 大小写等价碰撞检测（manifest 既有显示拼写不受影响）
  const sources = (manifest.sources ??= {});
  const collisionKey = sourceCollisionKey(sourcePath);
  for (const [otherId, other] of Object.entries(sources)) {
    if (otherId !== sourceId && sourceCollisionKey(other.sourcePath) === collisionKey) {
      return {
        ok: false,
        error: failure('caseConflict', `路径大小写等价冲突: 已存在 ${other.sourcePath}，拒绝导入 ${sourcePath}`),
      };
    }
  }

  // 4. 读原件字节（失败不留任何记录）
  let bytes: Buffer;
  try {
    bytes = await readFile(item.absolutePath);
  } catch (err) {
    return { ok: false, error: failure('ioError', `读取来源文件失败: ${String(err)}`) };
  }
  const revision = sha256Hex(bytes);

  // 5. 幂等复用：同路径同字节同指纹且 ready → 不新增修订、不落盘
  const existing = sources[sourceId];
  if (
    existing
    && existing.status === 'ready'
    && existing.currentRevision === revision
    && existing.engineFingerprint === fingerprint
  ) {
    return { ok: true, source: existing, reused: true };
  }

  // 6+7. 保留被引用证据（先于覆盖），原件原子落盘
  try {
    if (existing) {
      await preserveReferencedEvidence(kbPath, layout, existing, {
        preserveOriginal: existing.currentRevision !== revision,
      });
    }
    const originalAbs = join(layout.rawSourcesDir, ...sourcePath.split('/'));
    await mkdir(dirname(originalAbs), { recursive: true });
    await writeFileAtomic(originalAbs, bytes);
  } catch (err) {
    return { ok: false, error: failure('ioError', `保存原件失败: ${String(err)}`) };
  }

  const nowIso = new Date().toISOString();
  const rec: WikiSourceRecord = existing ?? {
    sourcePath,
    sourceId,
    ext,
    size: bytes.length,
    currentRevision: revision,
    parsedRevision: null,
    parsedHash: null,
    engine: null,
    engineFingerprint: null,
    status: 'converting',
    assetCount: 0,
    importedAt: nowIso,
    updatedAt: nowIso,
  };
  rec.sourcePath = sourcePath;
  rec.ext = ext;
  rec.size = bytes.length;
  rec.currentRevision = revision;
  sources[sourceId] = rec;

  // 转换中状态先行持久：崩溃后 parsedStale 可见，旧全文不被标成新版。
  // 串行化提交（以最新 manifest 为基），本地 batch manifest 同步更新。
  rec.status = 'converting';
  delete rec.errorCode;
  delete rec.errorMessage;
  rec.updatedAt = nowIso;
  manifest.updatedAt = nowIso;
  try {
    await commitManifestUpdate(kbPath, (m) => {
      const target = m.sources?.[sourceId];
      if (target) {
        syncRecFields(target, rec);
      } else {
        (m.sources ??= {})[sourceId] = structuredClone(rec);
      }
    });
  } catch (err) {
    return { ok: false, error: failure('ioError', `写入 manifest 失败: ${String(err)}`) };
  }
  (manifest.sources ??= {})[sourceId] = rec;

  // 8+9. 转换与终态（ready/failed 都必须持久化）
  try {
    const failCode = await finalizeConversion(kbPath, layout, rec, bytes, isText ? null : engine, fingerprint);
    await commitManifestUpdate(kbPath, (m) => {
      const target = m.sources?.[sourceId];
      if (target) {
        syncRecFields(target, rec);
      } else {
        (m.sources ??= {})[sourceId] = structuredClone(rec);
      }
    });
    manifest.updatedAt = rec.updatedAt;
    if (failCode !== null) {
      return {
        ok: false,
        error: failure('ioError', `来源已保存但转换失败（${failCode}）: ${rec.errorMessage ?? ''}`),
      };
    }
    return { ok: true, source: rec, reused: false };
  } catch (err) {
    return { ok: false, error: failure('ioError', `转换结果持久化失败: ${String(err)}`) };
  }
}

// ── 重试转换 ────────────────────────────────────────────────────

/**
 * 对既有来源重跑转换（失败重试 / 引擎指纹变更后手动重转）。
 * 从 raw/sources/ 的当前原件出发；原件字节与 currentRevision 不符时拒绝
 * （originalHashMismatch —— 不在证据区上猜）。
 *
 * 可选中止（持久队列接入）：signal 在标记 converting 之前与引擎调用等
 * 可中止边界检查。被中止时把 converting 标记还原为运行前状态（队列暂停/
 * 取消/切库后库清单与运行前一致，被中止的运行不留任何痕迹）；还原失败时
 * manifest 停留 converting（parsedStale 可见，可重试）。
 */
export async function convertWikiSource(
  kbPath: string,
  sourceId: string,
  control: ConvertControl = {},
): Promise<SourceConvertOutcome> {
  const { signal } = control;
  const layout = wikiLayout(kbPath);
  const read = await readWikiManifest(kbPath);
  if (!read.ok) {
    return { ok: false, error: failure('manifestCorrupted', `库 manifest 不可读（${read.reason}）`) };
  }
  const manifest = read.manifest;
  const rec = manifest.sources?.[sourceId];
  if (!rec) {
    return { ok: false, error: failure('sourceNotFound', `来源不存在: ${sourceId}`) };
  }

  const isText = isTextImportExtension(rec.ext);
  const engine = isText ? null : await getActiveConvertEngine();
  const fingerprint = isText || engine === null ? TEXT_FINGERPRINT : engineFingerprintOf(engine);

  // 已是最新（同修订、同指纹、已转换）→ 无需重转
  if (
    rec.status === 'ready'
    && rec.parsedRevision === rec.currentRevision
    && rec.engineFingerprint === fingerprint
  ) {
    return { ok: true, source: rec };
  }

  let bytes: Buffer;
  const originalAbs = join(layout.rawSourcesDir, ...rec.sourcePath.split('/'));
  try {
    bytes = await readFile(originalAbs);
  } catch (err) {
    return { ok: false, error: failure('ioError', `读取原件失败: ${String(err)}`) };
  }
  if (sha256Hex(bytes) !== rec.currentRevision) {
    return {
      ok: false,
      error: failure('originalHashMismatch', `原件字节与修订不符（盘上文件已被外部改动）: ${rec.sourcePath}`),
    };
  }

  // 替换 parsed 前保留仍被引用的旧 parsed（原件不变，无需保留原件）
  try {
    await preserveReferencedEvidence(kbPath, layout, rec, { preserveOriginal: false });
  } catch (err) {
    return { ok: false, error: failure('ioError', `保留被引用证据失败: ${String(err)}`) };
  }

  // 运行前状态快照：被中止时还原（迟到/被中止的结果不改动运行前的
  // 失败或旧版状态）
  const prevStatus = rec.status;
  const prevErrorCode = rec.errorCode;
  const prevErrorMessage = rec.errorMessage;

  // 可中止边界：标记 converting 之前（此后的中止由 finalizeConversion 边界处理）
  throwIfAborted(signal, true);

  const nowIso = new Date().toISOString();
  // 标记 converting（串行化：以最新 manifest 为基，防并发丢更新/EPERM）
  try {
    await commitManifestUpdate(kbPath, (m) => {
      const target = m.sources?.[sourceId];
      if (!target) {
        throw new Error(`来源记录不存在: ${sourceId}`);
      }
      target.status = 'converting';
      delete target.errorCode;
      delete target.errorMessage;
      target.updatedAt = nowIso;
    });
  } catch (err) {
    return { ok: false, error: failure('ioError', `写入 manifest 失败: ${String(err)}`) };
  }
  rec.status = 'converting';
  delete rec.errorCode;
  delete rec.errorMessage;
  rec.updatedAt = nowIso;

  try {
    const failCode = await finalizeConversion(kbPath, layout, rec, bytes, engine, fingerprint, control);
    // 终态提交（串行化：以最新 manifest 为基）
    await commitManifestUpdate(kbPath, (m) => {
      const target = m.sources?.[sourceId];
      if (!target) {
        throw new Error(`来源记录不存在: ${sourceId}`);
      }
      syncRecFields(target, rec);
    });
    if (failCode === null) {
      return { ok: true, source: rec };
    }
    return { ok: false, error: failure('ioError', `转换失败（${failCode}）: ${rec.errorMessage ?? ''}`) };
  } catch (err) {
    if (err instanceof WikiSourceAbortedError) {
      // 被中止的运行不留任何痕迹：还原 converting 标记为运行前状态。
      // 还原失败不掩盖中止本身（parsedStale 语义仍由 converting 兜底）。
      try {
        await commitManifestUpdate(kbPath, (m) => {
          const target = m.sources?.[sourceId];
          if (!target) return;
          target.status = prevStatus;
          if (prevErrorCode !== undefined) {
            target.errorCode = prevErrorCode;
            target.errorMessage = prevErrorMessage;
          } else {
            delete target.errorCode;
            delete target.errorMessage;
          }
          target.updatedAt = new Date().toISOString();
        });
      } catch {
        // 保持中止错误向上传递
      }
      throw err;
    }
    return { ok: false, error: failure('ioError', `转换结果持久化失败: ${String(err)}`) };
  }
}

// ── 列表 / 预览 / 修订核对 ──────────────────────────────────────

/** 来源摘要列表（渲染端 kb.sources）；按 sourcePath 排序。 */
export async function listWikiSources(kbPath: string): Promise<WikiSourceSummary[]> {
  const read = await readWikiManifest(kbPath);
  if (!read.ok) {
    throw new WikiSourceError('manifestCorrupted', `库 manifest 不可读（${read.reason}）`);
  }
  const records = Object.values(read.manifest.sources ?? {});
  return records
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))
    .map((r) => ({
      sourceId: r.sourceId,
      sourcePath: r.sourcePath,
      ext: r.ext,
      size: r.size,
      revision: r.currentRevision,
      revisionShort: r.currentRevision.slice(0, 8),
      status: r.status,
      ...(r.errorCode !== undefined ? { errorCode: r.errorCode } : {}),
      ...(r.errorMessage !== undefined ? { errorMessage: r.errorMessage } : {}),
      parsedRevision: r.parsedRevision,
      parsedHash: r.parsedHash,
      parsedStale: r.status !== 'ready' || r.parsedRevision !== r.currentRevision || r.parsedHash === null,
      assetCount: r.assetCount,
      importedAt: r.importedAt,
      updatedAt: r.updatedAt,
    }));
}

/**
 * 读取 parsed 全文（机械全文预览）。全部从身份解析：
 *  - 当前全文：raw/parsed/<sourcePath>.md，revision = parsedRevision
 *    （转换失败时停留旧修订 —— 旧全文不标成新版）
 *  - 历史快照：revisions/<sid>/<rev>/parsed/<parsedHash>.md，isHistorical = true
 */
export async function readWikiParsed(kbPath: string, query: ReadWikiParsedQuery): Promise<WikiParsedView> {
  const layout = wikiLayout(kbPath);
  const read = await readWikiManifest(kbPath);
  if (!read.ok) {
    throw new WikiSourceError('manifestCorrupted', `库 manifest 不可读（${read.reason}）`);
  }
  const rec = read.manifest.sources?.[query.sourceId];
  if (!rec) {
    throw new WikiSourceError('sourceNotFound', `来源不存在: ${query.sourceId}`);
  }

  const wantsHistorical =
    (query.revision !== undefined && query.revision !== rec.currentRevision)
    || (query.parsedHash !== undefined && query.parsedHash !== rec.parsedHash);

  if (!wantsHistorical) {
    if (rec.parsedHash === null || rec.parsedRevision === null) {
      throw new WikiSourceError('sourceNotFound', `来源从未成功转换，无全文可读: ${rec.sourcePath}`);
    }
    let content: string;
    try {
      content = await readFile(parsedAbsPath(layout, rec.sourcePath), 'utf-8');
    } catch (err) {
      throw new WikiSourceError('sourceNotFound', `当前 parsed 全文不可读: ${String(err)}`);
    }
    return {
      sourceId: rec.sourceId,
      sourcePath: rec.sourcePath,
      revision: rec.parsedRevision,
      parsedHash: rec.parsedHash,
      isHistorical: false,
      content,
    };
  }

  const revision = query.revision ?? rec.parsedRevision ?? rec.currentRevision;
  const parsedDir = join(layout.rawRevisionsDir, rec.sourceId, revision, 'parsed');
  let hash = query.parsedHash;
  if (!hash) {
    let files: string[];
    try {
      files = (await readdir(parsedDir)).filter((f) => f.endsWith('.md')).sort();
    } catch {
      files = [];
    }
    if (files.length === 0) {
      throw new WikiSourceError('sourceNotFound', `修订无 parsed 快照: ${revision}`);
    }
    hash = files[files.length - 1]!.replace(/\.md$/, '');
  }
  let content: string;
  try {
    content = await readFile(join(parsedDir, `${hash}.md`), 'utf-8');
  } catch (err) {
    throw new WikiSourceError('sourceNotFound', `parsed 快照不可读（${revision}/${hash}）: ${String(err)}`);
  }
  return {
    sourceId: rec.sourceId,
    sourcePath: rec.sourcePath,
    revision,
    parsedHash: hash,
    isHistorical: true,
    content,
  };
}

/**
 * 来源修订清单（UI 核对修订用）：当前修订 + revisions 区历史修订。
 * parsedHashes 合并历史快照与当前 parsed（同原件不同 parsedHash 均可定位）。
 */
export async function listSourceRevisions(kbPath: string, sourceId: string): Promise<WikiSourceRevisionInfo[]> {
  const layout = wikiLayout(kbPath);
  const read = await readWikiManifest(kbPath);
  if (!read.ok) {
    throw new WikiSourceError('manifestCorrupted', `库 manifest 不可读（${read.reason}）`);
  }
  const rec = read.manifest.sources?.[sourceId];
  if (!rec) {
    throw new WikiSourceError('sourceNotFound', `来源不存在: ${sourceId}`);
  }

  const byRevision = new Map<string, WikiSourceRevisionInfo>();
  byRevision.set(rec.currentRevision, {
    revision: rec.currentRevision,
    isCurrent: true,
    originalFile: basename(rec.sourcePath),
    size: rec.size,
    parsedHashes: rec.parsedHash ? [rec.parsedHash] : [],
  });

  const sidDir = join(layout.rawRevisionsDir, sourceId);
  let revNames: string[] = [];
  try {
    revNames = (await readdir(sidDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // 无历史修订区
  }

  for (const revision of revNames) {
    const dir = join(sidDir, revision);
    let originalFile: string | undefined;
    let parsedHashes: string[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const original = entries.find((e) => e.isFile() && e.name !== 'assets.json');
      if (original) originalFile = original.name;
      parsedHashes = (await readdir(join(dir, 'parsed')))
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''));
    } catch {
      // 单个修订目录不完整不阻断整体
    }
    const prev = byRevision.get(revision);
    if (prev) {
      // 当前修订目录内的历史 parsed 快照并入当前条目
      byRevision.set(revision, { ...prev, parsedHashes: [...new Set([...prev.parsedHashes, ...parsedHashes])] });
    } else {
      byRevision.set(revision, {
        revision,
        isCurrent: revision === rec.currentRevision,
        ...(originalFile !== undefined ? { originalFile } : {}),
        parsedHashes,
      });
    }
  }

  return [...byRevision.values()].sort((a, b) =>
    a.isCurrent === b.isCurrent ? a.revision.localeCompare(b.revision) : a.isCurrent ? -1 : 1,
  );
}

/**
 * 从身份解析原件绝对路径（预览/导出用，不接受任意路径）。
 * 未知来源或盘上文件缺失返回 null。
 */
export async function resolveWikiOriginalPath(kbPath: string, query: ResolveOriginalQuery): Promise<string | null> {
  const layout = wikiLayout(kbPath);
  const read = await readWikiManifest(kbPath);
  if (!read.ok) return null;
  const rec = read.manifest.sources?.[query.sourceId];
  if (!rec) return null;

  if (!query.revision || query.revision === rec.currentRevision) {
    return fileOrNull(join(layout.rawSourcesDir, ...rec.sourcePath.split('/')));
  }
  const revDir = join(layout.rawRevisionsDir, rec.sourceId, query.revision);
  try {
    const entries = await readdir(revDir, { withFileTypes: true });
    const original = entries.find((e) => e.isFile() && e.name !== 'assets.json');
    return original ? join(revDir, original.name) : null;
  } catch {
    return null;
  }
}

async function fileOrNull(abs: string): Promise<string | null> {
  try {
    const s = await stat(abs);
    return s.isFile() ? abs : null;
  } catch {
    return null;
  }
}

// ── 能力清单 ────────────────────────────────────────────────────

/**
 * UI/工具可用的导入扩展名（小写含点）：引擎支持格式 ∪ 文本直通格式。
 * 不宣称引擎未支持的格式（如 .html）。
 */
export function listImportExtensions(engineId?: string): string[] {
  const engine = getConvertEngine(engineId ?? 'anydoc');
  return [...new Set([...engine.supportedExtensions, ...TEXT_IMPORT_EXTENSIONS])].sort();
}
