import { describe, it, expect, vi } from 'vitest';
import { tRPCError, getToast } from '@renderer/lib/trpc-utils';

describe('tRPCError', () => {
  it('extracts message from Error instances', () => {
    expect(tRPCError(new Error('boom'))).toBe('boom');
  });

  it('extracts message from objects with a message property', () => {
    expect(tRPCError({ message: 'something went wrong' })).toBe('something went wrong');
  });

  it('stringifies primitives', () => {
    expect(tRPCError(42)).toBe('42');
    expect(tRPCError('plain string')).toBe('plain string');
  });

  it('stringifies null', () => {
    expect(tRPCError(null)).toBe('null');
  });

  it('stringifies undefined', () => {
    expect(tRPCError(undefined)).toBe('undefined');
  });
});

describe('getToast', () => {
  it('returns the current toast store state', async () => {
    const { useToastStore } = await import('@renderer/stores/toast');
    const state = getToast();
    expect(state).toBe(useToastStore.getState());
  });
});
