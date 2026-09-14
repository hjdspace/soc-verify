// @vitest-environment node
/**
 * 布局 worker 的生命周期（spec §9/§10，issue 26）。
 *
 * 用假 worker 验证：只创建一个 worker、迟到结果被丢弃、失败回退主线程、
 * 卸载/切库时调用 terminate。这些是「卸载终止 worker 并释放渲染资源」
 * 中 worker 一侧的可执行证据（渲染资源一侧由组件测试 + 冒烟测试覆盖）。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GraphLayoutClient,
  runMainThreadLayout,
  type LayoutRequest,
  type LayoutWorkerHandle,
  type GraphLayoutWorkerResponse,
} from '@renderer/lib/graph-layout-client';

class FakeWorker implements LayoutWorkerHandle {
  readonly posted: Array<{ key: string }> = [];
  terminateCount = 0;
  onmessage: ((event: MessageEvent<GraphLayoutWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: LayoutRequest): void {
    this.posted.push({ key: message.key });
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  /** 模拟 worker 回传结果 */
  emit(response: GraphLayoutWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<GraphLayoutWorkerResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function request(key: string, nodeCount = 3): LayoutRequest {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({ id: `n${i}`, x: i, y: 0 }));
  const edges = nodes.slice(1).map((n, i) => ({ source: nodes[i]!.id, target: n.id, weight: 1 }));
  return { key, nodes, edges, iterations: 2, scalingRatio: 2 };
}

function makeClient(factory: () => LayoutWorkerHandle | null) {
  const layouts: Array<{ key: string; via: string; error?: string; positions: number }> = [];
  const errors: string[] = [];
  const client = new GraphLayoutClient({
    factory,
    onLayout: (outcome) => layouts.push({
      key: outcome.key,
      via: outcome.via,
      positions: outcome.positions.length,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    }),
    onError: (message) => errors.push(message),
  });
  return { client, layouts, errors };
}

