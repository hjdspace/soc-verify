/**
 * external-pi-sessions（issue 08）—— 外部 pi session 扫描去重、接管注册、
 * transcript 种子、spawn 封装。
 *
 * 验收标准（.scratch/pi-engine-migration/issues/08）：
 *   - 外部 pi session 扫描只读执行，提取 metadata，去重（排除应用已索引的
 *     engineSessionId 及其经 parentSessionPath 链的祖先分支），不自动写入
 *     应用索引 —— 写入只发生在显式接管（adopt）；
 *   - 接管 = 注册应用会话（engine='pi' + 原生 engineSessionId + cwd）+
 *     种子 UI transcript；确认提示由 UI 层承担，host API 即显式动作。
 *
 * spawn 封装（runPiSessionScan）以真实 node 子进程跑 runner-pi/session-scan.ts
 * （集成路径：哨兵帧解析 + PI_CODING_AGENT_DIR 隔离），其余为纯逻辑/临时目录测试。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptExternalPiSession,
  buildSeedTranscript,
  dedupeExternalSessions,
  listExternalPiSessions,
  runPiSessionScan,
  type ExternalPiSession,
} from '../../src/main/agent/external-pi-sessions';
import { loadSessions, saveSessions } from '../../src/main/agent/session-persistence';

function makeExternal(overrides: Partial<ExternalPiSession> = {}): ExternalPiSession {
  return {
    id: 'pi-ext-1',
    path: '/bucket/pi-ext-1.jsonl',
    cwd: '/proj/dv',
    messageCount: 4,
    firstMessage: '外部会话第一条',
    ...overrides,
  };
}

/** 扫描替身：list 返回给定清单，export 校验 file 在清单内后返回给定消息。 */
function fakeScan(list: ExternalPiSession[], exported: unknown) {
  const listedPaths = new Set(list.map((s) => s.path));
  return async (req: { mode: string; file?: string }) => {
    if (req.mode === 'list') return { sessions: list };
    if (req.mode === 'export') {
      expect(listedPaths.has(req.file ?? '')).toBe(true);
      return exported;
    }
    throw new Error(`unexpected mode: ${req.mode}`);
  };
}

// ─── 去重 ─────────────────────────────────────────────────

describe('dedupeExternalSessions', () => {
  it('排除应用已索引的 engineSessionId', () => {
    const scan = [makeExternal({ id: 'pi-owned-1' }), makeExternal({ id: 'pi-ext-2', path: '/bucket/2.jsonl' })];
    const out = dedupeExternalSessions(scan, ['pi-owned-1']);
    expect(out.map((s) => s.id)).toEqual(['pi-ext-2']);
  });

  it('排除 owned 会话经 parentSessionPath 的祖先分支（regenerate/fork 旧文件归属应用历史）', () => {
    const grandparent = makeExternal({ id: 'pi-gp', path: '/bucket/gp.jsonl' });
    const parent = makeExternal({ id: 'pi-parent', path: '/bucket/parent.jsonl', parentSessionPath: '/bucket/gp.jsonl' });
    const owned = makeExternal({ id: 'pi-owned-1', path: '/bucket/owned.jsonl', parentSessionPath: '/bucket/parent.jsonl' });
    const stranger = makeExternal({ id: 'pi-stranger', path: '/bucket/stranger.jsonl' });

    const out = dedupeExternalSessions([grandparent, parent, owned, stranger], ['pi-owned-1']);
    expect(out.map((s) => s.id)).toEqual(['pi-stranger']);
  });

  it('祖先文件不在扫描结果中时安全终止（不误伤其余结果）', () => {
    const owned = makeExternal({ id: 'pi-owned-1', path: '/bucket/owned.jsonl', parentSessionPath: '/elsewhere/missing.jsonl' });
    const stranger = makeExternal({ id: 'pi-stranger', path: '/bucket/stranger.jsonl' });

    const out = dedupeExternalSessions([owned, stranger], ['pi-owned-1']);
    expect(out.map((s) => s.id)).toEqual(['pi-stranger']);
  });

  it('无 owned id 时全部保留', () => {
    const scan = [makeExternal({ id: 'a', path: '/a.jsonl' }), makeExternal({ id: 'b', path: '/b.jsonl' })];
    expect(dedupeExternalSessions(scan, [])).toHaveLength(2);
  });
});

