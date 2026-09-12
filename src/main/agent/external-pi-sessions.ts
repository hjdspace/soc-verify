/**
 * 外部 pi session 扫描与接管（issue 08）。
 *
 * pi 引擎把原生 session 存在用户级 `~/.pi/agent/sessions/<cwd bucket>/`，
 * 用户可能先在 pi TUI 或其他工具中产生过对话。本模块提供：
 *   - listExternalPiSessions —— 只读扫描指定 cwd bucket 的外部 session，
 *     去重（应用已索引的 engineSessionId + 经 parentSessionPath 链的祖先
 *     分支归属应用历史）后供 UI 展示；扫描本身绝不写应用索引；
 *   - adoptExternalPiSession —— 显式接管：注册应用会话（engine='pi'，
 *     engineSessionId = 原生 id，恢复走 issue 07 的原生恢复路径获得应用的
 *     extension/MCP/工具信任边界）+ 写 UI transcript 种子。接管前的确认
 *     提示由 UI 层承担，本 API 即确认后的显式动作。
 *
 * 扫描经一次性 CLI（runner-pi/session-scan.ts）执行：pi SDK 的 ESM 依赖
 * 不进入主进程，pi 原生消息形状不越出 runner 侧（issue 03 验收标准）。
 * stdout 帧以哨兵前缀输出，防 SDK 日志污染协议。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve as resolvePath } from 'node:path';
import { resolvePiSessionScanScript } from './paths';
import { addSession, loadSessions, type PersistedSession } from './session-persistence';
import { storedMessagesPath } from '../services/session-service';

/**
 * session-scan stdout 帧哨兵前缀 —— 必须与 runner-pi/session-scan.ts 的
 * SCAN_SENTINEL 一致（集成测试经真实 spawn 验证契约）。不从该文件导入：
 * 会把 ESM-only 的 pi SDK 拖进主进程 bundle。
 */
const SCAN_SENTINEL = '@@SOCVERIFY_SCAN@@';

// ─── 类型 ───────────────────────────────────────────────

/** 外部 pi session 元数据（session-scan list 输出的 JSON 安全子集） */
export type ExternalPiSession = {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  /** ISO 时间戳（session-scan 已序列化） */
  created?: string;
  modified?: string;
  messageCount?: number;
  firstMessage?: string;
};

/** session-scan 的一次调用请求（与 CLI 参数一一对应） */
export type ScanRequest = { mode: 'list'; cwd: string } | { mode: 'export'; file: string };

/** 扫描函数（可注入替身；默认实现为 spawn session-scan CLI） */
export type ScanFn = (req: ScanRequest) => Promise<unknown>;

// ─── 去重（纯逻辑） ─────────────────────────────────────

/** 路径归一化：绝对路径 + win32 大小写不敏感比较（bucket 内文件对账共用） */
export function normPath(p: string): string {
  const r = resolvePath(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * 去重：排除应用已索引的 engineSessionId，并沿 parentSessionPath 链排除
 * 这些会话的祖先文件 —— regenerate/fork 产生的旧分支是应用会话历史的一
 * 部分（可回看），不是"外部"会话。
 */
export function dedupeExternalSessions(
  scanResults: ExternalPiSession[],
  ownedEngineSessionIds: string[],
): ExternalPiSession[] {
  const owned = new Set(ownedEngineSessionIds);
  if (owned.size === 0) return scanResults;

  const byPath = new Map<string, ExternalPiSession>();
  for (const r of scanResults) byPath.set(normPath(r.path), r);

  const excluded = new Set(owned);
  for (const r of scanResults) {
    if (!owned.has(r.id)) continue;
    let cur = r.parentSessionPath;
    const seen = new Set<string>();
    while (cur && !seen.has(normPath(cur))) {
      const key = normPath(cur);
      seen.add(key);
      const parent = byPath.get(key);
      if (parent) excluded.add(parent.id);
      cur = parent?.parentSessionPath;
    }
  }
  return scanResults.filter((r) => !excluded.has(r.id));
}

// ─── transcript 种子（纯逻辑） ──────────────────────────

/** UI transcript 种子消息（ChatMessage 的最小合法形状，渲染端直接加载） */
export type SeedChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  images?: string[];
};

/**
 * session-scan export 的归一化消息 → UI transcript 种子。
 * 空文本且无图片的消息（纯 toolCall/thinking turn）跳过；缺 timestamp 时
 * 用 base + 序号的兜底时间戳保持对话顺序。
 */
export function buildSeedTranscript(
  scanMessages: Array<{ role: string; text: string; timestamp?: number; images?: string[] }>,
  baseTimestamp = Date.now(),
): SeedChatMessage[] {
  const out: SeedChatMessage[] = [];
  let i = 0;
  for (const m of scanMessages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!m.text && !(m.images && m.images.length > 0)) continue;
    out.push({
      id: `msg_${baseTimestamp}_${i}`,
      role: m.role,
      content: m.text,
      timestamp: typeof m.timestamp === 'number' ? m.timestamp : baseTimestamp + i,
      images: m.images && m.images.length > 0 ? m.images : undefined,
    });
    i++;
  }
  return out;
}