describe('GraphLayoutClient', () => {
  it('首次请求创建 worker 并投递载荷', () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker as LayoutWorkerHandle);
    const { client } = makeClient(factory);

    client.request(request('k1'));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.posted).toEqual([{ key: 'k1' }]);
    expect(client.usesWorker).toBe(true);
    expect(client.pending).toBe('k1');
    client.terminate();
  });

  it('后续请求复用同一个 worker，不重复创建', () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker as LayoutWorkerHandle);
    const { client } = makeClient(factory);

    client.request(request('k1'));
    worker.emit({ key: 'k1', positions: [{ id: 'n0', x: 1, y: 1 }] });
    client.request(request('k2'));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.posted.map((p) => p.key)).toEqual(['k1', 'k2']);
    client.terminate();
  });

  it('同一 key 重复请求被忽略（避免同一数据反复重排）', () => {
    const worker = new FakeWorker();
    const { client } = makeClient(() => worker as LayoutWorkerHandle);

    client.request(request('k1'));
    client.request(request('k1'));

    expect(worker.posted).toHaveLength(1);
    client.terminate();
  });

  it('worker 结果按 via=worker 上报坐标', () => {
    const worker = new FakeWorker();
    const { client, layouts } = makeClient(() => worker as LayoutWorkerHandle);

    client.request(request('k1'));
    worker.emit({ key: 'k1', positions: [{ id: 'n0', x: 5, y: 6 }, { id: 'n1', x: 7, y: 8 }] });

    expect(layouts).toEqual([{ key: 'k1', via: 'worker', positions: 2 }]);
    expect(client.pending).toBeNull();
    client.terminate();
  });

  it('迟到的结果（key 已过期）被丢弃，不写入当前图', () => {
    const worker = new FakeWorker();
    const { client, layouts } = makeClient(() => worker as LayoutWorkerHandle);

    client.request(request('rev1'));
    client.request(request('rev2')); // 切库/重开图
    worker.emit({ key: 'rev1', positions: [{ id: 'old', x: 0, y: 0 }] });

    expect(layouts).toHaveLength(0);
    client.terminate();
  });

  it('cancel 后结果同样被丢弃', () => {
    const worker = new FakeWorker();
    const { client, layouts } = makeClient(() => worker as LayoutWorkerHandle);

    client.request(request('k1'));
    client.cancel();
    worker.emit({ key: 'k1', positions: [{ id: 'n0', x: 0, y: 0 }] });

    expect(layouts).toHaveLength(0);
    client.terminate();
  });

  it('worker 回传 error 时回退主线程布局并暴露错误', async () => {
    const worker = new FakeWorker();
    const { client, layouts, errors } = makeClient(() => worker as LayoutWorkerHandle);

    client.request(request('k1', 4));
    worker.emit({ key: 'k1', error: 'worker 内部异常' });

    await vi.waitFor(() => expect(layouts).toHaveLength(1));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('worker 内部异常');
    expect(layouts[0]!.via).toBe('main-thread');
    expect(layouts[0]!.positions).toBe(4);
    // 失效 worker 被销毁，下一次请求会重建
    expect(worker.terminateCount).toBe(1);
    expect(client.usesWorker).toBe(false);

    client.request(request('k2', 3));
    expect(worker.posted.map((p) => p.key)).toEqual(['k1', 'k2']);
    client.terminate();
  });

  it('worker onerror 时回退主线程布局', async () => {
    const worker = new FakeWorker();
    const { client, layouts, errors } = makeClient(() => worker as LayoutWorkerHandle);

    client.request(request('k1'));
    worker.fail('模块加载失败');

    expect(errors[0]).toContain('模块加载失败');
    await vi.waitFor(() => expect(layouts).toHaveLength(1));
    expect(layouts[0]!.via).toBe('main-thread');
    client.terminate();
  });

  it('worker 不可创建时直接回退主线程，不留下半死状态', async () => {
    const { client, layouts, errors } = makeClient(() => null);

    client.request(request('k1', 2));

    expect(errors[0]).toContain('不可用');
    await vi.waitFor(() => expect(layouts).toHaveLength(1));
    expect(layouts[0]).toMatchObject({ key: 'k1', via: 'main-thread', positions: 2 });
    expect(layouts[0]!.error).toContain('不可用');
    expect(client.createdWorkerCount).toBe(0);
    expect(client.isDisposed).toBe(false);
    client.terminate();
  });

  it('terminate 终止 worker 并让实例进入终态（卸载/切库路径）', () => {
    const worker = new FakeWorker();
    const { client, layouts } = makeClient(() => worker as LayoutWorkerHandle);

    client.request(request('k1'));
    client.terminate();

    expect(worker.terminateCount).toBe(1);
    expect(client.isDisposed).toBe(true);
    expect(client.usesWorker).toBe(false);

    // 终态后再来请求与迟到结果都不产生副作用
    client.request(request('k2'));
    worker.emit({ key: 'k1', positions: [{ id: 'n0', x: 0, y: 0 }] });
    expect(worker.posted.map((p) => p.key)).toEqual(['k1']);
    expect(layouts).toHaveLength(0);
  });

  it('terminate 幂等，重复调用不会重复终止', () => {
    const worker = new FakeWorker();
    const { client } = makeClient(() => worker as LayoutWorkerHandle);

    client.request(request('k1'));
    client.terminate();
    client.terminate();

    expect(worker.terminateCount).toBe(1);
  });
});

describe('runMainThreadLayout', () => {
  it('产出与输入节点一一对应的坐标', async () => {
    const positions = await runMainThreadLayout(request('k1', 5));
    expect(positions.map((p) => p.id).sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    for (const p of positions) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('容忍自链与重复边（不抛错、不丢节点）', async () => {
    const positions = await runMainThreadLayout({
      key: 'k',
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 1 }],
      edges: [
        { source: 'a', target: 'a', weight: 1 },
        { source: 'a', target: 'b', weight: 1 },
        { source: 'b', target: 'a', weight: 1 },
      ],
      iterations: 2,
      scalingRatio: 2,
    });
    expect(positions).toHaveLength(2);
  });
});
