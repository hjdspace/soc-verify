import { describe, expect, it } from 'vitest';
import { shouldSyncDestinationUrl } from '@renderer/lib/browser-url-sync';

describe('BrowserView destination URL synchronization', () => {
  it('does not write the destination URL back after the page normalizes it', () => {
    expect(shouldSyncDestinationUrl(
      'https://www.baidu.com',
      'https://www.baidu.com',
      'https://www.baidu.com/',
    )).toBe(false);
  });

  it('syncs a genuinely new destination URL', () => {
    expect(shouldSyncDestinationUrl(
      'https://www.baidu.com',
      'https://example.com',
      'https://www.baidu.com/',
    )).toBe(true);
  });

  it('does not sync an empty new-tab destination', () => {
    expect(shouldSyncDestinationUrl('', '', '')).toBe(false);
  });
});
