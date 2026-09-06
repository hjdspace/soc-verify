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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, utimesSync } from 'node:fs';
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
  mkdirSync(join(holder.projectDir, 'rtl/ip'), { recursive: true });
  writeFileSync(join(holder.projectDir, 'rtl/spike_top.sv'), 'module spike_top; endmodule\n', 'utf-8');
  writeFileSync(join(holder.projectDir, 'rtl/soc_subsys.sv'), 'module soc_subsys; endmodule\n', 'utf-8');
  writeFileSync(join(holder.projectDir, 'rtl/ip/spike_ip.sv'), 'module spike_ip; endmodule\n', 'utf-8');
  writeFileSync(
    join(holder.projectDir, 'spike.f'),
    '+incdir+rtl/ip\n+define+SPIKE_MACRO\nrtl/spike_top.sv\nrtl/soc_subsys.sv\nrtl/ip/spike_ip.sv\n',
    'utf-8',
  );
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

  it('filelist 路径去除首尾引号与空白（Windows「复制文件地址」粘贴场景）', async () => {
    writeFileSync(join(holder.projectDir, 'other.f'), 'rtl/top.sv\n', 'utf-8');
    await caller.setConfig({
      projectId: 'proj-1',
      filelists: [`"${join(holder.projectDir, 'spike.f')}"`, "  'other.f'  "],
      top: 'spike_top',
    });
    const cfg = await caller.getConfig({ projectId: 'proj-1' });
    expect(cfg.filelists).toEqual([join(holder.projectDir, 'spike.f'), 'other.f']);

    // 带引号的绝对路径可直接 elaboration（不再被当相对路径拼到项目根下）
    const result = await caller.refresh({ projectId: 'proj-1' });
    expect(result.ok).toBe(true);
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
    expect(root?.src).toBe(`${join(holder.projectDir, 'rtl/spike_top.sv')}:3.8`);

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

  it('instCount 子树实例数随行返回（issue 03：树节点实例数统计）', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });

    const root = await caller.getRoot({ projectId: 'proj-1' });
    expect(root?.instCount).toBe(9); // 全设计 9 实例

    const subsys = await caller.getChildren({ projectId: 'proj-1', path: 'spike_top' });
    const byName = new Map(subsys.map((c) => [c.name, c.instCount]));
    expect(byName.get('u_subsys0')).toBe(3); // 自身 + 2 ip
    expect(byName.get('u_subsys1')).toBe(5); // 自身 + 4 ip

    const leaf = await caller.getChildren({ projectId: 'proj-1', path: 'spike_top.u_subsys0' });
    expect(leaf.every((c) => c.instCount === 1)).toBe(true);
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

  it('filelist 缺失等前置失败也持久化 lastError（UI 不再静默回退空页面）', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['missing.f'], top: 'spike_top' });

    const result = await caller.refresh({ projectId: 'proj-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('filelist 文件不存在');

    const status = await caller.getStatus({ projectId: 'proj-1' });
    expect(status.hasData).toBe(false);
    expect(status.lastError?.message).toContain('filelist 文件不存在');
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

describe('mtime 过期检测（issue 03：提示过期但不自动重跑）', () => {
  it('刷新后 stale 为 false；touch 源文件后 stale 为 true 且无任何 spawn', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });

    expect((await caller.getStatus({ projectId: 'proj-1' })).stale).toBe(false);

    // 源文件 mtime 变化（+1 分钟避开 1s 容差）
    const src = join(holder.projectDir, 'rtl/spike_top.sv');
    const future = new Date(Date.now() + 60_000);
    utimesSync(src, future, future);

    mockSpawn.mockClear();
    const status = await caller.getStatus({ projectId: 'proj-1' });
    expect(status.stale).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled(); // 不自动重跑，仅提示
  });

  it('源文件消失视为过期', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });
    rmSync(join(holder.projectDir, 'rtl/spike_top.sv'));
    expect((await caller.getStatus({ projectId: 'proj-1' })).stale).toBe(true);
  });
});

