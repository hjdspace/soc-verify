/**
 * 来源撤回与库停用/删除范围管理（issue 20，spec §1/§6/§10）。
 *
 * 三条核心行为：
 *
 * 1. **来源撤回（withdrawSource）** — 用户撤回来源时：
 *    - 计算引用影响（哪些已发布页引用了该来源）
 *    - 来源标为 withdrawn（不删除原件、不级联删知识页）
 *    - 受影响页标为待复核（页内容不变，但 UI 显示来源已撤回）
 *    - 被引用的旧修订原件仍保留在 revisions 区
 *    - 同来源其他贡献、其他来源同名页面不被模糊匹配误删
 *
 * 2. **删除库范围预览（previewDeleteKb）** — 停用或删除整库时：
 *    - 列出受管资产范围（wiki 页面数、raw 来源数、page-history、staging）
 *    - 检测目录是否含未知文件（拒绝递归删除）
 *    - 历史修订/审批资料不是缓存，准确显示其将被删除
 *
 * 3. **安全删除（deleteKb）** — 确认范围后：
 *    - 等待活动任务安全退出
 *    - 读写资源释放后才删除受管内容
 *    - 含未知文件、离线或权限失败时不递归删除根，不报告成功
 *
 * 关键不变量：
 *  - 删除页是显式操作，空 FILE 不是删除
 *  - 卸载/注销保持文件不变
 *  - 来源撤回不等于删除来源文件
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §1、§6、§10
 * @see .scratch/llm-wiki/issues/20-source-library-disposal.md
 */

import { join } from 'node:path';
import { readdir, rm, readFile } from 'node:fs/promises';
import { readWikiManifest, writeWikiManifest, wikiLayout, withManifestLock } from './wiki-layout';
import { collectReferencedRevisions } from './source-refs';
import type { Dirent } from 'node:fs';
import type { WikiSourceRecord } from '@shared/kb-types';

// ── 类型 ────────────────────────────────────────────────────────

/** 来源撤回的引用影响 */
export type WithdrawImpact = {
  /** sourceId */
  sourceId: string;
  /** 来源相对路径 */
  sourcePath: string;
  /** 撤回前的修订 */
  withdrawnRevision: string;
  /** 引用此来源的已发布页 pageId 列表（受影响，需复核） */
  affectedPages: string[];
  /** 被引用的旧修订集合（revisions 区保留的证据） */
  retainedRevisions: string[];
};

/** 来源撤回结果 */
export type WithdrawResult =
  | { ok: true; impact: WithdrawImpact }
  | { ok: false; error: { code: 'sourceNotFound' | 'alreadyWithdrawn' | 'manifestCorrupted' | 'ioError'; message: string } };

/** 删除库范围预览结果 */
export type DeletePreviewResult = {
  /** 是否可安全删除（无未知文件） */
  canDelete: boolean;
  /** wiki 页面数 */
  wikiPageCount: number;
  /** raw 来源数（manifest 中已注册） */
  sourceCount: number;
  /** 是否有 page-history */
  hasPageHistory: boolean;
  /** 是否有 staging 提案 */
  hasStaging: boolean;
  /** 是否有 transactions 事务 */
  hasTransactions: boolean;
  /** 是否有 vectors 派生索引 */
  hasVectors: boolean;
  /** 是否有 vision 中间产物 */
  hasVision: boolean;
  /** 未知文件列表（canDelete=false 时有值） */
  unknownFiles: string[];
};

// ── 来源撤回 ────────────────────────────────────────────────────

/**
 * 撤回来源：标 withdrawn、计算受影响页面、保留旧证据。
 *
 * 不删除原件、不级联删知识页。
 * 旧页面仍可读但需复核；受影响页的来源引用不变。
 */
export async function withdrawSource(kbPath: string, sourceId: string): Promise<WithdrawResult> {
  return withManifestLock(kbPath, async () => {
    const read = await readWikiManifest(kbPath);
    if (!read.ok) {
      return { ok: false, error: { code: 'manifestCorrupted', message: `库 manifest 不可读（${read.reason}）` } };
    }
    const manifest = read.manifest;
    const rec = manifest.sources?.[sourceId];
    if (!rec) {
      return { ok: false, error: { code: 'sourceNotFound', message: `来源不存在: ${sourceId}` } };
    }
    if (rec.status === 'withdrawn') {
      return { ok: false, error: { code: 'alreadyWithdrawn', message: `来源已撤回: ${rec.sourcePath}` } };
    }

    // 计算引用影响：哪些已发布页引用了此来源
    const refIndex = await collectReferencedRevisions(kbPath);
    const referencedRevs = refIndex.get(sourceId) ?? new Set<string>();

    // 受影响页面 = 引用此 sourceId 的 wiki 页
    const affectedPages = await findPagesReferencingSource(kbPath, sourceId);

    // 更新 manifest：标 withdrawn
    const updatedRec: WikiSourceRecord = {
      ...rec,
      status: 'withdrawn',
      updatedAt: new Date().toISOString(),
    };
    const updatedManifest = {
      ...manifest,
      sources: {
        ...(manifest.sources ?? {}),
        [sourceId]: updatedRec,
      },
      updatedAt: new Date().toISOString(),
    };
    await writeWikiManifest(kbPath, updatedManifest);

    const impact: WithdrawImpact = {
      sourceId,
      sourcePath: rec.sourcePath,
      withdrawnRevision: rec.currentRevision,
      affectedPages,
      retainedRevisions: [...referencedRevs],
    };

    return { ok: true, impact };
  });
}

