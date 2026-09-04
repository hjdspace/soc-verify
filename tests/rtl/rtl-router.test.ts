/**
 * rtl-router 端到端边界测试（issue 02 主 seam）。
 *
 * 测试缝：tRPC server-side caller（rtlRouter.createCaller）。
 * 外部依赖 mock：yosys spawn（子进程边界，fixture 直接写出 S0 真实
 * write_json 产物）、rtl/binary 工具解析、project-manager。
 * 参照 ADR 0015 主题 8 officecli mock spawn 模式 + kb-router 测试模式。
 *
 * 覆盖：Design Source 配置持久化 → refresh（--keep-hierarchy + --top 固化）
 * → 提炼入库 → 子树查询（generate 展开）→ 失败呈现（slang 诊断文件+行号）
 * → raw write_json 不持久化。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Hoisted mocks ──────────────────────────────────────────

const { mockSpawn, mockBinary, holder } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockBinary: {
    resolveYosysPath: vi.fn((): string | null => '/fake/yosys/yosys.exe'),
    yosysMissingDlls: vi.fn(() => [] as string[]),
    getRtlToolsStatus: vi.fn(() => ({
      yosys: { available: true, path: '/fake/yosys/yosys.exe', missingDlls: [] },
      slangServer: { available: false, path: null },
      verible: { available: false, lintPath: null, formatPath: null },
    })),
    YOSYS_DLLS: [],
  },
  holder: { projectDir: '' as string },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mockSpawn };
});

vi.mock('../../src/main/rtl/binary', () => mockBinary);

vi.mock('../../src/main/project/project-manager', () => ({
  projectManager: {
    getProject: vi.fn(() => ({ id: 'proj-1', rootPath: holder.projectDir, name: 'P', lastOpenedAt: 1 })),
    listProjects: vi.fn(() => []),
  },
}));

import { rtlRouter } from '../../src/main/ipc/routers/rtl-router';
import { evictDesignDb } from '../../src/main/rtl/design-service';

const caller = rtlRouter.createCaller({});
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, 'fixtures/spike_netlist_keep.json'), 'utf-8');

// ─── fake yosys 子进程 ──────────────────────────────────────

/** spawn 边界捕获的 yosys 脚本（断言 --keep-hierarchy / --top 固化） */
const capturedScripts: string[] = [];

type FakeOpts = { exitCode: number; stderr?: string; stdout?: string; writeFixture?: boolean };

function makeFakeChild(opts: FakeOpts): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    const args = mockSpawn.mock.calls[capturedScripts.length]?.[1] as string[];
    const ysPath = args[1];
    const script = readFileSync(ysPath, 'utf-8');
    capturedScripts.push(script);
    if (opts.writeFixture) {
      const jsonPath = /write_json (.+)/.exec(script)?.[1]?.trim();
      if (jsonPath) writeFileSync(jsonPath, FIXTURE, 'utf-8');
    }
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.exitCode);
  });
  return child;
}

beforeEach(() => {
  holder.projectDir = mkdtempSync(join(tmpdir(), 'sv-rtl-router-'));
  mkdirSync(join(holder.projectDir, 'rtl'), { recursive: true });
  writeFileSync(join(holder.projectDir, 'spike.f'), '+incdir+rtl/ip\n+define+SPIKE_MACRO\nrtl/top.sv\n', 'utf-8');
  capturedScripts.length = 0;
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => {
    // 每次 spawn 分配一个新 fake child（默认成功 + 写 fixture）
    return makeFakeChild({ exitCode: 0, writeFixture: true, stdout: 'Yosys 0.68+138\n' });
  });
});

afterEach(() => {
  evictDesignDb('proj-1');
  rmSync(holder.projectDir, { recursive: true, force: true });
});

// ─── 工具状态（issue 01 承接） ──────────────────────────────

describe('rtl.toolsStatus', () => {
  it('返回三工具可用性（mock binary 解析）', async () => {
    const status = await caller.toolsStatus();
    expect(status.yosys.available).toBe(true);
    expect(status.yosys.path).toBe('/fake/yosys/yosys.exe');
  });
});

// ─── Design Source 配置 ─────────────────────────────────────

describe('rtl.getConfig / setConfig', () => {
  it('配置持久化（config.json 落盘，重读一致）', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    const cfg = await caller.getConfig({ projectId: 'proj-1' });
    expect(cfg.filelists).toEqual(['spike.f']);
    expect(cfg.top).toBe('spike_top');
    expect(existsSync(join(holder.projectDir, '.socverify/design/config.json'))).toBe(true);
  });

  it('空 top 字符串归一化为 null；未配置时返回空配置', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: [], top: '  ' });
    const cfg = await caller.getConfig({ projectId: 'proj-1' });
    expect(cfg.filelists).toEqual([]);
    expect(cfg.top).toBeNull();
  });
});

