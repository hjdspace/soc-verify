/**
 * 旧 omp 原生 session 清理（issue 08）。
 *
 * 迁移到 pi 引擎完成后，SoC Verify 明确拥有的旧 omp 原生 session 文件
 * 与 subagent artifacts 应被清理；UI transcript 保留（用户可见历史）。
 *
 * 安全边界：
 *   - 只扫描 `~/.omp/agent/sessions` 与 `~/.omp/profiles/<name>/agent/sessions`
 *     两个根下的 *.jsonl，绝不递归删除 ~/.omp 本身或其他内容；
 *   - 只删除 JSONL 首行 header（type:"session"）的 id 与应用拥有的
 *     engineSessionId **精确匹配**的文件 —— 用户在 omp TUI 里产生的
 *     非应用会话绝不动；
 *   - artifacts（bucket 级 subagent-artifacts，与 pi 同结构 —— omp 是 pi
 *     fork）仅当所在 bucket 不再有其他 session 文件时删除；
 *   - 触发时机由迁移流程（issue 11）编排，本模块只提供显式 API。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSessions } from './session-persistence';
import { errMessage, pathExists } from './session-deletion';

export type OmpLegacyCleanupReport = {
  /** 实际扫描的 sessions 根目录 */
  roots: string[];
  /** 应用拥有的 omp engineSessionId */
  ownedIds: string[];
  /** 已删除的原生 session 文件 */
  removed: string[];
  /** 因 bucket 内仍有其他会话文件而保留的 artifacts 目录 */
  keptArtifacts: string[];
  /** 清理失败项（文件路径 + 原因） */
  residual: string[];
};

export type CleanupOptions = {
  /** 覆盖 home 目录解析（测试注入临时目录） */
  home?: string;
  /** 直接指定 sessions 根（测试注入，优先于 home 推导） */
  roots?: string[];
};

/** omp 会话文件（JSONL 首行 header 的最小形状，omp 是 pi fork、格式一致） */
type OmpSessionHeader = { type?: string; id?: string };

/**
 * 收集存在的 omp sessions 根目录：
 * 全局根 `~/.omp/agent/sessions` 与每个 profile 下的
 * `~/.omp/profiles/<name>/agent/sessions`。
 * 根不存在时跳过；~/.omp 整体缺失返回空数组。
 */
export async function findOmpRoots(home = homedir()): Promise<string[]> {
  const roots: string[] = [];
  const globalRoot = join(home, '.omp', 'agent', 'sessions');
  if (existsSync(globalRoot)) roots.push(globalRoot);

  const profilesDir = join(home, '.omp', 'profiles');
  if (existsSync(profilesDir)) {
    try {
      for (const profile of await readdir(profilesDir, { withFileTypes: true })) {
        if (!profile.isDirectory()) continue;
        const root = join(profilesDir, profile.name, 'agent', 'sessions');
        if (existsSync(root)) roots.push(root);
      }
    } catch {
      // profiles 目录不可读 —— 跳过，不影响全局根
    }
  }
  return roots;
}

/** 解析 JSONL 首行 header；损坏/非 session header 返回 null。 */
async function readSessionHeaderId(filePath: string): Promise<string | null> {
  try {
    const head = await readFile(filePath, 'utf-8');
    const firstLine = head.slice(0, head.indexOf('\n') === -1 ? head.length : head.indexOf('\n')).trim();
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as OmpSessionHeader;
    if (parsed.type !== 'session' || typeof parsed.id !== 'string' || parsed.id.length === 0) {
      return null;
    }
    return parsed.id;
  } catch {
    return null;
  }
}

/**
 * 清理项目拥有的旧 omp 原生 session 文件与 artifacts。
 * 删除清单 = 应用索引中 engine='omp' 的 engineSessionId ∩ 扫描到的 header id。
 */
export async function cleanupLegacyOmpSessions(
  projectRoot: string,
  options: CleanupOptions = {},
): Promise<OmpLegacyCleanupReport> {
  const roots = options.roots ?? (await findOmpRoots(options.home));

  const persisted = await loadSessions(projectRoot);
  const owned = new Set(
    persisted
      .filter((s) => s.engine === 'omp' && s.engineSessionId)
      .map((s) => s.engineSessionId as string),
  );

  const report: OmpLegacyCleanupReport = {
    roots,
    ownedIds: [...owned],
    removed: [],
    keptArtifacts: [],
    residual: [],
  };
  if (owned.size === 0 || roots.length === 0) return report;

  // 逐 bucket 扫描 + 定向删除
  for (const root of roots) {
    let buckets: string[];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      buckets = entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
    } catch (err) {
      report.residual.push(`扫描根目录失败 (${root}): ${errMessage(err)}`);
      continue;
    }

    for (const bucket of buckets) {
      let jsonlFiles: string[];
      try {
        const entries = await readdir(bucket, { withFileTypes: true });
        jsonlFiles = entries
          .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
          .map((e) => join(bucket, e.name));
      } catch {
        continue;
      }

      // 先解析每个文件的归属 id
      const idByFile = new Map<string, string | null>();
      for (const file of jsonlFiles) {
        idByFile.set(file, await readSessionHeaderId(file));
      }

      // 删除拥有的文件（id 精确匹配）
      const ownedFiles = jsonlFiles.filter((file) => {
        const id = idByFile.get(file);
        return id !== null && id !== undefined && owned.has(id);
      });
      for (const file of ownedFiles) {
        try {
          await rm(file, { force: true });
          report.removed.push(file);
        } catch (err) {
          report.residual.push(`原生会话文件未删除 (${file}): ${errMessage(err)}`);
        }
      }

      // artifacts：bucket 内不再有其他 session 文件时才删除
      // （rm 失败的文件仍留在磁盘上 —— 以实际删除结果为准）
      if (ownedFiles.length > 0) {
        const removedSet = new Set(report.removed);
        const remainingFiles = jsonlFiles.filter((file) => !removedSet.has(file));
        let remaining = 0;
        for (const file of remainingFiles) {
          if (await pathExists(file)) remaining++;
        }
        const artifactsDir = join(bucket, 'subagent-artifacts');
        if (remaining === 0 && existsSync(artifactsDir)) {
          try {
            await rm(artifactsDir, { recursive: true, force: true });
          } catch (err) {
            report.residual.push(`subagent-artifacts 未删除 (${artifactsDir}): ${errMessage(err)}`);
          }
        } else if (remaining > 0 && existsSync(artifactsDir)) {
          report.keptArtifacts.push(artifactsDir);
        }
      }
    }
  }

  return report;
}
