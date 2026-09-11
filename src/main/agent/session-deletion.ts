/**
 * 统一 session 物理删除（issue 08）。
 *
 * 删除新建或已接管 session 时按序处理四类资源，每步独立报告
 * （deleted / skipped / failed），失败不中断后续步骤，residual 汇总残留
 * 状态供 UI 展示 —— 部分失败绝不静默。
 *
 *   index        应用索引条目（.socverify/sessions.json）
 *   transcript   UI transcript 文件（.socverify/chat-messages/<id>.json）
 *   nativeSession pi 引擎：经 session-scan 在 cwd bucket 中解析原生 JSONL
 *                并删除；omp 引擎原生文件由引擎自管理（历史行为，skipped）
 *   artifacts    pi-subagents 的 subagent-artifacts 为 bucket 级共享目录
 *                （同 cwd 所有会话共用），仅当 bucket 内不再有其他 session
 *                文件时才删除 —— 否则保留并在 residual 中说明
 *
 * 运行中会话的销毁（destroySession）由调用方（router）先行完成，本模块
 * 只负责持久化资源的清理。
 */

import { access, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadSessions, removeSession, type PersistedSession } from './session-persistence';
import { storedMessagesPath } from '../services/session-service';
import { runPiSessionScan, normPath, type ExternalPiSession, type ScanFn } from './external-pi-sessions';

export type DeletionStepResult = 'deleted' | 'skipped' | 'failed';

export type SessionDeletionReport = {
  index: DeletionStepResult;
  transcript: DeletionStepResult;
  nativeSession: DeletionStepResult;
  artifacts: DeletionStepResult;
  /** 未能清除（失败或因 bucket 共享而保留）的资源描述 */
  residual: string[];
};

/** 待删会话记录：索引中已不存在的会话也可清理（只要求 sessionId） */
export type DeletableSession = Pick<PersistedSession, 'sessionId'> & Partial<PersistedSession>;

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除一个应用拥有的 session 的全部持久化资源。
 *
 * @param projectRoot 项目根（索引与 transcript 所在）
 * @param session     待删会话记录（engine/engineSessionId/cwd 决定原生清理范围）
 * @param scan        session-scan 函数（默认 spawn CLI，测试可注入替身）
 */
export async function deleteOwnedSession(
  projectRoot: string,
  session: DeletableSession,
  scan: ScanFn = (req) => runPiSessionScan(req),
): Promise<SessionDeletionReport> {
  const report: SessionDeletionReport = {
    index: 'skipped',
    transcript: 'skipped',
    nativeSession: 'skipped',
    artifacts: 'skipped',
    residual: [],
  };

  // ─── 1. 应用索引 ───────────────────────────────────────
  try {
    const sessions = await loadSessions(projectRoot);
    if (sessions.some((s) => s.sessionId === session.sessionId)) {
      await removeSession(projectRoot, session.sessionId);
      report.index = 'deleted';
    }
  } catch (err) {
    report.index = 'failed';
    report.residual.push(`应用索引条目未清除: ${errMessage(err)}`);
  }

  // ─── 2. UI transcript ──────────────────────────────────
  try {
    const transcriptPath = storedMessagesPath(projectRoot, session.sessionId);
    if (await pathExists(transcriptPath)) {
      await rm(transcriptPath, { force: true });
      report.transcript = 'deleted';
    }
  } catch (err) {
    report.transcript = 'failed';
    report.residual.push(`UI transcript 未删除 (sessionId=${session.sessionId}): ${errMessage(err)}`);
  }

  // ─── 3+4. 原生 JSONL 与 subagent-artifacts（仅 pi）──────
  if (session.engine === 'pi' && session.engineSessionId && session.cwd) {
    let bucketSessions: ExternalPiSession[] | null = null;
    let bucketDir: string | null = null;

    try {
      const data = (await scan({ mode: 'list', cwd: session.cwd })) as {
        sessions?: ExternalPiSession[];
      };
      bucketSessions = Array.isArray(data?.sessions) ? data.sessions : [];
    } catch (err) {
      report.nativeSession = 'failed';
      report.artifacts = 'failed';
      report.residual.push(`无法定位原生会话（cwd=${session.cwd}）: ${errMessage(err)}`);
    }

    if (bucketSessions) {
      const target = bucketSessions.find((s) => s.id === session.engineSessionId);
      if (!target) {
        // 原生文件已不在 bucket 中（可能已被外部删除）—— 无残留
        report.nativeSession = 'skipped';
      } else {
        bucketDir = dirname(target.path);
        try {
          await rm(target.path, { force: true });
          report.nativeSession = 'deleted';
        } catch (err) {
          report.nativeSession = 'failed';
          report.residual.push(`原生会话文件未删除 (${target.path}): ${errMessage(err)}`);
        }
      }

      if (bucketDir) {
        const bucketKey = normPath(bucketDir);
        const othersInBucket = bucketSessions.filter(
          (s) => s.id !== session.engineSessionId && normPath(dirname(s.path)) === bucketKey,
        );
        if (othersInBucket.length > 0) {
          // bucket 级共享目录：其他会话（含外部/未接管会话）可能仍在使用
          report.artifacts = 'skipped';
          report.residual.push(
            `subagent-artifacts 为 bucket 级共享目录，桶内仍有 ${othersInBucket.length} 个其他会话，未删除`,
          );
        } else {
          const artifactsDir = join(bucketDir, 'subagent-artifacts');
          try {
            if (await pathExists(artifactsDir)) {
              await rm(artifactsDir, { recursive: true, force: true });
              report.artifacts = 'deleted';
            }
          } catch (err) {
            report.artifacts = 'failed';
            report.residual.push(`subagent-artifacts 未删除 (${artifactsDir}): ${errMessage(err)}`);
          }
        }
      }
    }
  }

  return report;
}
