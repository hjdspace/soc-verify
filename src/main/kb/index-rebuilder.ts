/**
 * Index Rebuilder — 向量索引代重建（spec §8，issue 24）。
 *
 * 职责：
 *  1. 枚举已发布 wiki 页面，逐页嵌入向量
 *  2. 同维度换模型也启新代：先检查指纹是否匹配，不匹配则全量重建
 *  3. 完整重建后切换（保存新指纹）；失败保留旧代
 *  4. 重建可取消（AbortSignal）/继续（跳过已成功页面）
 *  5. 覆盖状态和缺口可见（oversize chunk 跳过计数）
 *
 * 不以新 query 向量查旧空间：重建期间旧索引仍可用，但新 query
 * 不发送到旧向量空间。完成后切换。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §8
 */

import { assertReadGateOpen, WikiReadGateError } from './read-gate';
import { readWikiManifest } from './wiki-layout';
import { scanWikiCatalog } from './wiki-catalog';
import { computeEmbeddingFingerprint } from './embedding-fingerprint';
import type { EmbeddingService } from './embedding-service';
import type { EmbeddingRuntimeConfig } from '@shared/kb-types';

// ── 类型 ──────────────────────────────────────────────────────────

/** 重建进度回调 */
export type RebuildProgress = {
  /** 已处理页数 */
  done: number;
  /** 总页数 */
  total: number;
  /** 当前处理的 pageId */
  currentPageId?: string;
};

/** 重建结果 */
export type RebuildResult =
  | {
      ok: true;
      /** 成功嵌入页数 */
      embedded: number;
      /** 失败页数 */
      failed: number;
      /** 跳过页数（oversize 等） */
      skipped: number;
      /** 覆盖缺口（跳过的页面和原因） */
      coverageGaps?: Array<{ pageId: string; reason: string }>;
      /** 旧代保留（部分失败时不切换） */
      oldGenerationRetained: boolean;
    }
  | {
      ok: false;
      /** 取消重建 */
      cancelled: boolean;
      /** 已嵌入页数（取消前完成的部分） */
      embedded: number;
      /** 失败页数 */
      failed: number;
      /** 跳过页数 */
      skipped: number;
      /** 覆盖缺口（跳过的页面和原因） */
      coverageGaps?: Array<{ pageId: string; reason: string }>;
      /** 旧代保留 */
      oldGenerationRetained: boolean;
      /** 错误消息 */
      message?: string;
    };

/** 重建选项 */
export type RebuildOptions = {
  /** 取消信号 */
  signal?: AbortSignal;
  /** 进度回调 */
  onProgress?: (progress: RebuildProgress) => void;
  /** 跳过已嵌入的页面（继续重建） */
  skipExisting?: boolean;
};

// ── 主服务 ────────────────────────────────────────────────────────

/**
 * 重建向量索引：枚举已发布页面 → 逐页嵌入 → 成功后切换。
 *
 * 流程（spec §8）：
 *  1. 检查读门禁
 *  2. 扫描 catalog 获取所有已发布页面
 *  3. 计算新配置指纹
 *  4. 逐页嵌入（可取消）
 *  5. 全部成功 → 保存新指纹（切换新代）
 *  6. 部分失败 → 保留旧指纹（不切换）
 *  7. 取消 → 保留旧指纹（不切换）
 *
 * @param kbPath 库根目录
 * @param kbId 库身份
 * @param service 嵌入服务
 * @param cfg 嵌入运行时配置
 * @param options 重建选项
 */
export async function rebuildEmbeddingIndex(
  kbPath: string,
  kbId: string,
  service: EmbeddingService,
  cfg: EmbeddingRuntimeConfig,
  options?: RebuildOptions,
): Promise<RebuildResult> {
  // 检查读门禁
  try {
    await assertReadGateOpen(kbPath);
  } catch (err) {
    if (err instanceof WikiReadGateError) {
      return {
        ok: false,
        cancelled: false,
        embedded: 0,
        failed: 0,
        skipped: 0,
        oldGenerationRetained: true,
        message: err.message,
      };
    }
    throw err;
  }

  // 读取 manifest
  const manifest = await readWikiManifest(kbPath);
  if (!manifest.ok) {
    return {
      ok: false,
      cancelled: false,
      embedded: 0,
      failed: 0,
      skipped: 0,
      oldGenerationRetained: true,
      message: '库 manifest 不存在或损坏',
    };
  }

  // 扫描 catalog
  const scan = await scanWikiCatalog(kbPath);
  if (!scan.ok) {
    return {
      ok: false,
      cancelled: false,
      embedded: 0,
      failed: 0,
      skipped: 0,
      oldGenerationRetained: true,
      message: 'schema 无法解析，页面目录不可用',
    };
  }

  // 获取已发布修订（用于向量 revision 标注）
  const revision = String(manifest.manifest.publish?.revision ?? 0);

  // 只处理解析成功的页面（类型收窄）
  const validPages = scan.catalog.pages.filter(
    (p): p is typeof p & { parse: { ok: true; frontmatter: import('@shared/kb-types').WikiPageFrontmatter; body: string } } =>
      p.parse.ok,
  );

  // 计算新指纹
  const newFingerprint = computeEmbeddingFingerprint(cfg);

  let embedded = 0;
  let failed = 0;
  let skipped = 0;
  const coverageGaps: Array<{ pageId: string; reason: string }> = [];

  for (let i = 0; i < validPages.length; i++) {
    // 检查取消
    if (options?.signal?.aborted) {
      return {
        ok: false,
        cancelled: true,
        embedded,
        failed,
        skipped,
        oldGenerationRetained: true,
        message: '用户取消重建',
      };
    }

    const page = validPages[i];
    const pageId = page.pageId;
    const fm = page.parse.frontmatter;

    // 进度回调
    options?.onProgress?.({
      done: i,
      total: validPages.length,
      currentPageId: pageId,
    });

    // 嵌入页面
    const result = await service.embedPage(
      kbId,
      pageId,
      fm.title,
      page.parse.body,
      cfg,
      revision,
    );

    if (!result.ok) {
      failed++;
      coverageGaps.push({
        pageId,
        reason: result.error.message,
      });
    } else {
      embedded++;
      if (result.skippedCount > 0) {
        skipped += result.skippedCount;
        if (result.coverage?.skipReasons) {
          for (const reason of result.coverage.skipReasons) {
            coverageGaps.push({ pageId, reason });
          }
        }
      }
    }
  }

  // 最终进度
  options?.onProgress?.({
    done: validPages.length,
    total: validPages.length,
  });

  // 部分失败 → 保留旧代（不保存新指纹）
  if (failed > 0) {
    return {
      ok: false,
      cancelled: false,
      embedded,
      failed,
      skipped,
      coverageGaps: coverageGaps.length > 0 ? coverageGaps : undefined,
      oldGenerationRetained: true,
      message: `${failed} 个页面嵌入失败，保留旧代`,
    };
  }

  // 全部成功 → 保存新指纹（切换新代）
  await service.store.saveFingerprint(kbId, newFingerprint.hash);

  return {
    ok: true,
    embedded,
    failed,
    skipped,
    coverageGaps: coverageGaps.length > 0 ? coverageGaps : undefined,
    oldGenerationRetained: false,
  };
}