describe('顶层选择记忆（issue 03 story 17）', () => {
  it('detectTops 持久化 top units 列表；getDetectedTops 无 spawn 直接读回', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: null });

    const { tops } = await caller.detectTops({ projectId: 'proj-1' });
    // uniquified 实例模块（soc_subsys$... / spike_ip$...）不是顶层候选
    expect(tops).toEqual(['spike_top']);
    expect(existsSync(join(holder.projectDir, '.socverify/design/tops.json'))).toBe(true);

    mockSpawn.mockClear();
    const again = await caller.getDetectedTops({ projectId: 'proj-1' });
    expect(again.tops).toEqual(tops);
    expect(mockSpawn).not.toHaveBeenCalled(); // 记忆列表恢复不触发 elaboration
  });

  it('未检测过时 getDetectedTops 返回空列表', async () => {
    const { tops } = await caller.getDetectedTops({ projectId: 'proj-1' });
    expect(tops).toEqual([]);
  });

  it('detectTops 失败时持久化 lastError（UI ErrorPanel 可呈现 logTail + diagnostics）', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: null });
    mockSpawn.mockImplementation(() =>
      makeFakeChild({
        exitCode: 1,
        writeFixture: false,
        stderr: 'ERROR: read_slang failed in design.ys\n',
      }),
    );

    await expect(caller.detectTops({ projectId: 'proj-1' })).rejects.toThrow('yosys 退出码 1');

    // lastError 持久化到 DB（reload 后 getStatus 可读回 → ErrorPanel 呈现）
    const status = await caller.getStatus({ projectId: 'proj-1' });
    expect(status.lastError).not.toBeNull();
    // 报错消息带上日志首个 error 行（不再只有「yosys 退出码 1」）
    expect(status.lastError?.message).toContain('yosys 退出码');
    expect(status.lastError?.message).toContain('ERROR: read_slang failed');
    expect(status.lastError?.logTail).toContain('read_slang failed');
  });

  it('detectTops 成功后清除上次失败的 lastError', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: null });

    // 第一次：失败 → lastError 持久化
    mockSpawn.mockImplementationOnce(() =>
      makeFakeChild({ exitCode: 1, writeFixture: false, stderr: 'ERROR: fail\n' }),
    );
    await expect(caller.detectTops({ projectId: 'proj-1' })).rejects.toThrow();
    expect((await caller.getStatus({ projectId: 'proj-1' })).lastError).not.toBeNull();

    // 第二次：成功 → lastError 清除
    mockSpawn.mockImplementationOnce(() =>
      makeFakeChild({ exitCode: 0, writeFixture: true, stdout: 'ok\n' }),
    );
    const { tops } = await caller.detectTops({ projectId: 'proj-1' });
    expect(tops).toContain('spike_top');
    expect((await caller.getStatus({ projectId: 'proj-1' })).lastError).toBeNull();
  });
});

// ─── Protocol Bundle 打标入库（issue 04：框图粗边/接口分组公共消费索引） ──

describe('bundle 打标（refresh 管线 → getDef 消费）', () => {
  it('refresh 后 getDef 返回 bundles：spike_ip AXI4-Lite [slave] 17 信号 + APB + leftovers', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });

    const def = await caller.getDef({ projectId: 'proj-1', name: 'spike_ip' });
    const axil = def?.bundles.bundles.find((b) => b.protocol === 'AXI4-Lite');
    expect(axil).toMatchObject({ prefix: 's_axil_', role: 'slave' });
    expect(axil?.signals).toHaveLength(17);
    expect(def?.bundles.bundles.find((b) => b.protocol === 'APB')).toMatchObject({ prefix: 'p_', role: 'slave' });
    expect(def?.bundles.leftovers).toEqual(['irq_o']);
  });

  it('spike_top：AXI4 27 信号（awid/arid/awlen/wlast 全通道特征）入库', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });

    const def = await caller.getDef({ projectId: 'proj-1', name: 'spike_top' });
    const axi = def?.bundles.bundles.find((b) => b.protocol === 'AXI4');
    expect(axi?.signals).toHaveLength(27);
    for (const feature of ['awid', 'arid', 'awlen', 'wlast']) {
      expect(axi?.signals.some((s) => s.sig === feature)).toBe(true);
    }
  });

  it('.socverify/design/bundle-rules.json 自定义规则覆盖内置（h_ 前缀协议改名）', async () => {
    const rulesDir = join(holder.projectDir, '.socverify/design');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, 'bundle-rules.json'),
      JSON.stringify({
        priority: ['myahb'],
        rules: [
          {
            id: 'myahb',
            protocol: 'MyAHB',
            signals: ['htrans', 'haddr', 'hwrite', 'hsel'],
            requiresAllOf: ['htrans', 'haddr'],
            minSignals: 2,
          },
        ],
      }),
      'utf-8',
    );
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });

    // 自定义规则优先于内置 AHB：soc_subsys 的 h_ 束改名 MyAHB
    const def = await caller.getDef({ projectId: 'proj-1', name: 'soc_subsys' });
    expect(def?.bundles.bundles.some((b) => b.protocol === 'AHB')).toBe(false);
    const my = def?.bundles.bundles.find((b) => b.protocol === 'MyAHB');
    expect(my?.signals.map((s) => s.name).sort()).toEqual(['h_haddr', 'h_hsel', 'h_htrans', 'h_hwrite']);
  });

  it('规则文件损坏时回退内置规则（refresh 不失败）', async () => {
    const rulesDir = join(holder.projectDir, '.socverify/design');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, 'bundle-rules.json'), '{ broken json !!', 'utf-8');
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });

    const result = await caller.refresh({ projectId: 'proj-1' });
    expect(result.ok).toBe(true);

    const def = await caller.getDef({ projectId: 'proj-1', name: 'soc_subsys' });
    expect(def?.bundles.bundles.find((b) => b.protocol === 'AHB')).toBeDefined();
  });
});

