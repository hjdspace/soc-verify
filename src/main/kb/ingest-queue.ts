/**
 * KB 持久导入队列（issue 03，spec §5）— 让导入任务可暂停、取消并在重启后恢复。
 *
 * 每库一个队列文件（<kb>/.kb/queue.json），持久 taskId/attemptId/kbId/阶段/
 * lastError/paused/seq。核心不变量：
 *
 *  1. 库身份绑定：任务只写回自己的库（kbPath/kbId 在 attach 时固定），
 *     不随 UI 焦点转移；attach 校验队列文件 kbId，不匹配拒绝且不改写。
 *  2. attempt 失效：中断执行（暂停中止/重启恢复）消耗 attempt 并换新
 *     attemptId；运行结算时 attemptId 不匹配的一律忽略 —— 迟到的转换结果
 *     不可提交（转换内部另有 signal 边界兜底，见 source-import）。
 *  3. committing 临界区：进入提交临界区后任务停留 committing，暂停/卸载
 *     等待其完成，取消被拒绝 —— 完整旧版或完整新版，不半途丢弃。
 *  4. 先持久后生效：用户操作先落盘再确认；落盘失败操作报错并回滚内存，
 *     不静默降级。后台结算失败记 lastPersistError 并暂停调度。
 *  5. 重启恢复安全状态：attach 把 converting/committing 等活动阶段重排为
 *     queued（新 attempt），restoredWaiting 置位等待用户继续，不自动执行
 *     （避免重启后意外付费）；坏队列文件保留现场报 corrupted。
 *  6. 事件带身份与单调 seq：kb:task 事件携带 kbId + seq；快照可随时重拉，
 *     重订阅先拉快照再按 seq 应用事件。
 *
 * 初始单 worker；setWorkerLimit 可调有界并发（clamp [1,5]）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §5
 * @see .scratch/llm-wiki/issues/03-durable-ingest-queue.md
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './atomic-commit';
import { readWikiManifest } from './wiki-layout';
import { convertWikiSource, WikiSourceAbortedError } from './source-import';
import type { SourceConvertOutcome } from './source-import';
import { compileWikiSource, createDefaultCompileLlmFactory } from './compile';
import type { CompileLlm, CompileSuccess } from './compile';
import { createDefaultVisionLlmFactory } from './vision';
import type { VisionLlm } from './vision';
import type { LlmUsage } from './llm-call';
import type {
  WikiIngestPhase,
  WikiIngestTask,
  WikiQueueErrorCode,
  WikiQueueSnapshot,
  WikiTaskError,
  WikiTaskEvent,
  WikiTaskProgress,
  WikiTaskUsage,
} from '@shared/kb-types';
import { STOPPED_PHASES, isRetryablePhase } from '@shared/kb-task-phases';

// ── 常量与工具 ──────────────────────────────────────────────────

const QUEUE_VERSION = 1;

const PHASES: readonly WikiIngestPhase[] = [
  'queued',
  'converting',
  'vision',
  'analyzing',
  'generating',
  'validating',
  'awaiting_review',
  'committing',
  'published',
  'done',
  'failed',
  'cancelled',
  'blocked',
];

// 停机阶段（STOPPED_PHASES）与可重试判定集中在 shared/kb-task-phases：
// blocked（issue 10：预算/配置不足）停机但**可重试** —— 用户补齐预算后按原任务继续，
// 已完成的分段分析保存在 checkpoint；不由恢复逻辑自动重跑。

/** 可中止的计算阶段（转换 + 编译各阶段）：暂停/取消/卸载对这些阶段中止在途运行 */
const RUNNABLE_PHASES: ReadonlySet<WikiIngestPhase> = new Set<WikiIngestPhase>([
  'converting',
  'vision',
  'analyzing',
  'generating',
  'validating',
]);

function queueFilePath(kbPath: string): string {
  return join(kbPath, '.kb', 'queue.json');
}

function cloneTask(t: WikiIngestTask): WikiIngestTask {
  return {
    ...t,
    lastError: t.lastError ? { ...t.lastError } : null,
    usage: t.usage ? { ...t.usage } : null,
    progress: t.progress ? { ...t.progress } : null,
  };
}

function isRecord(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null && !Array.isArray(u);
}

// ── 错误 ────────────────────────────────────────────────────────

/** 队列操作结构化错误（router 映射为 TRPCError；调用方按 code 分支） */
export class WikiQueueError extends Error {
  constructor(
    readonly code: WikiQueueErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WikiQueueError';
  }
}

// ── 持久格式 ────────────────────────────────────────────────────

/** .kb/queue.json 的持久形态（restoredWaiting/lastPersistError 为运行态，不持久） */
type PersistedQueue = {
  queueVersion: number;
  kbId: string;
  paused: boolean;
  seq: number;
  tasks: WikiIngestTask[];
};

/** 结构校验：任何字段非法 → null（调用方报 corrupted，保留现场不清空） */
function parseQueueFile(raw: unknown): PersistedQueue | null {
  if (!isRecord(raw)) return null;
  if (raw.queueVersion !== QUEUE_VERSION) return null;
  if (typeof raw.kbId !== 'string' || raw.kbId.length === 0) return null;
  if (typeof raw.paused !== 'boolean') return null;
  if (typeof raw.seq !== 'number' || !Number.isInteger(raw.seq) || raw.seq < 0) return null;
  if (!Array.isArray(raw.tasks)) return null;
  const tasks: WikiIngestTask[] = [];
  for (const item of raw.tasks) {
    const task = parseTask(item, raw.kbId);
    if (!task) return null;
    tasks.push(task);
  }
  return { queueVersion: QUEUE_VERSION, kbId: raw.kbId, paused: raw.paused, seq: raw.seq, tasks };
}

