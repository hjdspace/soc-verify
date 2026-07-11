import { describe, it, expect } from 'vitest';
import { HostUriRouter } from '../../src/main/omp/host-uris';
import type { RpcHostUriRequest, RpcHostUriResult } from '../../src/main/omp/types';

describe('HostUriRouter', () => {
  it('registers 3 default schemes', () => {
    const router = new HostUriRouter();
    const names = router.getSchemeNames();
    expect(names).toHaveLength(3);
    expect(names).toContain('case');
    expect(names).toContain('log');
    expect(names).toContain('cov');
  });

  it('getSchemeDefinitions returns all scheme definitions', () => {
    const router = new HostUriRouter();
    const defs = router.getSchemeDefinitions();
    expect(defs).toHaveLength(3);
    for (const def of defs) {
      expect(def.scheme).toBeDefined();
      expect(def.writable).toBe(false);
      expect(def.immutable).toBe(true);
    }
  });

  it('hasScheme returns true for registered schemes', () => {
    const router = new HostUriRouter();
    expect(router.hasScheme('case')).toBe(true);
    expect(router.hasScheme('nonexistent')).toBe(false);
  });

  it('register adds a new scheme', () => {
    const router = new HostUriRouter();
    router.register('custom', 'Custom scheme', true, false, async () => ({
      type: 'host_uri_result',
      id: '',
      content: 'ok',
    }));
    expect(router.hasScheme('custom')).toBe(true);
    expect(router.getSchemeNames()).toHaveLength(4);
  });

  it('unregister removes a scheme', () => {
    const router = new HostUriRouter();
    expect(router.unregister('case')).toBe(true);
    expect(router.hasScheme('case')).toBe(false);
    expect(router.getSchemeNames()).toHaveLength(2);
  });

  it('unregister returns false for nonexistent scheme', () => {
    const router = new HostUriRouter();
    expect(router.unregister('nonexistent')).toBe(false);
  });

  it('handleUriRequest returns error for unregistered scheme', async () => {
    const router = new HostUriRouter();
    const result = await router.handleUriRequest({
      type: 'host_uri_request',
      id: '1',
      operation: 'read',
      url: 'unknown://test',
    });
    expect(result.isError).toBe(true);
    expect(result.error).toContain('No handler registered');
  });

  it('case:// read returns data', async () => {
    const router = new HostUriRouter();
    const result = await router.handleUriRequest({
      type: 'host_uri_request',
      id: '1',
      operation: 'read',
      url: 'case://cpu/test_basic',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();
    expect(result.contentType).toBe('application/json');
  });

  it('case:// write is rejected (read-only)', async () => {
    const router = new HostUriRouter();
    const result = await router.handleUriRequest({
      type: 'host_uri_request',
      id: '1',
      operation: 'write',
      url: 'case://cpu/test_basic',
      content: 'data',
    });
    expect(result.isError).toBe(true);
    expect(result.error).toContain('read-only');
  });

  it('log:// read returns empty content', async () => {
    const router = new HostUriRouter();
    const result = await router.handleUriRequest({
      type: 'host_uri_request',
      id: '1',
      operation: 'read',
      url: 'log://run123',
    });
    expect(result.isError).toBeFalsy();
  });

  it('cov:// read returns JSON', async () => {
    const router = new HostUriRouter();
    const result = await router.handleUriRequest({
      type: 'host_uri_request',
      id: '1',
      operation: 'read',
      url: 'cov://cpu',
    });
    expect(result.isError).toBeFalsy();
    expect(result.contentType).toBe('application/json');
  });

  it('handler errors are caught and returned as error results', async () => {
    const router = new HostUriRouter();
    router.register('error_scheme', 'Error scheme', false, true, async () => {
      throw new Error('handler failure');
    });
    const result = await router.handleUriRequest({
      type: 'host_uri_request',
      id: '1',
      operation: 'read',
      url: 'error_scheme://test',
    });
    expect(result.isError).toBe(true);
    expect(result.error).toBe('handler failure');
  });
});