// ─── 框图子图查询（issue 05：任意模块为图根的可下钻框图数据） ──

describe('rtl.getSubgraph（issue 05 框图数据）', () => {
  it('spike_top 子图：nodes 带端口表与打标；edges cells 转完整实例路径；图根打标随行', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });

    const sg = await caller.getSubgraph({ projectId: 'proj-1', path: 'spike_top' });
    expect(sg.root?.path).toBe('spike_top');
    expect(sg.root?.module).toBe('spike_top');
    expect(sg.root?.ports.some((p) => p.name === 'apb0_paddr' && p.direction === 'input')).toBe(true);

    expect(sg.nodes.map((n) => n.name)).toEqual(['u_subsys0', 'u_subsys1']);
    const s0 = sg.nodes.find((n) => n.name === 'u_subsys0')!;
    expect(s0.module).toBe('soc_subsys');
    // box 端口 hover 数据（信号名/方向/位宽）随行
    expect(s0.ports.some((p) => p.name === 'h_haddr' && p.direction === 'input' && p.width === 12)).toBe(true);
    // node def 打标（边两端聚合消费）
    expect(s0.bundles.bundles.some((b) => b.protocol === 'AHB')).toBe(true);
    // 图根打标（APB 粗边聚类）
    expect(sg.bundles.bundles.some((b) => b.protocol === 'APB')).toBe(true);

    // top2i 边：cells 为完整实例路径（spike_top.apb0_paddr → u_subsys0.h_haddr）
    const apbAddr = sg.edges.find((e) => e.topPorts.includes('apb0_paddr'));
    expect(apbAddr?.kind).toBe('top2i');
    expect(apbAddr?.cells).toEqual([{ inst: 'spike_top.u_subsys0', port: 'h_haddr' }]);
    // link_irq 细边（issue 验收：u_subsys0:irq_o → u_subsys1:fab_irq_en）
    const link = sg.edges.find((e) => e.net === 'link_irq');
    expect(link?.kind).toBe('i2i');
    expect(link?.cells).toEqual([
      { inst: 'spike_top.u_subsys0', port: 'irq_o' },
      { inst: 'spike_top.u_subsys1', port: 'fab_irq_en' },
    ]);
  });

  it('下钻 u_subsys0：nodes = gen_ip[0..1].u_ip，edges 来自 soc_subsys def（cells 完整路径）', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });

    const sg = await caller.getSubgraph({ projectId: 'proj-1', path: 'spike_top.u_subsys0' });
    expect(sg.root?.module).toBe('soc_subsys');
    expect(sg.nodes.map((n) => n.name)).toEqual(['gen_ip[0].u_ip', 'gen_ip[1].u_ip']);
    expect(sg.nodes.every((n) => n.module === 'spike_ip')).toBe(true);

    const hh = sg.edges.find((e) => e.net === 'h_haddr');
    expect(hh?.cells.some((c) => c.inst === 'spike_top.u_subsys0.gen_ip[0].u_ip' && c.port === 'p_paddr')).toBe(true);
  });

  it('不存在的 path：root 为 null，nodes/edges 为空', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });

    const sg = await caller.getSubgraph({ projectId: 'proj-1', path: 'no.such.path' });
    expect(sg.root).toBeNull();
    expect(sg.nodes).toEqual([]);
    expect(sg.edges).toEqual([]);
  });

  it('leaf 实例子图：nodes/edges 为空但 root 带端口表（框图空态）', async () => {
    await caller.setConfig({ projectId: 'proj-1', filelists: ['spike.f'], top: 'spike_top' });
    await caller.refresh({ projectId: 'proj-1' });

    const sg = await caller.getSubgraph({ projectId: 'proj-1', path: 'spike_top.u_subsys0.gen_ip[0].u_ip' });
    expect(sg.root?.module).toBe('spike_ip');
    expect(sg.root?.ports.length).toBeGreaterThan(0);
    expect(sg.nodes).toEqual([]);
    expect(sg.edges).toEqual([]);
  });
});