// ─── spawn 封装 ─────────────────────────────────────────

export type RunScanOptions = {
  /** 传给子进程的额外环境变量（如 PI_CODING_AGENT_DIR 隔离测试） */
  env?: Record<string, string>;
  timeoutMs?: number;
};

/**
 * 运行一次 session-scan CLI 并解析结果。成功返回帧的 data，失败抛错
 * （含 CLI 错误信息或超时说明）。
 */
export async function runPiSessionScan(req: ScanRequest, opts: RunScanOptions = {}): Promise<unknown> {
  const script = resolvePiSessionScanScript();
  if (!script) {
    throw new Error('pi session-scan script not found (runner-pi/session-scan.ts)');
  }

  const scriptArgs = req.mode === 'list' ? ['list', '--cwd', req.cwd] : ['export', '--file', req.file];
  const child = spawn(process.execPath, [script, ...scriptArgs], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => {
    child.kill();
  }, timeoutMs);
  timer.unref?.();

  try {
    const stdoutLines: string[] = [];
    const stderrTail: string[] = [];
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line: string) => stdoutLines.push(line));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail.push(chunk.toString());
      if (stderrTail.length > 20) stderrTail.shift();
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });

    // 只认哨兵行（SDK 日志污染免疫）；取最后一条（多次输出时以最后为准）
    const sentinelLines = stdoutLines.filter((l) => l.startsWith(SCAN_SENTINEL));
    if (sentinelLines.length === 0) {
      const stderr = stderrTail.join('').trim();
      throw new Error(
        `session-scan produced no result frame (exit=${exitCode})${stderr ? `: ${stderr.slice(-500)}` : ''}`,
      );
    }
    const frame = JSON.parse(sentinelLines[sentinelLines.length - 1]!.slice(SCAN_SENTINEL.length)) as {
      ok: boolean;
      data?: unknown;
      error?: string;
      mode?: string;
    };
    if (!frame.ok) {
      throw new Error(frame.error ?? 'session-scan failed');
    }
    return frame.data;
  } finally {
    clearTimeout(timer);
  }
}

/** 默认扫描函数（spawn CLI） */
const defaultScan: ScanFn = (req) => runPiSessionScan(req);

// ─── 列表 / 接管 ────────────────────────────────────────

/**
 * 列出 cwd bucket 中不属于应用的外部 pi session（只读）。
 * owned 判定：应用索引中 engine='pi' 且 engineSessionId 命中的会话，
 * 加上它们的 parentSessionPath 祖先链。
 */
export async function listExternalPiSessions(
  projectRoot: string,
  cwd: string,
  scan: ScanFn = defaultScan,
): Promise<ExternalPiSession[]> {
  const data = (await scan({ mode: 'list', cwd })) as { sessions?: ExternalPiSession[] };
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];

  const persisted = await loadSessions(projectRoot);
  const ownedIds = persisted
    .filter((s) => s.engine === 'pi' && s.engineSessionId)
    .map((s) => s.engineSessionId as string);

  return dedupeExternalSessions(sessions, ownedIds);
}

