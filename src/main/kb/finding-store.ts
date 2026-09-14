/**
 * Finding Store — 知识待办持久化与状态管理（spec §9，issue 25）。
 *
 * 持久位置：`.kb/findings/findings.json`（单文件，数组结构）。
 *
 * 合并语义（重复扫描保留 ignored/resolved）：
 *  1. 新扫描的 finding 用 findingId 匹配已有 finding
 *  2. 匹配且 evidenceHashes 相同 → 保留已有 status（ignored/resolved 不丢）
 *  3. 匹配但 evidenceHashes 不同 → 证据改变，重开为 open
 *  4. 新 finding（无匹配）→ status=open
 *  5. 已有但本次未扫描到 → 保留（可能下次扫描会再次出现）
 *
 * 不同库不混用状态：kbId 内嵌于 finding，findings.json 只存当前库的。
 *
 * 坏 JSON 保留损坏副本并报恢复错误，不静默清空（spec §5）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §9
 */

import { join } from 'node:path';
import { mkdir, readFile, rename, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { wikiLayout } from './wiki-layout';
import { writeFileAtomic } from './atomic-commit';
import type {
  WikiFindingAction,
  WikiFindingFilter,
  WikiFindingListResult,
  WikiFindingStatus,
  WikiFindingUpdateResult,
  WikiStructuralFinding,
} from '@shared/kb-types';

// ── 路径 ────────────────────────────────────────────────────────

function findingsFile(kbPath: string): string {
  return join(wikiLayout(kbPath).kbDir, 'findings', 'findings.json');
}

function findingsCorruptBackup(kbPath: string): string {
  return join(wikiLayout(kbPath).kbDir, 'findings', 'findings.corrupt.json');
}

// ── 读取 ────────────────────────────────────────────────────────

/** 读取持久化的 findings。文件不存在时返回空数组。 */
export async function readFindings(kbPath: string): Promise<WikiFindingListResult> {
  const filePath = findingsFile(kbPath);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, findings: [] };
    }
    return { ok: false, code: 'ioError', message: `读取 findings 失败: ${String(err)}` };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // 坏 JSON：保留损坏副本，不静默清空（spec §5）
    try {
      await mkdir(join(wikiLayout(kbPath).kbDir, 'findings'), { recursive: true });
      await copyFile(filePath, findingsCorruptBackup(kbPath));
    } catch {
      // 尽力保留，失败不阻断错误报告
    }
    return { ok: false, code: 'ioError', message: 'findings.json 损坏（已保留副本为 findings.corrupt.json）' };
  }

  if (!Array.isArray(data)) {
    return { ok: false, code: 'ioError', message: 'findings.json 结构非法（期望数组）' };
  }

  const findings = (data as unknown[]).filter(isValidFinding);
  return { ok: true, findings };
}

function isValidFindingsArray(data: unknown): data is WikiStructuralFinding[] {
  return Array.isArray(data) && data.every(isValidFinding);
}

function isValidFinding(data: unknown): data is WikiStructuralFinding {
  if (data === null || typeof data !== 'object') return false;
  const f = data as Record<string, unknown>;
  return (
    typeof f.findingId === 'string' &&
    typeof f.kbId === 'string' &&
    typeof f.kind === 'string' &&
    Array.isArray(f.pageIds) &&
    Array.isArray(f.evidenceRefs) &&
    Array.isArray(f.evidenceHashes) &&
    typeof f.status === 'string' &&
    typeof f.createdAt === 'string' &&
    typeof f.updatedAt === 'string'
  );
}

// ── 写入 ────────────────────────────────────────────────────────

async function writeFindings(kbPath: string, findings: WikiStructuralFinding[]): Promise<void> {
  const filePath = findingsFile(kbPath);
  await mkdir(join(wikiLayout(kbPath).kbDir, 'findings'), { recursive: true });
  await writeFileAtomic(filePath, JSON.stringify(findings, null, 2));
}

// ── 合并扫描结果 ────────────────────────────────────────────────

/**
 * 将新扫描的 findings 合并入持久存储。
 *
 * 合并规则：
 *  1. findingId 匹配 + evidenceHashes 相同 → 保留已有 status/createdAt
 *  2. findingId 匹配 + evidenceHashes 不同 → 证据改变，重开为 open（更新 updatedAt）
 *  3. 新 finding → status=open
 *  4. 已有但未扫描到 → 保留（不删除，可能下次出现）
 *
 * 返回合并后的完整 findings 列表（已持久化）。
 */