function parseTask(u: unknown, kbId: string): WikiIngestTask | null {
  if (!isRecord(u)) return null;
  if (u.kbId !== kbId) return null;
  const { taskId, kind, sourceId, sourcePath, phase, attemptId, attempt, lastError, enqueuedAt, updatedAt } = u;
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  if (kind !== 'convertSource' && kind !== 'compileSource') return null;
  if (typeof sourceId !== 'string' || sourceId.length === 0) return null;
  if (typeof sourcePath !== 'string') return null;
  if (typeof phase !== 'string' || !PHASES.includes(phase as WikiIngestPhase)) return null;
  if (typeof attemptId !== 'string' || attemptId.length === 0) return null;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) return null;
  if (typeof enqueuedAt !== 'string' || typeof updatedAt !== 'string') return null;
  let error: WikiTaskError | null = null;
  if (lastError !== null && lastError !== undefined) {
    if (!isRecord(lastError)) return null;
    if (typeof lastError.code !== 'string' || typeof lastError.message !== 'string' || typeof lastError.at !== 'string') {
      return null;
    }
    error = { code: lastError.code, message: lastError.message, at: lastError.at };
  }
  // issue 09 新增字段：旧队列文件缺失时用中性默认（不进任务文件不伪造用量）
  return {
    taskId,
    kbId,
    kind,
    sourceId,
    sourcePath,
    phase: phase as WikiIngestPhase,
    attemptId,
    attempt,
    lastError: error,
    usage: parseTaskUsage(u.usage),
    retryCount:
      typeof u.retryCount === 'number' && Number.isInteger(u.retryCount) && u.retryCount >= 0
        ? u.retryCount
        : 0,
    progress: parseTaskProgress(u.progress),
    // 用户显式选择仅按文字继续（issue 12）：重启恢复后仍生效
    ...(u.textOnly === true ? { textOnly: true } : {}),
    enqueuedAt,
    updatedAt,
  };
}

/** 持久形态的分段进度：只接受非负整数，其余按「无进度」处理（向后兼容旧队列文件）；
 *  reused（缓存命中数，issue 13）存在且合法时一并保留。 */
function parseTaskProgress(value: unknown): WikiTaskProgress | null {
  if (!isRecord(value)) return null;
  const { done, total } = value;
  if (typeof done !== 'number' || !Number.isInteger(done) || done < 0) return null;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return null;
  return {
    done: Math.min(done, total),
    total,
    ...(typeof value.reused === 'number' && Number.isInteger(value.reused) && value.reused >= 0
      ? { reused: value.reused }
      : {}),
  };
}

/** 持久形态的 usage：只接受有限数字字段，其余忽略（未知字段不伪造） */
function parseTaskUsage(value: unknown): WikiTaskUsage | null {
  if (!isRecord(value)) return null;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const usage: WikiTaskUsage = {
    inputTokens: num(value.inputTokens),
    outputTokens: num(value.outputTokens),
    totalTokens: num(value.totalTokens),
  };
  return usage.inputTokens === undefined && usage.outputTokens === undefined && usage.totalTokens === undefined
    ? null
    : usage;
}

/**
 * 汇总一次 attempt 各阶段 usage（只累加 API 实际给出的字段）。
 * 全部缺失 → null（不伪造 0 用量）。
 */
function summarizeUsage(usages: readonly LlmUsage[] | undefined): WikiTaskUsage | null {
  if (!usages || usages.length === 0) return null;
  const sum: WikiTaskUsage = {};
  let any = false;
  for (const u of usages) {
    if (!u) continue;
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
      const v = u[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum[key] = (sum[key] ?? 0) + v;
        any = true;
      }
    }
  }
  return any ? sum : null;
}

// ── 运行态 ──────────────────────────────────────────────────────

type QueueState = {
  kbPath: string;
  kbId: string;
  paused: boolean;
  restoredWaiting: boolean;
  seq: number;
  lastPersistError: string | null;
  tasks: WikiIngestTask[];
};

type InflightRun = {
  taskId: string;
  attemptId: string;
  controller: AbortController;
  promise: Promise<void>;
};

/** 运行结算：转换/编译结果或「已中止」（中止不改变任务状态，由 aborter 负责重排）。
 *  失败统一为 { ok:false, error:{code,message} } 形状（code 为 string，兼容编译错误码）；
 *  编译失败的 usage/retryCount 从诊断携带（issue 09：面板展示重试与用量）。 */
type RunFailure = {
  ok: false;
  error: { code: string; message: string };
  /** 失败前已完成阶段的 usage（可获得的字段） */
  usage?: LlmUsage[];
  retryCount?: number;
};
type RunOutcome = SourceConvertOutcome | CompileSuccess | RunFailure | 'aborted';

export type WikiQueueAttachResult =
  | { ok: true; /** 恢复的未完结任务数 */ restored: number; snapshot: WikiQueueSnapshot }
  | { ok: false; reason: 'corrupted' | 'kbIdMismatch' | 'queueIoError' };

