/**
 * Wiki Read — 只读证据读取服务（spec §2/§8，issue 15）。
 *
 * Agent（kb_read Host Tool）按 kind/id/revision 读取三类证据，全部从
 * 身份解析路径，不接受任意 absolutePath 输入：
 *
 *  - kind=wiki：已发布知识页（pageId → 页面目录 → realpath 围栏）。
 *    聚合页 index/overview/log 不是证据页，明确拒绝。
 *  - kind=parsed：来源机械全文。当前全文按 manifest parsedRevision/
 *    parsedHash 定位；历史证据按 SourceRef（sourceRevision + parsedHash）
 *    定位 raw/revisions/<sid>/<rev>/parsed/<hash>.md。
 *  - kind=asset：原图字节。sourceId/revision/assetId 都是内容 hash，
 *    必须在 pdf-assets.json 清单中命中，字节文件真实存在。
 *
 * 分页（超大内容，spec A20「kb_read 分页可重组原文」）：
 *  - 页 = 整行集合（startLine..endLine），内容为原文精确切片；
 *  - 各页按 next 顺序以 '\n' 拼接 = 全文，零丢失零重复；
 *  - 超过字符预算的单行独占一页，如实返回实际长度（不截断不编造）；
 *  - startLine 超过总行数 → outOfRange 结构化错误，不编造空页。
 *
 * 读取门禁：存在未恢复发布事务时拒绝服务（issue 06 契约复用）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §2、§8
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertReadGateOpen } from './read-gate';
import { readWikiManifest, wikiLayout } from './wiki-layout';
import type { WikiKbManifest } from './wiki-layout';
import { readWikiPage } from './wiki-catalog';
import { readPdfAssetManifest, PDF_ASSET_EXTENSIONS } from './pdf-asset-store';
import { sha256Hex } from './hash';
import type {
  WikiReadAsset,
  WikiReadErrorCode,
  WikiReadOutcome,
  WikiReadParsedPage,
  WikiReadQuery,
  WikiReadTextPageBase,
  WikiReadWikiPage,
} from '@shared/kb-types';

// ── 分页常量 ────────────────────────────────────────────────────

const DEFAULT_MAX_CHARS = 20_000;
const HARD_MAX_CHARS = 50_000;

/** 资产扩展名 → MIME（本期提图仅 png；扩展时在此登记） */
const MIME_BY_EXT: Record<string, string> = { png: 'image/png' };

const HASH_RE = /^[0-9a-f]{64}$/;

function err(code: WikiReadErrorCode, message: string): WikiReadOutcome {
  return { ok: false, error: { code, message } };
}

function countLines(content: string): number {
  return content.split('\n').length;
}

// ── 分页 ────────────────────────────────────────────────────────

/**
 * 把全文按行分页。页内容 = 原文切片：各页以 '\n' 拼接精确还原全文。
 * 单行超过预算时独占一页（不截半，避免无状态调用无法推进行内偏移）。
 */
function paginate(
  content: string,
  startLine: number,
  maxChars: number,
): { startLine: number; endLine: number; next: number | null; content: string } {
  const lines = content.split('\n');
  const totalLines = lines.length;
  const idx = startLine - 1;

  let end = idx;
  let length = lines[idx]!.length;
  while (end + 1 < totalLines && length + 1 + lines[end + 1]!.length <= maxChars) {
    end += 1;
    length += 1 + lines[end]!.length;
  }

  const pageContent = lines.slice(idx, end + 1).join('\n');
  return {
    startLine,
    endLine: end + 1,
    next: end + 1 < totalLines ? end + 2 : null,
    content: pageContent,
  };
}

// ── 分页公共段 ──────────────────────────────────────────────────

type PageFields = Pick<
  WikiReadTextPageBase,
  'totalLines' | 'totalChars' | 'startLine' | 'endLine' | 'next' | 'content'
>;

/** wiki/parsed 共用的分页公共段：越界校验 + 整行切片 */
function paginatePage(
  content: string,
  totalLines: number,
  query: WikiReadQuery,
): { ok: true; fields: PageFields } | { ok: false; error: { code: WikiReadErrorCode; message: string } } {
  const startLine = query.startLine ?? 1;
  const maxChars = Math.min(query.maxChars ?? DEFAULT_MAX_CHARS, HARD_MAX_CHARS);
  if (startLine > totalLines) {
    return {
      ok: false,
      error: { code: 'outOfRange', message: `startLine ${startLine} 超过总行数 ${totalLines}（不编造空页）` },
    };
  }
  const part = paginate(content, startLine, maxChars);
  return {
    ok: true,
    fields: {
      totalLines,
      totalChars: content.length,
      startLine: part.startLine,
      endLine: part.endLine,
      next: part.next,
      content: part.content,
    },
  };
}

// ── kind=wiki ───────────────────────────────────────────────────

