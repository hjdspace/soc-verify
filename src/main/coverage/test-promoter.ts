/**
 * Test Promoter（ADR 0009 决策 10 / Issue #10 Slice 8）。
 *
 * Coverage Closure 结束后的测试代码审阅与提升流程。闭环内 AI 生成的测试代码
 * 留在 Closure Workspace，闭环结束后由用户通过 Test Promotion 决定哪些测试
 * 提升到正式 testbench/ 目录。
 *
 * 职责：
 *   - 扫描 Closure Workspace 收集所有生成的测试文件，构建审阅队列
 *   - 复用 Diff Review 域的 Hunk/Review Queue 概念（每个文件为一个审阅单元）
 *   - 将用户接受的测试从临时目录复制到正式目录，拒绝的丢弃
 *   - 生成闭环结果摘要（每个 Gap 状态 / Delta 总量 / 提升计数）
 *   - 清理 Closure Workspace 临时目录
 *
 * 持久化布局（追加到 Closure Workspace）：
 *   <closureId>/
 *   ├── <gapId>/round_N/test_xxx.sv     # AI 生成的测试文件
 *   └── promotion.json                   # Test Promotion 决策记录
 */

import { readFile, writeFile, copyFile, mkdir, rm, readdir, unlink, rmdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type {
  PromotionQueueItem,
  ClosureSummary,
  ClosureSummaryGap,
  PromotionResult,
} from '@shared/types';
import type { ClosureManager } from './closure-manager';

/** 正式 testbench 目录名（项目根下） */
const DEFAULT_TESTBENCH_DIR = 'testbench';
/** Test Promotion 决策记录文件名 */
const PROMOTION_DATA_FILE = 'promotion.json';

/** Test Promotion 决策记录 */
type PromotionRecord = {
  closureId: string;
  /** 已接受（已提升）的 queue item id 列表 */
  accepted: string[];
  /** 已拒绝（已丢弃）的 queue item id 列表 */
  rejected: string[];
  promotedAt: number;
};

export interface TestPromoterOptions {
  projectRoot: string;
  closureManager: ClosureManager;
}

/**
 * 管理 Closure Workspace 中测试改动的审阅队列与提升逻辑。
 * 复用 Diff Review 域的接受/拒绝语义，但不直接操作 Diff Review store——
 * 数据结构对齐 Hunk/Review Queue 概念，UI 层负责渲染审阅界面。
 */
export class TestPromoter {
  private projectRoot: string;
  private closureManager: ClosureManager;

  constructor(opts: TestPromoterOptions) {
    this.projectRoot = opts.projectRoot;
    this.closureManager = opts.closureManager;
  }

  /**
   * 扫描 Closure Workspace，收集所有生成的测试文件，构建审阅队列。
   * 遍历每个 gap 的每个迭代轮次，从 generatedTests 字段获取文件名，
   * 并验证文件在磁盘上存在。
   */
  async getPromotionQueue(closureId: string): Promise<PromotionQueueItem[]> {
    const session = await this.closureManager.getClosure(closureId);
    if (!session) {
      throw new Error(`Closure ${closureId} not found`);
    }

    const workspaceDir = this.closureManager.getWorkspaceDir(closureId);
    const targetBase = this.defaultTargetDir();
    const record = await this.loadPromotionRecord(closureId);
    const acceptedSet = new Set(record?.accepted ?? []);
    const rejectedSet = new Set(record?.rejected ?? []);

    const items: PromotionQueueItem[] = [];
    for (const gap of session.gaps) {
      for (const iter of gap.iterations) {
        for (const fileName of iter.generatedTests) {
          const sourcePath = join(workspaceDir, gap.id, `round_${iter.round}`, fileName);
          // 文件不存在则跳过（可能是失败的轮次）
          if (!existsSync(sourcePath)) continue;
          const id = this.makeItemId(gap.id, iter.round, fileName);
          const status: PromotionQueueItem['status'] = acceptedSet.has(id)
            ? 'accepted'
            : rejectedSet.has(id)
              ? 'rejected'
              : 'pending';
          items.push({
            id,
            closureId,
            gapId: gap.id,
            round: iter.round,
            sourcePath,
            relativePath: fileName,
            targetPath: join(targetBase, fileName),
            fileName,
            status,
          });
        }
      }
    }
    return items;
  }

  /**
   * 执行 Test Promotion 决策：将接受的测试从 Closure Workspace 复制到正式
   * testbench 目录，拒绝的丢弃（不复制）。决策记录持久化到 promotion.json。
   *
   * @param closureId Closure Session ID
   * @param accepted 接受的 queue item id 列表
   * @param rejected 拒绝的 queue item id 列表
   * @param targetDir 可选目标目录（默认 <projectRoot>/testbench）
   * @returns 复制/丢弃计数
   */
  async promoteTests(
    closureId: string,
    accepted: string[],
    rejected: string[],
    targetDir?: string,
  ): Promise<PromotionResult> {
    const session = await this.closureManager.getClosure(closureId);
    if (!session) {
      throw new Error(`Closure ${closureId} not found`);
    }

    const queue = await this.getPromotionQueue(closureId);
    const targetBase = targetDir ?? this.defaultTargetDir();
    await mkdir(targetBase, { recursive: true });

    const acceptedIds = new Set(accepted);
    let promoted = 0;
    for (const item of queue) {
      if (!acceptedIds.has(item.id)) continue;
      // 确保源文件存在
      if (!existsSync(item.sourcePath)) continue;
      const targetPath = join(targetBase, item.fileName);
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(item.sourcePath, targetPath);
      promoted++;
    }

    // 持久化决策记录
    const record: PromotionRecord = {
      closureId,
      accepted,
      rejected,
      promotedAt: Date.now(),
    };
    await this.savePromotionRecord(closureId, record);

    return { promoted, rejected: rejected.length };
  }

  /**
   * 清理 Closure Workspace 临时目录。
   * 删除整个 <closureId>/ 目录（包含所有测试文件和 promotion.json）。
   * 注意：不会删除 closures.json 中的 session 记录（由 ClosureManager 管理）。
   *
   * 使用 rm 为主，rmRecursiveManual 为兜底：Node.js 在 Windows 上 fs.promises.rm
   * 的 recursive 模式存在静默失败问题（不抛错但目录未删除），兜底递归删除可保证
   * 跨平台一致行为。
   */
  async cleanupClosure(closureId: string): Promise<{ ok: true }> {
    const workspaceDir = this.closureManager.getWorkspaceDir(closureId);
    if (existsSync(workspaceDir)) {
      try {
        await rm(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // rm 抛错时回退到手动递归删除
      }
      // Windows 上 rm 可能静默失败（不抛错但目录仍存在），需兜底检查
      if (existsSync(workspaceDir)) {
        await rmRecursiveManual(workspaceDir);
      }
    }
    return { ok: true };
  }

  /**
   * 生成 Closure 闭环结果摘要。
   * 展示每个 Gap 的最终状态、最后一轮 overall delta、提升/待审/拒绝计数。
   */
  async getClosureSummary(closureId: string): Promise<ClosureSummary> {
    const session = await this.closureManager.getClosure(closureId);
    if (!session) {
      throw new Error(`Closure ${closureId} not found`);
    }

    const gaps: ClosureSummaryGap[] = session.gaps.map((g) => {
      const lastIter = g.iterations[g.iterations.length - 1];
      const finalDelta =
        lastIter?.deltaBefore != null && lastIter?.deltaAfter != null
          ? lastIter.deltaAfter.overall - lastIter.deltaBefore.overall
          : null;
      return {
        gapId: g.id,
        moduleName: g.gap.nodeName,
        metric: g.gap.metric,
        status: g.status,
        rounds: g.iterations.length,
        finalDelta,
        escalationReason: g.escalationReason,
      };
    });

    // totalDelta：所有有 finalDelta 的 gap 之和
    const deltas = gaps
      .map((g) => g.finalDelta)
      .filter((d): d is number => d != null);
    const totalDelta = deltas.length > 0 ? deltas.reduce((sum, d) => sum + d, 0) : null;

    // 计数：从 promotion queue + 决策记录推导
    const queue = await this.getPromotionQueue(closureId);
    const promotedCount = queue.filter((i) => i.status === 'accepted').length;
    const rejectedCount = queue.filter((i) => i.status === 'rejected').length;
    const pendingCount = queue.filter((i) => i.status === 'pending').length;

    return {
      closureId,
      status: session.status,
      gaps,
      totalDelta,
      promotedCount,
      pendingCount,
      rejectedCount,
    };
  }

  // ─── 内部实现 ─────────────────────────────────────────────────

  /** 默认 testbench 目标目录：<projectRoot>/testbench */
  private defaultTargetDir(): string {
    return join(this.projectRoot, DEFAULT_TESTBENCH_DIR);
  }

  /** 生成 queue item 唯一标识：${gapId}__round_${round}__${fileName} */
  private makeItemId(gapId: string, round: number, fileName: string): string {
    return `${gapId}__round_${round}__${fileName}`;
  }

  /** promotion.json 路径 */
  private promotionRecordPath(closureId: string): string {
    return join(this.closureManager.getWorkspaceDir(closureId), PROMOTION_DATA_FILE);
  }

  /** 读取 promotion 决策记录（不存在时返回 null） */
  private async loadPromotionRecord(closureId: string): Promise<PromotionRecord | null> {
    try {
      const raw = await readFile(this.promotionRecordPath(closureId), 'utf-8');
      return JSON.parse(raw) as PromotionRecord;
    } catch {
      return null;
    }
  }

  /** 写入 promotion 决策记录 */
  private async savePromotionRecord(closureId: string, record: PromotionRecord): Promise<void> {
    const dir = this.closureManager.getWorkspaceDir(closureId);
    await mkdir(dir, { recursive: true });
    await writeFile(this.promotionRecordPath(closureId), JSON.stringify(record, null, 2), 'utf-8');
  }
}

// ─── 模块级辅助函数 ─────────────────────────────────────────────

/**
 * 手动递归删除目录（Windows 兜底方案）。
 *
 * Node.js 在 Windows 上 fs.promises.rm 的 recursive 模式存在静默失败问题
 *（不抛错但目录未删除），此处用 readdir + unlink + rmdir 组合保证删除成功。
 */
async function rmRecursiveManual(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await rmRecursiveManual(fullPath);
    } else {
      await unlink(fullPath);
    }
  }
  await rmdir(dir);
}