/**
 * 找出引用指定 sourceId 的已发布 wiki 页面 pageId 列表。
 * 复用 source-refs 的 frontmatter 提取逻辑。
 */
async function findPagesReferencingSource(kbPath: string, sourceId: string): Promise<string[]> {
  const { extractSourceRefsFromMarkdown } = await import('./source-refs');
  const layout = wikiLayout(kbPath);
  const result: string[] = [];

  const files = await listMarkdownFiles(layout.wikiDir);
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8');
      const refs = extractSourceRefsFromMarkdown(content);
      if (refs.some((r) => r.sourceId === sourceId)) {
        // 从绝对路径推导 pageId：wiki/<typeDir>/<name>.md → <typeDir>/<name>
        const rel = file.replace(/\\/g, '/').replace(layout.wikiDir.replace(/\\/g, '/') + '/', '').replace(/\.md$/, '');
        result.push(rel);
      }
    } catch {
      // 单页不可读不阻断
    }
  }

  return result;
}

/** 递归列出目录下所有 .md 文件 */
async function listMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listMarkdownFiles(full)));
    } else if (entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

// ── 删除库范围预览 ────────────────────────────────────────────

/**
 * 预览删除库时受影响的范围。
 *
 * 扫描库目录，识别受管资产与未知文件。
 * 受管结构：schema.md、purpose.md、raw/、wiki/、.kb/
 * 未知文件 = 不属于上述受管结构的文件/目录。
 */
export async function previewDeleteKb(kbPath: string): Promise<DeletePreviewResult> {
  const layout = wikiLayout(kbPath);

  // 受管根级文件/目录名
  const managedRootNames = new Set([
    'schema.md',
    'purpose.md',
    'raw',
    'wiki',
    '.kb',
  ]);

  // 检测根目录未知文件
  const unknownFiles: string[] = [];
  let rootEntries: Dirent[];
  try {
    rootEntries = await readdir(kbPath, { withFileTypes: true });
  } catch {
    // 目录不可访问 = 无法删除
    return {
      canDelete: false,
      wikiPageCount: 0,
      sourceCount: 0,
      hasPageHistory: false,
      hasStaging: false,
      hasTransactions: false,
      hasVectors: false,
      hasVision: false,
      unknownFiles: ['<目录不可访问>'],
    };
  }

  for (const entry of rootEntries) {
    if (!managedRootNames.has(entry.name)) {
      unknownFiles.push(entry.name);
    }
  }

  // 统计 wiki 页面数
  const wikiPageCount = await countMarkdownFiles(layout.wikiDir);

  // 统计来源数
  let sourceCount = 0;
  const manifestRead = await readWikiManifest(kbPath);
  if (manifestRead.ok) {
    sourceCount = Object.keys(manifestRead.manifest.sources ?? {}).length;
  }

  // 检查 .kb 子目录
  const hasPageHistory = await hasNonEmptyDir(layout.pageHistoryDir);
  const hasStaging = await hasNonEmptyDir(layout.stagingDir);
  const hasTransactions = await hasNonEmptyDir(layout.transactionsDir);
  const hasVectors = await hasNonEmptyDir(layout.vectorsDir);
  const hasVision = await hasNonEmptyDir(layout.visionDir);

  return {
    canDelete: unknownFiles.length === 0,
    wikiPageCount,
    sourceCount,
    hasPageHistory,
    hasStaging,
    hasTransactions,
    hasVectors,
    hasVision,
    unknownFiles,
  };
}

async function countMarkdownFiles(dir: string): Promise<number> {
  let count = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += await countMarkdownFiles(full);
    } else if (entry.name.endsWith('.md') && entry.name !== 'index.md' && entry.name !== 'overview.md' && entry.name !== 'log.md') {
      count++;
    }
  }
  return count;
}

async function hasNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.length > 0;
  } catch {
    return false;
  }
}

// ── 安全删除 ────────────────────────────────────────────────────

/**
 * 安全删除库目录内容。
 *
 * 前置条件：
 *  - 目录不含未知文件（previewDeleteKb.canDelete === true）
 *  - 活动任务已安全退出（调用方负责 detach 队列）
 *
 * 失败语义：
 *  - 含未知文件 → 拒绝递归删除，不报告成功
 *  - 目录不可访问 → 拒绝
 */
export async function deleteKbContents(kbPath: string): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  const preview = await previewDeleteKb(kbPath);
  if (!preview.canDelete) {
    return {
      ok: false,
      error: {
        code: 'unknownFilesPresent',
        message: `库目录包含未知文件，拒绝递归删除: ${preview.unknownFiles.join(', ')}`,
      },
    };
  }

  // 删除整个库目录
  try {
    await rm(kbPath, { recursive: true, force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { code: 'ioError', message: `删除库目录失败: ${msg}` } };
  }

  return { ok: true };
}