// ─── 刷新管线（成功） ───────────────────────────────────────

describe('rtl.refresh 成功路径（golden fixture）', () => {
  it('配置 → 刷新 → 入库（defCount/instCount）→ 秒开数据可用', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });

    const result = await caller.refresh({ projectId: 'proj-1' });
    if (!result.ok) throw new Error(`refresh 应成功: ${result.error.message}`);
    expect(result.top).toBe('spike_top');
    expect(result.defCount).toBe(3);
    expect(result.instCount).toBe(9);

    // --keep-hierarchy 硬性要求 + --top 固化
    const script = capturedScripts[0];
    expect(script).toContain('--keep-hierarchy');
    expect(script).toContain('--top spike_top');
    expect(script).toContain('read_slang -f');

    const status = await caller.getStatus({ projectId: 'proj-1' });
    expect(status.hasData).toBe(true);
    expect(status.top).toBe('spike_top');
    expect(status.lastError).toBeNull();
    expect(status.lastElaboratedAt).not.toBeNull();
  });

  it('子树查询：getRoot / getChildren（generate 展开 gen_ip[N].u_ip）', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });

    const root = await caller.getRoot({ projectId: 'proj-1' });
    expect(root?.path).toBe('spike_top');
    expect(root?.module).toBe('spike_top');

    const subsys = await caller.getChildren({ projectId: 'proj-1', path: 'spike_top' });
    expect(subsys.map((c) => c.name)).toEqual(['u_subsys0', 'u_subsys1']);

    const ips = await caller.getChildren({ projectId: 'proj-1', path: 'spike_top.u_subsys1' });
    expect(ips.map((c) => c.name)).toEqual([
      'gen_ip[0].u_ip',
      'gen_ip[1].u_ip',
      'gen_ip[2].u_ip',
      'gen_ip[3].u_ip',
    ]);
    expect(ips.every((c) => c.module === 'spike_ip')).toBe(true);
  });

  it('getDef 端口全表（渲染端零解析）', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });

    const def = await caller.getDef({ projectId: 'proj-1', name: 'spike_ip' });
    const irq = def?.ports.find((p) => p.name === 'irq_o');
    expect(irq).toEqual({ name: 'irq_o', direction: 'output', width: 4 });
    expect(def?.src).toContain('spike_ip.sv');
  });

  it('raw write_json 不持久化（提炼后即删），扁平 filelist 留存可查', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });

    const workDir = join(holder.projectDir, '.socverify/design/work');
    expect(existsSync(join(workDir, 'design.json'))).toBe(false);
    expect(existsSync(join(workDir, 'design_flat.f'))).toBe(true);
    expect(existsSync(join(holder.projectDir, '.socverify/design.db'))).toBe(true);
  });
});

// ─── 刷新管线（失败：slang 诊断呈现） ─────────────────────────

describe('rtl.refresh 失败路径', () => {
  it('未配置时返回结构化错误而非抛出', async () => {
    const result = await caller.refresh({ projectId: 'proj-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('未配置');
  });

  it('elaboration 失败返回 slang 诊断（文件+行号），lastError 持久化', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    mockSpawn.mockImplementation(() =>
      makeFakeChild({
        exitCode: 1,
        writeFixture: false,
        stderr: [
          'rtl/ip/spike_ip.sv:99:5: error: unknown port `nope`',
          'ERROR: read_slang failed in design.ys',
        ].join('\n'),
      }),
    );

    const result = await caller.refresh({ projectId: 'proj-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.diagnostics[0]).toMatchObject({
        file: 'rtl/ip/spike_ip.sv',
        line: 99,
        column: 5,
        severity: 'error',
      });
      expect(result.error.logTail).toContain('read_slang failed');
    }

    const status = await caller.getStatus({ projectId: 'proj-1' });
    expect(status.hasData).toBe(false);
    expect(status.lastError?.diagnostics[0].file).toBe('rtl/ip/spike_ip.sv');
    expect(status.lastError?.diagnostics[0].line).toBe(99);
  });

  it('yosys 不可用时降级报错（引导 download:rtl-tools）', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    mockBinary.resolveYosysPath.mockReturnValueOnce(null);

    const result = await caller.refresh({ projectId: 'proj-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('download:rtl-tools');
  });
});

// ─── 缓存秒开语义 ───────────────────────────────────────────

describe('缓存秒开（对齐 Case Scan 模式）', () => {
  it('getStatus 不触发 elaboration：无 spawn、DB 有数据直接可查', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    mockSpawn.mockClear();
    const root = await caller.getRoot({ projectId: 'proj-1' });
    const children = await caller.getChildren({ projectId: 'proj-1', path: 'spike_top' });
    const status = await caller.getStatus({ projectId: 'proj-1' });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(root).not.toBeNull();
    expect(children).toHaveLength(2);
    expect(status.hasData).toBe(true);
  });
});
