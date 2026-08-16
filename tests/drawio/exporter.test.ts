import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock 依赖：CLI 路径解析、文件系统、spawn
vi.mock('../../src/main/drawio/binary', () => ({
  resolveDrawioPath: vi.fn(() => '/fake/drawio'),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import {
  buildExportArgs,
  exportDiagram,
  formatExtension,
  DrawioNotAvailableError,
  DrawioExportError,
} from '../../src/main/drawio/exporter';
import { resolveDrawioPath } from '../../src/main/drawio/binary';

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);
const mockResolveDrawioPath = vi.mocked(resolveDrawioPath);

type FakeChild = {
  stderr: { on: (event: string, cb: (chunk: Buffer) => void) => void };
  on: (event: string, cb: (arg: unknown) => void) => void;
  kill: (signal?: string) => void;
  __emit: (event: string, arg?: unknown) => void;
  __emitStderr: (text: string) => void;
};

/** 构造可手动触发事件的 fake child process */
function makeFakeChild(): FakeChild {
  const listeners = new Map<string, ((arg: unknown) => void)[]>();
  const stderrListeners: ((chunk: Buffer) => void)[] = [];
  const child: FakeChild = {
    stderr: { on: (_e, cb) => stderrListeners.push(cb) },
    on: (event, cb) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    kill: vi.fn(),
    __emit: (event, arg) => {
      for (const cb of listeners.get(event) ?? []) cb(arg);
    },
    __emitStderr: (text) => {
      for (const cb of stderrListeners) cb(Buffer.from(text));
    },
  };
  return child;
}

const BASE_INPUT = {
  inputPath: '/tmp/tb-arch.drawio',
  format: 'png' as const,
  outputPath: '/tmp/tb-arch.png',
};

describe('drawio/exporter - buildExportArgs', () => {
  it('基础参数顺序为 -x -f <fmt> -o <out> <in>', () => {
    const args = buildExportArgs({ ...BASE_INPUT, format: 'svg', outputPath: '/tmp/o.svg' });
    expect(args.slice(0, 6)).toEqual(['-x', '-f', 'svg', '-o', '/tmp/o.svg', '/tmp/tb-arch.drawio']);
  });

  it('scale / transparent 仅对 png/jpg 生效', () => {
    const png = buildExportArgs({ ...BASE_INPUT, format: 'png', scale: 2, transparent: true });
    expect(png).toContain('-s');
    expect(png).toContain('2');
    expect(png).toContain('-t');

    const pdf = buildExportArgs({ ...BASE_INPUT, format: 'pdf', outputPath: '/tmp/o.pdf', scale: 2, transparent: true });
    expect(pdf).not.toContain('-s');
    expect(pdf).not.toContain('-t');
    expect(pdf).not.toContain('2');
  });

  it('crop 仅对 pdf/svg 生效', () => {
    const svg = buildExportArgs({ ...BASE_INPUT, format: 'svg', outputPath: '/tmp/o.svg', crop: true });
    expect(svg).toContain('--crop');

    const png = buildExportArgs({ ...BASE_INPUT, format: 'png', crop: true });
    expect(png).not.toContain('--crop');
  });

  it('formatExtension 返回对应扩展名', () => {
    expect(formatExtension('png')).toBe('png');
    expect(formatExtension('jpg')).toBe('jpg');
    expect(formatExtension('svg')).toBe('svg');
    expect(formatExtension('pdf')).toBe('pdf');
  });
});

describe('drawio/exporter - exportDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveDrawioPath.mockReturnValue('/fake/drawio');
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 1234 } as unknown as ReturnType<typeof statSync>);
  });

  it('CLI 缺失时抛 DrawioNotAvailableError', async () => {
    mockResolveDrawioPath.mockReturnValue(null);
    await expect(exportDiagram(BASE_INPUT)).rejects.toBeInstanceOf(DrawioNotAvailableError);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('退出码非 0 时抛 DrawioExportError（含 stderr）', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = exportDiagram(BASE_INPUT);
    // 导出任务在微任务队列中串行执行：先 flush 让 spawn 发生、监听器挂上，再触发事件
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    child.__emitStderr('boom');
    child.__emit('close', 1);

    await expect(promise).rejects.toBeInstanceOf(DrawioExportError);
    await expect(promise).rejects.toMatchObject({ stderr: expect.stringContaining('boom') });
  });

  it('spawn error 时抛 DrawioExportError', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = exportDiagram(BASE_INPUT);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    child.__emit('error', new Error('ENOENT'));

    await expect(promise).rejects.toThrow('spawn failed: ENOENT');
  });

  it('产物缺失或为空时抛错', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    mockExistsSync.mockReturnValue(false);

    const promise = exportDiagram(BASE_INPUT);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    child.__emit('close', 0);

    await expect(promise).rejects.toThrow('output file missing or empty');
  });

  it('成功时返回产物路径与大小', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = exportDiagram(BASE_INPUT);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    child.__emit('close', 0);

    await expect(promise).resolves.toEqual({
      success: true,
      outputPath: '/tmp/tb-arch.png',
      sizeBytes: 1234,
    });
  });

  it('并发导出被串行化：第二条命令等第一条结束后才 spawn', async () => {
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    mockSpawn.mockReturnValueOnce(child1 as unknown as ReturnType<typeof spawn>);
    mockSpawn.mockReturnValueOnce(child2 as unknown as ReturnType<typeof spawn>);

    const p1 = exportDiagram(BASE_INPUT);
    const p2 = exportDiagram({ ...BASE_INPUT, format: 'svg', outputPath: '/tmp/o.svg' });

    // 第一条启动后（未结束），第二条不应启动
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    child1.__emit('close', 0);
    await p1;

    // 第一条结束后第二条才 spawn
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));

    child2.__emit('close', 0);
    await p2;
  });
});
