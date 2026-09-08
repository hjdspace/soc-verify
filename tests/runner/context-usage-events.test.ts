import { describe, expect, it } from 'vitest';
import { shouldSendContextUsage } from '../../runner/protocol';

// The context estimate only moves on LLM rounds and compaction cutoffs, so
// context_usage pushes must happen exactly on those boundaries — in
// particular message_end (each tool-use round inside one agent turn), which
// is what keeps the UI context gauge live DURING a task instead of only
// after the final agent_end.
describe('shouldSendContextUsage', () => {
  it('pushes on every per-round boundary', () => {
    expect(shouldSendContextUsage('message_end')).toBe(true);
    expect(shouldSendContextUsage('agent_end')).toBe(true);
    expect(shouldSendContextUsage('compaction_start')).toBe(true);
    expect(shouldSendContextUsage('compaction_end')).toBe(true);
    expect(shouldSendContextUsage('auto_compaction_start')).toBe(true);
    expect(shouldSendContextUsage('auto_compaction_end')).toBe(true);
  });

  it('does not push on no-growth events', () => {
    expect(shouldSendContextUsage('message_update')).toBe(false);
    expect(shouldSendContextUsage('message_start')).toBe(false);
    expect(shouldSendContextUsage('tool_execution_start')).toBe(false);
    expect(shouldSendContextUsage('tool_execution_end')).toBe(false);
    expect(shouldSendContextUsage('notice')).toBe(false);
    expect(shouldSendContextUsage('agent_start')).toBe(false);
    expect(shouldSendContextUsage('')).toBe(false);
  });
});