export type WikiIngestQueueOptions = {
  /** kb:task 事件回调（主进程经 webContents.send 转发渲染端） */
  notify?: (e: WikiTaskEvent) => void;
  /**
   * 编译任务的模型入口工厂（每次 attempt 开始时调用一次，固定配置快照）。
   * 返回 null = 无可用凭证。缺省用 createDefaultCompileLlmFactory()（解析
   * KB 设置/默认凭证）；测试注入可控假响应。凭证不流入任务文件/渲染端。
   */
  compileLlmFactory?: (signal: AbortSignal) => Promise<CompileLlm | null>;
  /**
   * 编译任务的视觉模型入口工厂（issue 12，每次 attempt 调用一次）。
   * 返回 null = 未配置视觉模型（含位图资产的来源将以 visionNotConfigured
   * blocked，除非任务被用户显式标记 textOnly）。
   * 缺省用 createDefaultVisionLlmFactory()（解析 KB 设置 vision 角色）；
   * 测试注入可控假响应。凭证不流入任务文件/渲染端。
   */
  visionLlmFactory?: (signal: AbortSignal) => Promise<VisionLlm | null>;
};

// ── 队列管理器 ──────────────────────────────────────────────────

export class WikiIngestQueueManager {
  private readonly notify: ((e: WikiTaskEvent) => void) | undefined;
  private readonly compileLlmFactory: (signal: AbortSignal) => Promise<CompileLlm | null>;
  private readonly visionLlmFactory: (signal: AbortSignal) => Promise<VisionLlm | null>;
  private state: QueueState | null = null;
  private readonly inflight = new Map<string, InflightRun>();
  private workerLimit = 1;
  private pendingEvents: WikiTaskEvent[] = [];
  /** 磁盘写串行化：并发 flush 的写入乱序会让旧快照覆盖新快照 */
  private persistChain: Promise<unknown> = Promise.resolve();

  constructor(options: WikiIngestQueueOptions = {}) {
    this.notify = options.notify;
    this.compileLlmFactory = options.compileLlmFactory ?? createDefaultCompileLlmFactory();
    this.visionLlmFactory = options.visionLlmFactory ?? createDefaultVisionLlmFactory();
  }

  // ── 附着 / 卸载 ──

  /**
   * 附着到库并恢复队列。切库时旧库自动完成握手（中止可中止工作、等待
   * 提交、落安全状态）。坏队列文件/身份不符拒绝且不改写文件。
   */
  async attach(kbPath: string, kbId: string): Promise<WikiQueueAttachResult> {
    const current = this.state;
    if (current && current.kbId === kbId && current.kbPath === kbPath) {
      const snap = this.snapshot(kbId);
      return snap ? { ok: true, restored: 0, snapshot: snap } : { ok: false, reason: 'queueIoError' };
    }
    if (current) {
      try {
        await this.detach(current.kbId);
      } catch {
        // 旧库 flush 失败（如目录被外部删除）：等待在途运行后强制让位，
        // 不能让旧库的持久化问题阻塞新库附着。旧库任务停留在盘上最近一次
        // 安全状态，下次 attach 按恢复路径处理。
        await this.forceDetach(current.kbId);
      }
    }

    let content: string | null = null;
    try {
      content = await readFile(queueFilePath(kbPath), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, reason: 'queueIoError' };
      }
    }

    let persisted: PersistedQueue | null = null;
    if (content !== null) {
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch {
        return { ok: false, reason: 'corrupted' };
      }
      const parsed = parseQueueFile(raw);
      if (!parsed) return { ok: false, reason: 'corrupted' };
      if (parsed.kbId !== kbId) return { ok: false, reason: 'kbIdMismatch' };
      persisted = parsed;
    }

    // 恢复安全状态：中断过的执行消耗 attempt（新 attemptId 使迟到结果失效）
    let restored = 0;
    const reverted: WikiIngestTask[] = [];
    const tasks: WikiIngestTask[] = [];
    for (const t of persisted?.tasks ?? []) {
      if (t.phase === 'queued' || STOPPED_PHASES.has(t.phase)) {
        tasks.push(t);
        if (!STOPPED_PHASES.has(t.phase)) restored += 1;
      } else {
        const safe: WikiIngestTask = {
          ...t,
          phase: 'queued',
          attempt: t.attempt + 1,
          attemptId: randomUUID(),
          updatedAt: new Date().toISOString(),
        };
        tasks.push(safe);
        reverted.push(safe);
        restored += 1;
      }
    }

    const state: QueueState = {
      kbPath,
      kbId,
      paused: persisted?.paused ?? false,
      restoredWaiting: restored > 0,
      seq: persisted?.seq ?? 0,
      lastPersistError: null,
      tasks,
    };
    this.state = state;
    for (const t of reverted) this.pushTaskEvent(t);
    if (restored > 0) this.pushQueueEvent();