async function readWikiKind(kbPath: string, kbId: string, query: WikiReadQuery): Promise<WikiReadOutcome> {
  if (query.revision !== undefined || query.parsedHash !== undefined || query.assetId !== undefined) {
    return err('invalidInput', 'kind=wiki 只按 pageId 读取当前已发布页；revision/parsedHash/assetId 不适用（页面历史读取不在本期范围）');
  }

  // 复用 readWikiPage：目录校验 + realpath 围栏 + 解析，不复制路径逻辑
  const read = await readWikiPage(kbPath, query.id);
  if (!read.ok) {
    if (read.reason === 'catalogFailed') return err('catalogFailed', 'schema.md 不可读或路由表无法解析，无法读取页面');
    if (read.reason === 'outsideRoot') return err('outsideRoot', 'pageId 解析路径逃逸出库根，已拒绝');
    if (read.reason === 'readFailed') return err('ioError', `页面文件不可读: ${query.id}`);
    return err('unknownPage', `pageId 不在已发布页目录中: ${query.id}`);
  }
  if (read.page.kind === 'aggregate') {
    return err('invalidTarget', `聚合页/内部记录不是证据页，不可通过 kb_read 读取: ${query.id}`);
  }

  const content = read.page.content;
  const totalLines = countLines(content);
  const parsed = read.page.parse.ok ? read.page.parse : null;

  const sliced = paginatePage(content, totalLines, query);
  if (!sliced.ok) return err(sliced.error.code, sliced.error.message);

  const result: WikiReadWikiPage = {
    kind: 'wiki',
    id: query.id,
    kbId,
    relativePath: read.page.relPath,
    absolutePath: join(wikiLayout(kbPath).kbPath, read.page.relPath),
    hash: sha256Hex(new TextEncoder().encode(content)),
    ...sliced.fields,
    ...(parsed ? { title: parsed.frontmatter.title, pageType: parsed.frontmatter.type } : {}),
  };
  return { ok: true, page: result };
}

// ── kind=parsed ─────────────────────────────────────────────────