export async function mergeFindings(
  kbPath: string,
  scanned: WikiStructuralFinding[],
  now?: string,
): Promise<WikiStructuralFinding[]> {
  const timestamp = now ?? new Date().toISOString();

  const existingResult = await readFindings(kbPath);
  const existing = existingResult.ok ? existingResult.findings : [];

  // 按 findingId 索引已有 findings
  const existingMap = new Map<string, WikiStructuralFinding>();
  for (const f of existing) {
    existingMap.set(f.findingId, f);
  }

  const mergedMap = new Map<string, WikiStructuralFinding>();

  // 处理本次扫描的 findings
  for (const scanned_f of scanned) {
    const prev = existingMap.get(scanned_f.findingId);
    if (prev) {
      // 证据 hash 是否变化
      const evidenceChanged = !hashesEqual(prev.evidenceHashes, scanned_f.evidenceHashes);
      if (evidenceChanged) {
        // 证据改变 → 重开
        mergedMap.set(scanned_f.findingId, {
          ...scanned_f,
          status: 'open',
          createdAt: prev.createdAt, // 保留首次发现时间
          updatedAt: timestamp,
        });
      } else {
        // 证据不变 → 保留已有 status/createdAt
        mergedMap.set(scanned_f.findingId, {
          ...scanned_f,
          status: prev.status,
          createdAt: prev.createdAt,
          updatedAt: prev.updatedAt,
        });
      }
    } else {
      // 新 finding
      mergedMap.set(scanned_f.findingId, {
        ...scanned_f,
        status: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  }

  // 保留已有但本次未扫描到的 findings（可能下次扫描会再次出现）
  for (const [id, f] of existingMap) {
    if (!mergedMap.has(id)) {
      mergedMap.set(id, f);
    }
  }

  const merged = Array.from(mergedMap.values()).sort((a, b) => {
    // 按 kind → pageIds 排序，稳定
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.pageIds.join(',').localeCompare(b.pageIds.join(','));
  });

  await writeFindings(kbPath, merged);
  return merged;
}

function hashesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((h, i) => h === b[i]);
}

// ── 更新 finding 状态 ───────────────────────────────────────────

/**
 * 更新单个 finding 的处置状态。
 *
 * 动作：
 *  - ignore → status=ignored
 *  - unignore → status=open
 *  - resolve → status=resolved
 *  - reopen → status=open
 *
 * finding 不存在时返回 findingNotFound。
 */
export async function updateFindingStatus(
  kbPath: string,
  findingId: string,
  action: WikiFindingAction,
  now?: string,
): Promise<WikiFindingUpdateResult> {
  const timestamp = now ?? new Date().toISOString();

  const existingResult = await readFindings(kbPath);
  if (!existingResult.ok) {
    return { ok: false, code: 'findingNotFound', message: existingResult.message };
  }
  const findings = existingResult.findings;

  const idx = findings.findIndex((f) => f.findingId === findingId);
  if (idx === -1) {
    return { ok: false, code: 'findingNotFound', message: `Finding ${findingId} 不存在` };
  }

  const newStatus: WikiFindingStatus = action === 'ignore' ? 'ignored'
    : action === 'resolve' ? 'resolved'
    : 'open'; // unignore / reopen

  const updated: WikiStructuralFinding = {
    ...findings[idx],
    status: newStatus,
    updatedAt: timestamp,
  };

  findings[idx] = updated;
  await writeFindings(kbPath, findings);
  return { ok: true, finding: updated };
}

// ── 列表查询（带过滤）──────────────────────────────────────────

/**
 * 列出 findings，可选按状态/kind 过滤。
 */
export async function listFindings(
  kbPath: string,
  filter?: WikiFindingFilter,
): Promise<WikiFindingListResult> {
  const result = await readFindings(kbPath);
  if (!result.ok) return result;

  let findings = result.findings;
  if (filter?.status) {
    findings = findings.filter((f) => f.status === filter.status);
  }
  if (filter?.kind) {
    findings = findings.filter((f) => f.kind === filter.kind);
  }

  return { ok: true, findings };
}