    if (persisted) {
      // 恢复出的安全状态必须落盘：崩溃后再次 attach 看到的是同一安全状态
      try {
        await this.flush();
      } catch {
        this.state = null;
        return { ok: false, reason: 'queueIoError' };
      }
    }
    const snap = this.snapshot(kbId);
    return snap ? { ok: true, restored, snapshot: snap } : { ok: false, reason: 'queueIoError' };
  }

  /** 卸载库：中止 converting（重排 queued 落盘）、等待 committing 完成；非附着库是 no-op。 */
  async detach(kbId: string): Promise<void> {
    const st = this.state;
    if (!st || st.kbId !== kbId) return;

    const committingRuns: Promise<void>[] = [];
    for (const t of st.tasks) {
      if (RUNNABLE_PHASES.has(t.phase)) {
        const run = this.inflight.get(t.taskId);
        if (run) {
          run.controller.abort();
          // 被中止的运行让出槽位（引擎结果可能永不返回，不能占住 worker）
          this.inflight.delete(t.taskId);
        }
      } else if (t.phase === 'committing') {
        const run = this.inflight.get(t.taskId);
        if (run) committingRuns.push(run.promise);
      }
    }
    for (const t of st.tasks) {
      if (RUNNABLE_PHASES.has(t.phase)) {
        t.phase = 'queued';
        t.attempt += 1;
        t.attemptId = randomUUID();
        t.updatedAt = new Date().toISOString();
        this.pushTaskEvent(t);
      }
    }
    await this.flush();
    await Promise.all(committingRuns);
    this.state = null;
    this.inflight.clear();
  }

  /**
   * 强制解除绑定（attach 切库兜底）：flush 已失败时调用。中止全部在途运行、
   * 等待其结束后弃置内存状态。任务保留在盘上最近一次安全状态，下次 attach
   * 按恢复路径（重排 queued）处理。
   */
  private async forceDetach(kbId: string): Promise<void> {
    const st = this.state;
    if (!st || st.kbId !== kbId) return;
    const runs = [...this.inflight.values()];
    for (const run of runs) run.controller.abort();
    this.inflight.clear();
    await Promise.all(runs.map((r) => r.promise.catch(() => undefined)));
    this.state = null;
  }

  // ── 任务操作 ──

  /** 来源转换任务入队（同来源活动任务去重）。持久化成功才算入队成功。 */
  async enqueueConvert(kbId: string, sourceId: string): Promise<WikiIngestTask> {
    const st = this.requireAttached(kbId);
    const read = await readWikiManifest(st.kbPath);
    if (!read.ok) {
      throw new WikiQueueError('manifestCorrupted', `库 manifest 不可读（${read.reason}），无法入队`);
    }
    const rec = read.manifest.sources?.[sourceId];
    if (!rec) {
      throw new WikiQueueError('sourceNotFound', `来源不存在: ${sourceId}`);
    }
    const existing = st.tasks.find(
      (t) => t.kind === 'convertSource' && t.sourceId === sourceId && !STOPPED_PHASES.has(t.phase),
    );
    if (existing) return cloneTask(existing);

    const now = new Date().toISOString();
    const task: WikiIngestTask = {
      taskId: randomUUID(),
      kbId: st.kbId,
      kind: 'convertSource',
      sourceId,
      sourcePath: rec.sourcePath,
      phase: 'queued',
      attemptId: randomUUID(),
      attempt: 1,
      lastError: null,
      usage: null,
      retryCount: 0,
      progress: null,
      enqueuedAt: now,
      updatedAt: now,
    };
    st.tasks.push(task);
    this.pushTaskEvent(task);
    try {
      await this.flush();
    } catch (err) {
      st.tasks = st.tasks.filter((t) => t.taskId !== task.taskId);
      throw err;
    }
    const copy = cloneTask(task);
    this.schedulePump();
    return copy;
  }

  /**
   * 来源编译任务入队（issue 08）。同来源活动编译任务去重；
   * 转换任务与编译任务互不冲突（编译运行内部会保障来源就绪）。
   * 持久化成功才算入队成功。
   */
  async enqueueCompile(kbId: string, sourceId: string): Promise<WikiIngestTask> {
    const st = this.requireAttached(kbId);
    const read = await readWikiManifest(st.kbPath);
    if (!read.ok) {
      throw new WikiQueueError('manifestCorrupted', `库 manifest 不可读（${read.reason}），无法入队`);
    }
    const rec = read.manifest.sources?.[sourceId];
    if (!rec) {
      throw new WikiQueueError('sourceNotFound', `来源不存在: ${sourceId}`);
    }
    const existing = st.tasks.find(
      (t) => t.kind === 'compileSource' && t.sourceId === sourceId && !STOPPED_PHASES.has(t.phase),
    );
    if (existing) return cloneTask(existing);

    const now = new Date().toISOString();
    const task: WikiIngestTask = {
      taskId: randomUUID(),
      kbId: st.kbId,
      kind: 'compileSource',
      sourceId,
      sourcePath: rec.sourcePath,
      phase: 'queued',
      attemptId: randomUUID(),
      attempt: 1,
      lastError: null,
      usage: null,
      retryCount: 0,
      progress: null,
      enqueuedAt: now,
      updatedAt: now,
    };
    st.tasks.push(task);
    this.pushTaskEvent(task);
    try {
      await this.flush();
    } catch (err) {
      st.tasks = st.tasks.filter((t) => t.taskId !== task.taskId);
      throw err;
    }
    const copy = cloneTask(task);
    this.schedulePump();
    return copy;
  }

  /** 队列级暂停：中止 converting（任务回 queued，消耗 attempt）、等待 committing 完成。 */
  async pause(kbId: string): Promise<void> {
    const st = this.requireAttached(kbId);
    if (st.paused) return;

    const committingRuns: Promise<void>[] = [];
    for (const t of st.tasks) {
      if (t.phase === 'committing') {
        const run = this.inflight.get(t.taskId);
        if (run) committingRuns.push(run.promise);
      } else if (RUNNABLE_PHASES.has(t.phase)) {
        const run = this.inflight.get(t.taskId);
        if (run) {
          run.controller.abort();
          // 被中止的运行让出槽位：恢复后立即可以新一轮（迟到结果按 attempt 失效忽略）
          this.inflight.delete(t.taskId);
        }
      }
    }

    const prevPaused = st.paused;
    const prevTasks = st.tasks.map(cloneTask);
    st.paused = true;
    for (const t of st.tasks) {
      if (RUNNABLE_PHASES.has(t.phase)) {
        t.phase = 'queued';
        t.attempt += 1;
        t.attemptId = randomUUID();
        t.updatedAt = new Date().toISOString();
        this.pushTaskEvent(t);
      }
    }
    this.pushQueueEvent();
    try {
      await this.flush();
    } catch (err) {
      st.paused = prevPaused;
      st.tasks = prevTasks;
      throw err;
    }
    await Promise.all(committingRuns);
  }

  /** 继续：清除 paused/restoredWaiting 并恢复调度。 */
  async resume(kbId: string): Promise<void> {
    const st = this.requireAttached(kbId);
    if (!st.paused && !st.restoredWaiting) return;
    const prev = { paused: st.paused, restoredWaiting: st.restoredWaiting };
    st.paused = false;
    st.restoredWaiting = false;
    this.pushQueueEvent();
    try {
      await this.flush();
    } catch (err) {
      st.paused = prev.paused;
      st.restoredWaiting = prev.restoredWaiting;
      throw err;
    }
    this.schedulePump();
  }

  /** 取消任务：converting 中止（attempt 失效使迟到结果不可提交）；committing 拒绝。 */
  async cancelTask(kbId: string, taskId: string): Promise<void> {
    const st = this.requireAttached(kbId);
    const task = st.tasks.find((t) => t.taskId === taskId);
    if (!task) throw new WikiQueueError('taskNotFound', `任务不存在: ${taskId}`);
    if (task.phase === 'committing') {
      throw new WikiQueueError('committing', `任务正在提交，暂不能取消: ${task.sourcePath}`);
    }
    if (STOPPED_PHASES.has(task.phase)) {
      throw new WikiQueueError('invalidPhase', `任务已处于终态（${task.phase}），不能取消`);
    }
    if (RUNNABLE_PHASES.has(task.phase)) {
      const run = this.inflight.get(taskId);
      if (run) {
        run.controller.abort();
        // 被中止的运行让出槽位（迟到的结果按 attempt/phase 检查忽略）
        this.inflight.delete(taskId);
      }
    }
    const prevPhase = task.phase;
    task.phase = 'cancelled';
    task.updatedAt = new Date().toISOString();
    this.pushTaskEvent(task);
    try {
      await this.flush();
    } catch (err) {
      task.phase = prevPhase;
      throw err;
    }
  }

  /** 重试 failed/cancelled 任务：新 attempt，lastError 保留到新结果产生。 */
  async retryTask(kbId: string, taskId: string): Promise<void> {
    const st = this.requireAttached(kbId);
    const task = st.tasks.find((t) => t.taskId === taskId);
    if (!task) throw new WikiQueueError('taskNotFound', `任务不存在: ${taskId}`);
    // blocked（预算/配置不足，issue 10）同样可重试：用户补齐预算后继续，
    // 已完成的分段分析保存在 checkpoint，只重做未完成段。
    if (!isRetryablePhase(task.phase)) {
      throw new WikiQueueError('invalidPhase', `只有 failed/cancelled/blocked 任务可重试（当前 ${task.phase}）`);
    }
    const prev = cloneTask(task);
    task.phase = 'queued';
    task.attempt += 1;
    task.attemptId = randomUUID();
    task.updatedAt = new Date().toISOString();
    this.pushTaskEvent(task);
    try {
      await this.flush();
    } catch (err) {
      Object.assign(task, prev);
      throw err;
    }
    this.schedulePump();
  }

  /**
   * 用户明确选择「仅按文字继续」（issue 12，spec §3）：textOnly 持久化进
   * 队列文件（重启恢复后仍生效）并按原任务重试 —— 重跑跳过视觉解读生成
   * 不完整提案（changeSet 列出视觉缺口并标 partial，不冒充完整编译）。
   *
   * 只允许对因视觉原因受阻/失败的任务设置（visionNotConfigured /
   * visionFailed / visionBatchLimit，issue 12/13）；已完成的解读不删除，
   * 重跑时作为附录复用。
   */
  async continueTextOnly(kbId: string, taskId: string): Promise<void> {
    const st = this.requireAttached(kbId);
    const task = st.tasks.find((t) => t.taskId === taskId);
    if (!task) throw new WikiQueueError('taskNotFound', `任务不存在: ${taskId}`);
    if (!isRetryablePhase(task.phase) || task.kind !== 'compileSource') {
      throw new WikiQueueError('invalidPhase', `只有 failed/cancelled/blocked 任务可继续（当前 ${task.phase}）`);
    }
    const visionCode = task.lastError?.code;
    if (
      visionCode !== 'visionNotConfigured' &&
      visionCode !== 'visionFailed' &&
      visionCode !== 'visionBatchLimit'
    ) {
      throw new WikiQueueError('invalidPhase', `只有视觉受阻的任务可仅按文字继续（lastError=${visionCode ?? '无'}）`);
    }
    const prev = cloneTask(task);
    task.textOnly = true;
    task.phase = 'queued';
    task.attempt += 1;
    task.attemptId = randomUUID();
    task.updatedAt = new Date().toISOString();
    this.pushTaskEvent(task);
    try {
      await this.flush();
    } catch (err) {
      Object.assign(task, prev);
      throw err;
    }
    this.schedulePump();
  }

  /** 在 queued 子序列内上/下移（非 queued 任务是固定点）。返回是否移动。 */
  async moveTask(kbId: string, taskId: string, direction: 'up' | 'down'): Promise<boolean> {
    const st = this.requireAttached(kbId);
    const idx = st.tasks.findIndex((t) => t.taskId === taskId);
    if (idx === -1) throw new WikiQueueError('taskNotFound', `任务不存在: ${taskId}`);
    if (st.tasks[idx]!.phase !== 'queued') return false;

    const step = direction === 'up' ? -1 : 1;
    let target = -1;
    for (let i = idx + step; i >= 0 && i < st.tasks.length; i += step) {
      if (st.tasks[i]!.phase === 'queued') {
        target = i;
        break;
      }
    }
    if (target === -1) return false;

    const moving = st.tasks[idx]!;
    st.tasks[idx] = st.tasks[target]!;
    st.tasks[target] = moving;
    this.pushQueueEvent();
    try {
      await this.flush();
    } catch (err) {
      st.tasks[target] = st.tasks[idx]!;
      st.tasks[idx] = moving;
      throw err;
    }
    return true;
  }

  /** 清除 done 任务（failed/cancelled 保留供查看与重试）。返回清除数。 */
  async clearFinished(kbId: string): Promise<number> {
    const st = this.requireAttached(kbId);
    const kept = st.tasks.filter((t) => t.phase !== 'done');
    const removed = st.tasks.length - kept.length;
    if (removed === 0) return 0;
    const prevTasks = st.tasks;
    st.tasks = kept;
    this.pushQueueEvent();
    try {
      await this.flush();
    } catch (err) {
      st.tasks = prevTasks;
      throw err;
    }
    return removed;
  }

  /** worker 并发上限（clamp [1,5]；运行态设置，不持久）。 */
  setWorkerLimit(limit: number): void {
    const n = Math.floor(limit);
    this.workerLimit = Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1;
    this.schedulePump();
  }

  /** 队列快照（重订阅先拉快照）。未附着/身份不符返回 null。 */
  snapshot(kbId: string): WikiQueueSnapshot | null {
    const st = this.state;
    if (!st || st.kbId !== kbId) return null;
    return {
      kbId: st.kbId,
      paused: st.paused,
      seq: st.seq,
      restoredWaiting: st.restoredWaiting,
      lastPersistError: st.lastPersistError,
      tasks: st.tasks.map(cloneTask),
    };
  }

  // ── 调度 ──

  private requireAttached(kbId: string): QueueState {
    const st = this.state;
    if (!st) throw new WikiQueueError('notAttached', '队列未附着到任何库');
    if (st.kbId !== kbId) throw new WikiQueueError('kbIdMismatch', `队列附着的是 ${st.kbId}，请求的是 ${kbId}`);
    return st;
  }

  /** 按 attempt 释放运行槽位：迟到结算不得释放新一轮运行（attempt 失效语义） */
  private releaseInflight(taskId: string, attemptId: string): void {
    const current = this.inflight.get(taskId);
    if (current && current.attemptId === attemptId) this.inflight.delete(taskId);
  }

  /** 调度宏任务化：入队/重试等操作返回时任务停在 queued，由 worker 异步接手 */
  private schedulePump(): void {
    setTimeout(() => this.pump(), 0);
  }

  private pump(): void {
    const st = this.state;
    if (!st) return;
    this.reconcileOrphans();
    if (st.paused || st.restoredWaiting || st.lastPersistError) return;
    while (this.inflight.size < this.workerLimit) {
      const next = st.tasks.find((t) => t.phase === 'queued' && !this.inflight.has(t.taskId));
      if (!next) break;
      this.startRun(next);
    }
  }

  /** 自愈：无运行实例的活动阶段任务（如卸载竞态残留）重排 queued。 */
  private reconcileOrphans(): void {
    const st = this.state;
    if (!st) return;
    let dirty = false;
    for (const t of st.tasks) {
      if ((RUNNABLE_PHASES.has(t.phase) || t.phase === 'committing') && !this.inflight.has(t.taskId)) {
        t.phase = 'queued';
        t.attempt += 1;
        t.attemptId = randomUUID();
        t.updatedAt = new Date().toISOString();
        this.pushTaskEvent(t);
        dirty = true;
      }
    }
    if (dirty) void this.flush().catch(() => undefined);
  }

  private startRun(task: WikiIngestTask): void {
    const entry: InflightRun = {
      taskId: task.taskId,
      attemptId: task.attemptId,
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    this.inflight.set(task.taskId, entry);
    entry.promise = this.executeRun(task.taskId, entry.attemptId, entry.controller);
  }

  private async executeRun(taskId: string, attemptId: string, controller: AbortController): Promise<void> {
    const st = this.state;
    if (!st) {
      this.releaseInflight(taskId, attemptId);
      return;
    }
    const task = st.tasks.find((t) => t.taskId === taskId);
    if (!task || task.phase !== 'queued' || task.attemptId !== attemptId) {
      this.releaseInflight(taskId, attemptId);
      return;
    }
    task.phase = 'converting';
    task.updatedAt = new Date().toISOString();
    this.pushTaskEvent(task);
    try {
      await this.flush();
    } catch {
      // 持久化失败：不启动真实转换（工作不可记录），任务回 queued 等调度恢复
      const t2 = this.state?.tasks.find((x) => x.taskId === taskId);
      if (t2 && t2.attemptId === attemptId && t2.phase === 'converting') {
        t2.phase = 'queued';
      }
      this.releaseInflight(taskId, attemptId);
      return;
    }

    const kbPath = st.kbPath;
    const sourceId = task.sourceId;
    let outcome: RunOutcome;
    try {
      if (task.kind === 'compileSource') {
        outcome = await this.runCompile(task, attemptId, controller);
      } else {
        outcome = await convertWikiSource(kbPath, sourceId, {
          signal: controller.signal,
          onCommitting: () => this.markCommitting(taskId, attemptId),
        });
      }
    } catch (err) {
      outcome =
        err instanceof WikiSourceAbortedError
          ? 'aborted'
          : { ok: false, error: { code: 'ioError', message: String(err) } };
    }
    await this.settleRun(taskId, attemptId, outcome);
  }

  /**
   * 短来源编译运行：确保转换就绪（幂等）→ 分析 → 生成 → 校验/staging。
   * 取消经 controller.signal 贯穿（转换与模型调用都可中止）；
   * 阶段事件近似推进（analyzing → generating → validating），
   * 取消/暂停的正确性只依赖 signal，不依赖阶段显示。
   */
  private async runCompile(task: WikiIngestTask, attemptId: string, controller: AbortController): Promise<RunOutcome> {
    const st = this.state;
    if (!st) return 'aborted';
    const kbPath = st.kbPath;

    // 1) 来源就绪保障：已转换且同指纹时是 no-op
    try {
      const conv = await convertWikiSource(kbPath, task.sourceId, { signal: controller.signal });
      if (!conv.ok) {
        return { ok: false, error: { code: 'ioError', message: `来源转换失败: ${conv.error.message}` } };
      }
    } catch (err) {
      if (err instanceof WikiSourceAbortedError) return 'aborted';
      return { ok: false, error: { code: 'ioError', message: String(err) } };
    }
    if (controller.signal.aborted) return 'aborted';

    // 迟到回调边界（issue 13）：取消/暂停/卸载会先行释放 inflight 槽位，
    // 之后到达的阶段/进度回调不得复活任务（attempt 失效语义的运行态部分）
    const runActive = (): boolean => {
      const run = this.inflight.get(task.taskId);
      return run !== undefined && run.attemptId === attemptId;
    };

    const setPhase = (phase: WikiIngestPhase): void => {
      const t = st.tasks.find((x) => x.taskId === task.taskId);
      if (!t || t.attemptId !== attemptId || !runActive()) return;
      t.phase = phase;
      t.updatedAt = new Date().toISOString();
      this.pushTaskEvent(t);
      void this.flush().catch(() => undefined);
    };

    setPhase('analyzing');

    // 2) 模型入口：每次 attempt 解析一次配置快照（调用方显式传入编译管线）
    let llm: CompileLlm | null = null;
    let visionLlm: VisionLlm | null = null;
    try {
      llm = await this.compileLlmFactory(controller.signal);
      visionLlm = await this.visionLlmFactory(controller.signal);
    } catch (err) {
      return { ok: false, error: { code: 'ioError', message: `解析模型配置失败: ${String(err)}` } };
    }
    if (controller.signal.aborted) return 'aborted';

    // 编译内阶段（vision/analyzing）由 onPhaseChange 驱动（issue 12）；
    // generating/validating 仍为近似推进（编译成功前的显示语义）
    const result = await compileWikiSource(
      kbPath,
      { kbId: st.kbId, taskId: task.taskId, sourceId: task.sourceId },
      {
        llm,
        visionLlm,
        // 用户显式选择仅按文字继续（issue 12）：视觉缺口不阻止编译，提案标 partial
        textOnly: task.textOnly === true,
        signal: controller.signal,
        // vision 阶段推进（issue 12）：解读开始 → vision，进入文本分析 → analyzing
        onPhaseChange: (phase) => setPhase(phase),
        // 逐张解读进度（issue 12/13）：与分段进度同一形状（done/total/reused）
        onVisionProgress: (progress) => {
          const t = st.tasks.find((x) => x.taskId === task.taskId);
          if (!t || t.attemptId !== attemptId || !runActive()) return;
          t.phase = 'vision';
          t.progress = { ...progress };
          t.updatedAt = new Date().toISOString();
          this.pushTaskEvent(t);
          void this.flush().catch(() => undefined);
        },
        // 分段进度（长来源，issue 10）：phase 与进度分开保存，事件即时可见
        onChunkProgress: (progress) => {
          const t = st.tasks.find((x) => x.taskId === task.taskId);
          if (!t || t.attemptId !== attemptId || !runActive()) return;
          // 分段分析是长来源的主要耗时阶段：进度回调即证明仍在 analyzing
          t.phase = 'analyzing';
          t.progress = { ...progress };
          t.updatedAt = new Date().toISOString();
          this.pushTaskEvent(t);
          void this.flush().catch(() => undefined);
        },
      },
    );
    if (result.ok) {
      setPhase('validating');
      return result;
    }
    // 统一失败形状为 { ok:false, error }（与 SourceConvertOutcome 一致）；
    // 诊断（已完成阶段 usage / 内部重试数）一并带出给任务面板（issue 09）
    return {
      ok: false,
      error: { code: result.code, message: result.message },
      usage: result.diagnostics.usage,
      retryCount: result.diagnostics.retryCount,
    };
  }

  private markCommitting(taskId: string, attemptId: string): void {
    const st = this.state;
    if (!st) return;
    const task = st.tasks.find((t) => t.taskId === taskId);
    if (!task || task.attemptId !== attemptId || task.phase !== 'converting') return;
    task.phase = 'committing';
    task.updatedAt = new Date().toISOString();
    this.pushTaskEvent(task);
    void this.flush().catch(() => undefined);
  }

  private async settleRun(taskId: string, attemptId: string, outcome: RunOutcome): Promise<void> {
    this.releaseInflight(taskId, attemptId);
    const st = this.state;
    if (!st) return;
    const task = st.tasks.find((t) => t.taskId === taskId);
    // attempt 失效或任务已被重排/取消：迟到的结果一律忽略
    if (!task || task.attemptId !== attemptId) return;
    if (!RUNNABLE_PHASES.has(task.phase) && task.phase !== 'committing') return;
    if (outcome === 'aborted') return;

    const now = new Date().toISOString();
    task.updatedAt = now;
    // 编译结果携带 usage/retryCount；转换结果没有这两个字段（保持 null/0）
    const usage = 'usage' in outcome ? outcome.usage : undefined;
    const taskRetryCount = 'retryCount' in outcome ? outcome.retryCount : undefined;
    if (outcome.ok) {
      task.phase = 'done';
      task.lastError = null;
      // 本次 attempt 的用量与内部重试数（issue 09：面板展示，不伪造缺失字段）
      task.usage = summarizeUsage(usage);
      task.retryCount = taskRetryCount ?? 0;
    } else {
      // 预算/配置不足/批次上限 → blocked（issue 10/12/13，spec §5）：等待用户
      // 提高预算、配置视觉模型、继续下一批或显式选择仅文字继续后重试，
      // 不是普通失败；不静默裁切来源、不冒充完整成功。
      task.phase =
        outcome.error.code === 'contextBudgetExceeded' ||
        outcome.error.code === 'visionNotConfigured' ||
        outcome.error.code === 'visionBatchLimit'
          ? 'blocked'
          : 'failed';
      task.lastError = { code: outcome.error.code, message: outcome.error.message, at: now };
      task.usage = summarizeUsage(usage);
      task.retryCount = taskRetryCount ?? 0;
    }
    // 结算后清空分段进度（终态不再显示中途进度）
    task.progress = null;
    this.pushTaskEvent(task);
    await this.flush().catch(() => undefined);
    this.pump();
  }

  // ── 持久化与事件 ──

  private pushTaskEvent(task: WikiIngestTask): void {
    const st = this.state;
    if (!st) return;
    st.seq += 1;
    this.pendingEvents.push({
      type: 'task',
      kbId: st.kbId,
      seq: st.seq,
      taskId: task.taskId,
      attemptId: task.attemptId,
      phase: task.phase,
      lastError: task.lastError ? { ...task.lastError } : null,
      usage: task.usage ? { ...task.usage } : null,
      retryCount: task.retryCount,
      progress: task.progress ? { ...task.progress } : null,
    });
  }

  private pushQueueEvent(): void {
    const st = this.state;
    if (!st) return;
    st.seq += 1;
    this.pendingEvents.push({
      type: 'queue',
      kbId: st.kbId,
      seq: st.seq,
      paused: st.paused,
      restoredWaiting: st.restoredWaiting,
    });
  }

  /** 持久化当前状态并冲刷事件。失败：lastPersistError 记录（调度暂停）并抛出。 */
  private async flush(): Promise<void> {
    const st = this.state;
    if (!st) return;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    const snapshot: PersistedQueue = {
      queueVersion: QUEUE_VERSION,
      kbId: st.kbId,
      paused: st.paused,
      seq: st.seq,
      tasks: st.tasks,
    };
    try {
      await this.persistSnapshot(st.kbPath, snapshot);
    } catch (err) {
      st.lastPersistError = String(err);
      throw new WikiQueueError('persistFailed', `队列持久化失败: ${String(err)}`);
    }
    st.lastPersistError = null;
    for (const e of events) this.notify?.(e);
  }

  private persistSnapshot(kbPath: string, snapshot: PersistedQueue): Promise<void> {
    const run = async (): Promise<void> => {
      await writeFileAtomic(queueFilePath(kbPath), JSON.stringify(snapshot, null, 2));
    };
    const result = this.persistChain.then(run, run);
    this.persistChain = result.catch(() => undefined);
    return result;
  }
}
