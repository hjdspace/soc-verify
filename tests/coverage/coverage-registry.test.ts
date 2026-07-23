import { describe, it, expect, beforeEach } from 'vitest';
import { coverageRegistry } from '../../src/main/coverage/coverage-registry';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CoverageRegistry', () => {
  beforeEach(() => {
    coverageRegistry.clearAll();
  });

  it('returns the same CoverageManager instance for the same project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'covreg-same-'));
    const mgr1 = coverageRegistry.getOrCreate(root, null);
    const mgr2 = coverageRegistry.getOrCreate(root, null);
    expect(mgr1).toBe(mgr2);
    rmSync(root, { recursive: true });
  });

  it('returns different instances for different project roots', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'covreg-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'covreg-b-'));
    const mgrA = coverageRegistry.getOrCreate(rootA, null);
    const mgrB = coverageRegistry.getOrCreate(rootB, null);
    expect(mgrA).not.toBe(mgrB);
    rmSync(rootA, { recursive: true });
    rmSync(rootB, { recursive: true });
  });

  it('get returns null for unknown project root', () => {
    expect(coverageRegistry.get('/nonexistent')).toBeNull();
  });

  it('get returns the same instance as getOrCreate', () => {
    const root = mkdtempSync(join(tmpdir(), 'covreg-get-'));
    const created = coverageRegistry.getOrCreate(root, null);
    const fetched = coverageRegistry.get(root);
    expect(fetched).toBe(created);
    rmSync(root, { recursive: true });
  });

  it('remove deletes the instance so getOrCreate creates a new one', () => {
    const root = mkdtempSync(join(tmpdir(), 'covreg-rm-'));
    const mgr1 = coverageRegistry.getOrCreate(root, null);
    coverageRegistry.remove(root);
    expect(coverageRegistry.get(root)).toBeNull();
    const mgr2 = coverageRegistry.getOrCreate(root, null);
    expect(mgr2).not.toBe(mgr1);
    rmSync(root, { recursive: true });
  });

  it('clearAll removes all instances', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'covreg-ca-'));
    const rootB = mkdtempSync(join(tmpdir(), 'covreg-cb-'));
    coverageRegistry.getOrCreate(rootA, null);
    coverageRegistry.getOrCreate(rootB, null);
    coverageRegistry.clearAll();
    expect(coverageRegistry.get(rootA)).toBeNull();
    expect(coverageRegistry.get(rootB)).toBeNull();
    rmSync(rootA, { recursive: true });
    rmSync(rootB, { recursive: true });
  });
});