export type AdoptExternalPiSessionInput = {
  projectId: string;
  /** 会话的原生 cwd（恢复时的 bucket cwd，绝不回退改写） */
  cwd: string;
  /** pi 原生 session id（engineSessionId 以 bucket 扫描到的文件 header id 为准，此值仅作兜底） */
  nativeSessionId: string;
  /** 原生 session 文件路径（export 种子 transcript 用） */
  sessionFilePath: string;
  /** 展示名；缺省取首条消息截断 */
  name?: string;
};

export type AdoptExternalPiSessionResult = {
  session: PersistedSession;
  transcriptCount: number;
};

/** 展示名截断长度 */
const MAX_NAME_LENGTH = 24;

/**
 * 显式接管一个外部 pi session：
 *   0. 信任边界校验：sessionFilePath 必须出现在该 cwd bucket 的扫描结果中
 *      （防渲染端让 host 读取任意文件），engineSessionId 以文件 header id 为准；
 *   1. export 原生对话内容并归一化为 UI transcript 种子；
 *   2. 注册应用会话（engine='pi'，engineSessionId = 原生 id —— 首次打开走
 *      issue 07 原生恢复，获得应用的 extension/MCP/工具信任边界）；
 *   3. 写 UI transcript 文件（幂等：同一原生会话重复接管复用已有索引项）。
 *
 * 确认提示由 UI 层在调用本 API 之前完成。
 */
export async function adoptExternalPiSession(
  projectRoot: string,
  input: AdoptExternalPiSessionInput,
  scan: ScanFn = defaultScan,
): Promise<AdoptExternalPiSessionResult> {
  // 信任边界：sessionFilePath 必须出现在该 cwd bucket 的扫描结果中 ——
  // 渲染端不能让 host 读取并落盘任意路径的文件内容。engineSessionId 以
  // 扫描到的原生文件 id 为准（与文件始终保持一致，防调用方传值漂移）。
  const listed = (await scan({ mode: 'list', cwd: input.cwd })) as {
    sessions?: ExternalPiSession[];
  };
  const listedSessions = Array.isArray(listed?.sessions) ? listed.sessions : [];
  const target = listedSessions.find((s) => normPath(s.path) === normPath(input.sessionFilePath));
  if (!target) {
    throw new Error(
      `session file is not in the ${input.cwd} bucket scan results: ${input.sessionFilePath}`,
    );
  }
  const nativeSessionId = target.id || input.nativeSessionId;

  // 已接管过 → 幂等返回已有索引项（transcript 不覆盖：可能已有新 turn）
  const existing = await loadSessions(projectRoot);
  const already = existing.find(
    (s) => s.engine === 'pi' && s.engineSessionId === nativeSessionId,
  );
  if (already) {
    return { session: already, transcriptCount: 0 };
  }

  const data = (await scan({ mode: 'export', file: input.sessionFilePath })) as {
    messages?: Array<{ role: string; text: string; timestamp?: number; images?: string[] }>;
  };
  const seed = buildSeedTranscript(Array.isArray(data?.messages) ? data.messages : []);

  const now = Date.now();
  const session: PersistedSession = {
    sessionId: `session_${now}_${randomUUID().slice(0, 8)}`,
    engine: 'pi',
    engineSessionId: nativeSessionId,
    cwd: input.cwd,
    name:
      input.name ??
      (seed.find((m) => m.role === 'user')?.content ?? nativeSessionId).slice(0, MAX_NAME_LENGTH),
    projectId: input.projectId,
    createdAt: now,
    lastActivityAt: now,
  };
  await addSession(projectRoot, session);

  if (seed.length > 0) {
    const dir = resolvePath(projectRoot, '.socverify', 'chat-messages');
    await mkdir(dir, { recursive: true });
    await writeFile(
      storedMessagesPath(projectRoot, session.sessionId),
      JSON.stringify(seed, null, 2),
      'utf-8',
    );
  }

  return { session, transcriptCount: seed.length };
}
