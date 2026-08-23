/**
 * Gen history for sysbase-gen — 记录 sysbase_gen.py 执行历史。
 *
 * 持久化到 `<projectDir>/.socverify/sysbase-gen/gen-history.json`，
 * 用于总览里程碑「环境生成」节点判定：存在任一 success 记录即视为
 * 用户已完成 SOC 验证环境生成。
 *
 * All functions are pure filesystem operations — no side effects beyond disk I/O.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SOCVERIFY_DIR = '.socverify';
const SYSGEN_DIR = 'sysbase-gen';
const HISTORY_FILE = 'gen-history.json';

/** 历史上限（超出后丢弃最旧记录，避免无限增长） */
const MAX_ENTRIES = 100;

/** 单次环境生成执行记录 */
export type GenHistoryEntry = {
  /** 生成级别（top / subsys） */
  genLevel: string;
  /** 目标子系统名（top 级别为芯片名） */
  subsys: string;
  /** 输出目录 */
  outputDir: string;
  /** 执行是否成功（exit code === 0） */
  success: boolean;
  /** 进程退出码（spawn 失败时为 null） */
  exitCode: number | null;
  /** ISO 时间戳 */
  timestamp: string;
};

function resolveHistoryPath(projectDir: string): string {
  return join(projectDir, SOCVERIFY_DIR, SYSGEN_DIR, HISTORY_FILE);
}

/**
 * 加载历史记录（文件缺失/损坏时返回空数组，不抛异常）。
 */
export async function loadGenHistory(projectDir: string): Promise<GenHistoryEntry[]> {
  const historyPath = resolveHistoryPath(projectDir);
  if (!existsSync(historyPath)) return [];

  try {
    const content = await readFile(historyPath, 'utf-8');
    const data = JSON.parse(content) as GenHistoryEntry[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * 追加一条执行记录（ newest 在前，超出上限截断）。
 */
export async function appendGenHistory(
  projectDir: string,
  entry: GenHistoryEntry,
): Promise<void> {
  const dir = join(projectDir, SOCVERIFY_DIR, SYSGEN_DIR);
  await mkdir(dir, { recursive: true });

  const existing = await loadGenHistory(projectDir);
  const next = [entry, ...existing].slice(0, MAX_ENTRIES);
  await writeFile(resolveHistoryPath(projectDir), JSON.stringify(next, null, 2), 'utf-8');
}

/**
 * 是否已成功生成过 SOC 验证环境（存在任一 success 记录）。
 */
export async function hasSuccessfulGen(projectDir: string): Promise<boolean> {
  const history = await loadGenHistory(projectDir);
  return history.some((e) => e.success);
}
