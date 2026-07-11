import { describe, it, expect } from 'vitest';
import { NoopDiscovery } from '../../src/main/omp/discovery';

describe('NoopDiscovery', () => {
  it('listSubsys returns empty array', async () => {
    const discovery = new NoopDiscovery();
    const result = await discovery.listSubsys();
    expect(result).toEqual([]);
  });

  it('listSubsys with filter returns empty array', async () => {
    const discovery = new NoopDiscovery();
    const result = await discovery.listSubsys('cpu*');
    expect(result).toEqual([]);
  });

  it('listCases returns empty array', async () => {
    const discovery = new NoopDiscovery();
    const result = await discovery.listCases();
    expect(result).toEqual([]);
  });

  it('listCases with subsys and status returns empty array', async () => {
    const discovery = new NoopDiscovery();
    const result = await discovery.listCases('cpu', 'pass');
    expect(result).toEqual([]);
  });

  it('getSimOptionsSchema returns empty object', async () => {
    const discovery = new NoopDiscovery();
    const result = await discovery.getSimOptionsSchema();
    expect(result).toEqual({});
  });
});