// ─── transcript 种子 ──────────────────────────────────────

describe('buildSeedTranscript', () => {
  it('映射 role/text/timestamp，生成稳定 id', () => {
    const out = buildSeedTranscript([
      { role: 'user', text: '第一条', timestamp: 1000 },
      { role: 'assistant', text: '第一条回复', timestamp: 2000 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: 'user', content: '第一条', timestamp: 1000 });
    expect(out[1]).toMatchObject({ role: 'assistant', content: '第一条回复', timestamp: 2000 });
    expect(new Set(out.map((m) => m.id)).size).toBe(2);
  });

  it('图片透传为 images 数组；空文本且无图片的消息跳过', () => {
    const out = buildSeedTranscript([
      { role: 'user', text: '', timestamp: 1 },
      { role: 'user', text: '看图', timestamp: 2, images: ['data:image/png;base64,abc'] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ content: '看图', images: ['data:image/png;base64,abc'] });
  });

  it('缺 timestamp 时用递增兜底时间戳（保持顺序）', () => {
    const out = buildSeedTranscript([
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
    ]);
    expect(out[0].timestamp).toBeLessThan(out[1].timestamp);
    expect(typeof out[0].timestamp).toBe('number');
  });
});

// ─── 列表（扫描 + 去重） ──────────────────────────────────

describe('listExternalPiSessions', () => {
  let projectRoot = '';

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socv-ext-pi-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('应用索引中的 pi 会话及其祖先被排除，其余外部会话返回', async () => {
    const parent = makeExternal({ id: 'pi-parent', path: '/bucket/parent.jsonl' });
    const owned = makeExternal({ id: 'pi-owned-1', path: '/bucket/owned.jsonl', parentSessionPath: '/bucket/parent.jsonl' });
    const stranger = makeExternal({ id: 'pi-stranger', path: '/bucket/stranger.jsonl' });

    // 应用索引已拥有 pi-owned-1（接管/新建过的 pi 会话）
    await saveSessions(projectRoot, [
      {
        sessionId: 'app-1',
        engine: 'pi',
        engineSessionId: 'pi-owned-1',
        cwd: '/proj/dv',
        name: '应用会话',
        projectId: 'proj-1',
        createdAt: 1,
        lastActivityAt: 1,
      },
    ]);

    const scan = async (req: { mode: string }) => {
      if (req.mode === 'list') return { sessions: [parent, owned, stranger] };
      throw new Error('unexpected export');
    };

    const out = await listExternalPiSessions(projectRoot, '/proj/dv', scan);
    expect(out.map((s) => s.id)).toEqual(['pi-stranger']);
  });

  it('扫描失败向上抛错（router 转 TRPCError 展示）', async () => {
    const scan = async () => {
      throw new Error('scan exploded');
    };
    await expect(listExternalPiSessions(projectRoot, '/proj/dv', scan)).rejects.toThrow('scan exploded');
  });
});

// ─── 接管（显式动作：注册 + 种子 transcript）─────────────

describe('adoptExternalPiSession', () => {
  let projectRoot = '';

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socv-adopt-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('注册应用会话（engine=pi + 原生 engineSessionId + cwd）并写种子 transcript', async () => {
    const scan = fakeScan(
      [makeExternal({ id: 'pi-ext-1', path: '/bucket/pi-ext-1.jsonl', cwd: '/proj/dv' })],
      {
        messages: [
          { role: 'user', text: '外部第一条', timestamp: 1000 },
          { role: 'assistant', text: '外部第一条回复', timestamp: 2000 },
        ],
      },
    );

    const { session, transcriptCount } = await adoptExternalPiSession(
      projectRoot,
      {
        projectId: 'proj-1',
        cwd: '/proj/dv',
        nativeSessionId: 'pi-ext-1',
        sessionFilePath: '/bucket/pi-ext-1.jsonl',
        name: '外部会话',
      },
      scan,
    );

    expect(session.engine).toBe('pi');
    expect(session.engineSessionId).toBe('pi-ext-1');
    expect(session.cwd).toBe('/proj/dv');
    expect(session.name).toBe('外部会话');
    expect(session.projectId).toBe('proj-1');
    expect(transcriptCount).toBe(2);

    // 应用索引已写入
    const index = await loadSessions(projectRoot);
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ sessionId: session.sessionId, engine: 'pi', engineSessionId: 'pi-ext-1' });

    // transcript 文件已写入
    const raw = await readFile(
      join(projectRoot, '.socverify', 'chat-messages', `${session.sessionId}.json`),
      'utf-8',
    );
    const messages = JSON.parse(raw) as Array<{ role: string; content: string; timestamp: number }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: '外部第一条', timestamp: 1000 });
  });

  it('name 缺省时取 firstMessage 截断', async () => {
    const scan = fakeScan([makeExternal({ id: 'pi-1', path: '/f.jsonl', cwd: '/c' })], {
      messages: [{ role: 'user', text: '这是一条非常非常非常长的第一条消息超出二十个字的截断边界', timestamp: 1 }],
    });
    const { session } = await adoptExternalPiSession(
      projectRoot,
      { projectId: 'p', cwd: '/c', nativeSessionId: 'pi-1', sessionFilePath: '/f.jsonl' },
      scan,
    );
    expect(session.name.length).toBeLessThanOrEqual(24);
    expect(session.name.startsWith('这是一条非常')).toBe(true);
  });

  it('重复接管同一原生 session → 幂等（不产生重复索引项）', async () => {
    const scan = fakeScan([makeExternal({ id: 'pi-1', path: '/f.jsonl', cwd: '/c' })], {
      messages: [{ role: 'user', text: 'hi', timestamp: 1 }],
    });
    const input = { projectId: 'p', cwd: '/c', nativeSessionId: 'pi-1', sessionFilePath: '/f.jsonl' };
    const first = await adoptExternalPiSession(projectRoot, input, scan);
    const second = await adoptExternalPiSession(projectRoot, input, scan);
    expect(second.session.sessionId).toBe(first.session.sessionId);
    const index = await loadSessions(projectRoot);
    expect(index).toHaveLength(1);
  });

  it('sessionFilePath 不在 cwd bucket 扫描结果中 → 拒绝接管（信任边界：不得读取任意文件）', async () => {
    const scan = async (req: { mode: string }) => {
      if (req.mode === 'list') {
        return { sessions: [makeExternal({ id: 'pi-real', path: '/bucket/pi-real.jsonl' })] };
      }
      throw new Error('unexpected export');
    };
    await expect(
      adoptExternalPiSession(
        projectRoot,
        { projectId: 'p', cwd: '/proj/dv', nativeSessionId: 'pi-real', sessionFilePath: '/elsewhere/evil.jsonl' },
        scan,
      ),
    ).rejects.toThrow(/bucket scan/i);
    const index = await loadSessions(projectRoot);
    expect(index).toHaveLength(0);
  });

  it('engineSessionId 以 bucket 扫描到的文件 id 为准（不受调用方传入值影响）', async () => {
    const scan = fakeScan([makeExternal({ id: 'pi-file-id', path: '/bucket/real.jsonl', cwd: '/c' })], {
      messages: [{ role: 'user', text: 'hi', timestamp: 1 }],
    });
    const { session } = await adoptExternalPiSession(
      projectRoot,
      { projectId: 'p', cwd: '/c', nativeSessionId: 'stale-id', sessionFilePath: '/bucket/real.jsonl' },
      scan,
    );
    expect(session.engineSessionId).toBe('pi-file-id');
  });
});

// ─── spawn 封装（集成：真实 node + session-scan.ts）──────

describe('runPiSessionScan（集成）', () => {
  let agentDir = '';

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'socv-scan-agent-'));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it('list：真实子进程输出哨兵帧并解析为数据', async () => {
    const data = (await runPiSessionScan(
      { mode: 'list', cwd: '/definitely/nonexistent-cwd' },
      { env: { PI_CODING_AGENT_DIR: agentDir }, timeoutMs: 60_000 },
    )) as { sessions: unknown[] };
    expect(Array.isArray(data.sessions)).toBe(true);
  });

  it('脚本级错误 → 拒绝并携带错误信息', { timeout: 30_000 }, async () => {
    await expect(
      runPiSessionScan({ mode: 'export', file: '/definitely/missing.jsonl' }, {
        env: { PI_CODING_AGENT_DIR: agentDir },
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/session file not found/i);
  });
});
