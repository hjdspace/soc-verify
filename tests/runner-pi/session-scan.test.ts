/**
 * runner-pi session-scan（issue 08）—— 外部 pi session 只读扫描 CLI。
 *
 * 验收标准（.scratch/pi-engine-migration/issues/08）：
 *   - 外部 pi session 扫描只读执行，提取 metadata，去重后供 host 展示；
 *     扫描本身不写入应用索引（写入是 adopt 的显式动作）。
 *
 * 设计：
 *   - 独立一次性 CLI（host 以 node + ELECTRON_RUN_AS_NODE spawn），与常驻
 *     runner 分离 —— 扫描不要求 runner 进程活着；
 *   - stdout 帧加哨兵前缀（SCAN_SENTINEL），防 pi SDK 偶发日志污染协议；
 *   - list 模式：SessionManager.list(cwd) → SessionInfo 元数据（JSON 安全
 *     映射，丢弃重量级 allMessagesText）；
 *   - export 模式：SessionManager.open(file) → buildSessionContext() →
 *     归一化为 UI transcript 可直接消费的 { role, text, timestamp, images }。
 *
 * 通过 vi.mock 隔离 pi SDK（同 session-recovery.test.ts 模式）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionManagerList = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
const sessionManagerOpen = vi.fn();
const existsSyncMock = vi.fn((..._args: unknown[]) => true);

vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: {
    list: (...args: unknown[]) => sessionManagerList(...args),
    open: (...args: unknown[]) => sessionManagerOpen(...args),
  },
}));

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
}));

const scan = await import('../../runner-pi/session-scan');

// ─── 哨兵帧格式 ───────────────────────────────────────────

describe('session-scan 帧格式', () => {
  it('formatScanFrame：哨兵前缀 + 单行 JSON + 换行', () => {
    const line = scan.formatScanFrame({ ok: true, mode: 'list', data: { sessions: [] } });
    expect(line.startsWith(scan.SCAN_SENTINEL)).toBe(true);
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.slice(scan.SCAN_SENTINEL.length)) as Record<string, unknown>;
    expect(parsed).toEqual({ ok: true, mode: 'list', data: { sessions: [] } });
  });
});

// ─── 参数解析 ─────────────────────────────────────────────

describe('parseScanArgs', () => {
  it('list 模式：--cwd 空格分隔', () => {
    expect(scan.parseScanArgs(['list', '--cwd', '/proj/dv'])).toEqual({ mode: 'list', cwd: '/proj/dv' });
  });

  it('list 模式：--cwd= 等号形式', () => {
    expect(scan.parseScanArgs(['list', '--cwd=/proj/dv'])).toEqual({ mode: 'list', cwd: '/proj/dv' });
  });

  it('export 模式：--file 指定 session 文件', () => {
    expect(scan.parseScanArgs(['export', '--file', '/bucket/s1.jsonl'])).toEqual({
      mode: 'export',
      file: '/bucket/s1.jsonl',
    });
  });

  it('缺参数 / 未知模式 / 空 argv 返回 null', () => {
    expect(scan.parseScanArgs([])).toBeNull();
    expect(scan.parseScanArgs(['list'])).toBeNull();
    expect(scan.parseScanArgs(['export'])).toBeNull();
    expect(scan.parseScanArgs(['frobnicate', '--cwd', '/p'])).toBeNull();
    expect(scan.parseScanArgs(['list', '--cwd'])).toBeNull();
  });
});

// ─── export 消息归一化 ────────────────────────────────────

describe('normalizeScanMessages', () => {
  it('user string content → { role, text, timestamp }', () => {
    const out = scan.normalizeScanMessages([
      { role: 'user', content: '跑一下仿真', timestamp: 1000 },
    ]);
    expect(out).toEqual([{ role: 'user', text: '跑一下仿真', timestamp: 1000, images: undefined }]);
  });

  it('assistant 混合 blocks：只保留 text，丢弃 thinking/toolCall', () => {
    const out = scan.normalizeScanMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部推理' },
          { type: 'text', text: '结论一' },
          { type: 'toolCall', id: 't1', name: 'bash', arguments: {} },
          { type: 'text', text: '结论二' },
        ],
        timestamp: 2000,
      },
    ]);
    expect(out).toEqual([{ role: 'assistant', text: '结论一\n结论二', timestamp: 2000, images: undefined }]);
  });

  it('user 图片块 → data URL 形式的 images 数组', () => {
    const out = scan.normalizeScanMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image', data: 'abc123', mimeType: 'image/png' },
        ],
        timestamp: 3000,
      },
    ]);
    expect(out).toEqual([
      {
        role: 'user',
        text: '看这张图',
        timestamp: 3000,
        images: ['data:image/png;base64,abc123'],
      },
    ]);
  });

  it('非 user/assistant 消息（toolResult 等）跳过；缺 timestamp 输出 undefined', () => {
    const out = scan.normalizeScanMessages([
      { role: 'toolResult', content: [], timestamp: 1 },
      { role: 'custom', customType: 'x' },
      { role: 'assistant', content: [{ type: 'text', text: '无时间戳' }] },
    ]);
    expect(out).toEqual([{ role: 'assistant', text: '无时间戳', timestamp: undefined, images: undefined }]);
  });
});

// ─── runScan ──────────────────────────────────────────────

describe('runScan', () => {
  beforeEach(() => {
    sessionManagerList.mockReset().mockResolvedValue([]);
    sessionManagerOpen.mockReset();
    existsSyncMock.mockReset().mockReturnValue(true);
  });

  it('list：调 SessionManager.list(cwd)，SessionInfo 映射为 JSON 安全元数据（丢弃 allMessagesText）', async () => {
    sessionManagerList.mockResolvedValue([
      {
        id: 'pi-ext-1',
        path: '/bucket/pi-ext-1.jsonl',
        cwd: '/proj/dv',
        name: '外部会话',
        parentSessionPath: undefined,
        created: new Date('2026-09-01T08:00:00Z'),
        modified: new Date('2026-09-02T09:30:00Z'),
        messageCount: 12,
        firstMessage: '帮我看看覆盖率',
        allMessagesText: '很长很长的全文',
      },
    ]);

    const data = (await scan.runScan({ mode: 'list', cwd: '/proj/dv' })) as {
      sessions: Array<Record<string, unknown>>;
    };

    expect(sessionManagerList).toHaveBeenCalledWith('/proj/dv');
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]).toEqual({
      id: 'pi-ext-1',
      path: '/bucket/pi-ext-1.jsonl',
      cwd: '/proj/dv',
      name: '外部会话',
      parentSessionPath: undefined,
      created: '2026-09-01T08:00:00.000Z',
      modified: '2026-09-02T09:30:00.000Z',
      messageCount: 12,
      firstMessage: '帮我看看覆盖率',
    });
    expect(data.sessions[0]).not.toHaveProperty('allMessagesText');
  });

  it('export：open(file) + buildSessionContext → 归一化消息', async () => {
    sessionManagerOpen.mockReturnValue({
      buildSessionContext: () => ({
        messages: [
          { role: 'user', content: '第一条', timestamp: 100 },
          { role: 'toolResult', content: [], timestamp: 150 },
          { role: 'assistant', content: [{ type: 'text', text: '第一条回复' }], timestamp: 200 },
        ],
      }),
    });

    const data = (await scan.runScan({ mode: 'export', file: '/bucket/s1.jsonl' })) as {
      messages: Array<Record<string, unknown>>;
    };

    expect(sessionManagerOpen).toHaveBeenCalledWith('/bucket/s1.jsonl');
    expect(data.messages).toEqual([
      { role: 'user', text: '第一条', timestamp: 100, images: undefined },
      { role: 'assistant', text: '第一条回复', timestamp: 200, images: undefined },
    ]);
  });

  it('SDK 失败（文件缺失/损坏）→ runScan 拒绝，由 main 转错误帧', async () => {
    existsSyncMock.mockReturnValue(false);
    await expect(scan.runScan({ mode: 'export', file: '/missing.jsonl' })).rejects.toThrow('session file not found');
  });
});

// ─── main（帧输出与错误处理）─────────────────────────────

describe('main', () => {
  const stdoutWrites: string[] = [];
  let origWrite: typeof process.stdout.write;

  beforeEach(() => {
    stdoutWrites.length = 0;
    origWrite = process.stdout.write;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    sessionManagerList.mockReset().mockResolvedValue([]);
    sessionManagerOpen.mockReset();
    existsSyncMock.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    process.stdout.write = origWrite;
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  function emittedFrames(): Array<Record<string, unknown>> {
    return stdoutWrites
      .join('')
      .split('\n')
      .filter((l) => l.startsWith(scan.SCAN_SENTINEL))
      .map((l) => JSON.parse(l.slice(scan.SCAN_SENTINEL.length)) as Record<string, unknown>);
  }

  it('成功路径：输出单条 { ok: true, mode, data } 帧', async () => {
    sessionManagerList.mockResolvedValue([]);

    await scan.main(['list', '--cwd', '/proj/dv']);

    const frames = emittedFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: true, mode: 'list', data: { sessions: [] } });
    expect(process.exitCode).toBeUndefined();
  });

  it('参数非法：输出 { ok: false } 错误帧并置 exitCode 1', async () => {
    await scan.main(['frobnicate']);
    const frames = emittedFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: false });
    expect(String(frames[0].error)).toBeTruthy();
    expect(process.exitCode).toBe(1);
  });

  it('SDK 失败：输出 { ok: false, error } 错误帧并置 exitCode 1（不裸抛崩溃进程）', async () => {
    sessionManagerOpen.mockImplementation(() => {
      throw new Error('corrupt file');
    });

    await scan.main(['export', '--file', '/bad.jsonl']);

    const frames = emittedFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: false, mode: 'export', error: 'corrupt file' });
    expect(process.exitCode).toBe(1);
  });

  it('export 文件不存在：existsSync 检查先行，输出错误帧', async () => {
    existsSyncMock.mockReturnValue(false);

    await scan.main(['export', '--file', '/gone.jsonl']);

    const frames = emittedFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: false, mode: 'export', error: expect.stringContaining('session file not found') });
    expect(process.exitCode).toBe(1);
  });
});