function readParsedKind(kbPath: string, manifest: WikiKbManifest, kbId: string, query: WikiReadQuery): Promise<WikiReadOutcome> {
  return (async () => {
    if (query.assetId !== undefined) {
      return err('invalidInput', 'kind=parsed 不接受 assetId');
    }

    const layout = wikiLayout(kbPath);
    const rec = manifest.sources?.[query.id];
    if (!rec) {
      return err('sourceNotFound', `来源不存在: ${query.id}`);
    }

    // 定位：当前全文 vs 历史快照（revision/parsedHash 决定，不猜）
    const wantsHistorical =
      (query.revision !== undefined && query.revision !== rec.currentRevision)
      || (query.parsedHash !== undefined && query.parsedHash !== rec.parsedHash);

    let revision: string;
    let hash: string;
    let relPath: string;
    let isHistorical: boolean;
    let content: string;

    if (!wantsHistorical) {
      if (rec.parsedHash === null || rec.parsedRevision === null) {
        return err('noParsed', `来源从未成功转换，无全文可读: ${rec.sourcePath}（当前状态 ${rec.status}）`);
      }
      revision = rec.parsedRevision;
      hash = rec.parsedHash;
      relPath = `raw/parsed/${rec.sourcePath}.md`;
      isHistorical = false;
      try {
        content = await readFile(join(layout.rawParsedDir, `${rec.sourcePath}.md`), 'utf-8');
      } catch (e) {
        return err('ioError', `当前 parsed 全文不可读: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      revision = query.revision ?? rec.currentRevision;
      if (!HASH_RE.test(revision)) {
        return err('invalidInput', `revision 必须是 64 位十六进制内容 hash: ${revision}`);
      }
      const parsedDir = join(layout.rawRevisionsDir, rec.sourceId, revision, 'parsed');
      if (query.parsedHash !== undefined) {
        hash = query.parsedHash;
      } else {
        // 未指定 hash：快照唯一时定位，多快照必须显式给 parsedHash（不猜）
        let files: string[];
        try {
          files = (await readdir(parsedDir)).filter((f) => f.endsWith('.md')).sort();
        } catch {
          files = [];
        }
        if (files.length !== 1) {
          return err('snapshotNotFound', `修订 ${revision.slice(0, 12)}… 有 ${files.length} 个 parsed 快照，需指定 parsedHash 定位`);
        }
        hash = files[0]!.replace(/\.md$/, '');
      }
      relPath = `raw/revisions/${rec.sourceId}/${revision}/parsed/${hash}.md`;
      isHistorical = true;
      try {
        content = await readFile(join(parsedDir, `${hash}.md`), 'utf-8');
      } catch {
        return err('snapshotNotFound', `修订 ${revision.slice(0, 12)}… 无 parsed 快照 ${hash.slice(0, 12)}…（引用已失效或 hash 不正确）`);
      }
    }

    const sliced = paginatePage(content, countLines(content), query);
    if (!sliced.ok) return err(sliced.error.code, sliced.error.message);

    const result: WikiReadParsedPage = {
      kind: 'parsed',
      id: query.id,
      kbId,
      relativePath: relPath,
      absolutePath: join(layout.kbPath, relPath),
      hash,
      ...sliced.fields,
      revision,
      isHistorical,
    };
    return { ok: true, page: result };
  })();
}

// ── kind=asset ──────────────────────────────────────────────────

async function readAssetKind(kbPath: string, manifest: WikiKbManifest, kbId: string, query: WikiReadQuery): Promise<WikiReadOutcome> {
  if (query.parsedHash !== undefined) {
    return err('invalidInput', 'kind=asset 不接受 parsedHash');
  }
  if (query.assetId === undefined || query.assetId.trim().length === 0) {
    return err('invalidInput', 'kind=asset 必须提供 assetId（图像字节 SHA256）');
  }
  if (!HASH_RE.test(query.id)) {
    return err('sourceNotFound', `sourceId 必须是 64 位十六进制内容 hash: ${query.id}`);
  }
  if (!HASH_RE.test(query.assetId)) {
    return err('invalidInput', `assetId 必须是 64 位十六进制内容 hash: ${query.assetId}`);
  }

  const rec = manifest.sources?.[query.id];
  if (!rec) {
    return err('sourceNotFound', `来源不存在: ${query.id}`);
  }
  // revision 缺省 = 当前修订
  const revision = query.revision ?? rec.currentRevision;
  if (!HASH_RE.test(revision)) {
    return err('invalidInput', `revision 必须是 64 位十六进制内容 hash: ${revision}`);
  }

  const assetManifest = await readPdfAssetManifest(kbPath, query.id, revision);
  const record = assetManifest?.assets.find((a) => a.assetId === query.assetId);
  if (!record) {
    return err('assetNotFound', `资产不存在于修订 ${revision.slice(0, 12)}… 的清单中: ${query.assetId.slice(0, 12)}…`);
  }

  const ext = record.ext;
  if (!(PDF_ASSET_EXTENSIONS as readonly string[]).includes(ext) || !MIME_BY_EXT[ext]) {
    return err('assetNotFound', `资产扩展名 ${ext} 不是可读取的图像（支持: ${PDF_ASSET_EXTENSIONS.join(', ')}）`);
  }

  const layout = wikiLayout(kbPath);
  const relPath = `raw/assets/${query.id}/${revision}/${query.assetId}.${ext}`;
  let bytes: Buffer;
  try {
    bytes = await readFile(join(layout.rawAssetsDir, query.id, revision, `${query.assetId}.${ext}`));
  } catch {
    return err('assetNotFound', `资产字节文件缺失: ${relPath}`);
  }

  const result: WikiReadAsset = {
    kind: 'asset',
    id: query.id,
    kbId,
    assetId: query.assetId,
    hash: query.assetId,
    revision,
    relativePath: relPath,
    absolutePath: join(layout.kbPath, relPath),
    mimeType: MIME_BY_EXT[ext]!,
    ext,
    sizeBytes: bytes.length,
    dataBase64: bytes.toString('base64'),
    page: record.page ?? null,
    method: record.method,
  };
  return { ok: true, page: result };
}

// ── 入口 ────────────────────────────────────────────────────────

/**
 * 只读证据读取入口（kb_read Host Tool 的服务实现）。
 * 门禁（未恢复事务）与 manifest 在此统一校验；调用方负责确认挂载与布局。
 */
export async function readWikiEvidence(kbPath: string, query: WikiReadQuery): Promise<WikiReadOutcome> {
  if (query.kind !== 'wiki' && query.kind !== 'parsed' && query.kind !== 'asset') {
    return err('invalidKind', `kind 必须是 wiki/parsed/asset: ${String(query.kind)}`);
  }
  if (typeof query.id !== 'string' || query.id.trim().length === 0) {
    return err('emptyId', 'id 为必填（wiki = pageId，parsed/asset = sourceId）');
  }
  if (query.startLine !== undefined) {
    const s = query.startLine;
    if (!Number.isInteger(s) || s < 1) {
      return err('invalidInput', `startLine 必须是 ≥1 的整数: ${String(query.startLine)}`);
    }
  }
  if (query.maxChars !== undefined) {
    const m = query.maxChars;
    if (!Number.isInteger(m) || m < 1) {
      return err('invalidInput', `maxChars 必须是 ≥1 的整数: ${String(query.maxChars)}`);
    }
  }

  try {
    await assertReadGateOpen(kbPath);
  } catch {
    return err('readGateBlocked', '知识库存在未恢复的发布事务，读取已暂停；请先完成恢复（重新挂载知识库）');
  }

  const manifestRead = await readWikiManifest(kbPath);
  if (!manifestRead.ok) {
    return err('manifestCorrupted', `库 manifest 不可读（${manifestRead.reason}）`);
  }
  const kbId = manifestRead.manifest.kbId;

  if (query.kind === 'wiki') return readWikiKind(kbPath, kbId, query);
  if (query.kind === 'parsed') return readParsedKind(kbPath, manifestRead.manifest, kbId, query);
  return readAssetKind(kbPath, manifestRead.manifest, kbId, query);
}
