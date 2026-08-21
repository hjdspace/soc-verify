/* eslint-disable @typescript-eslint/no-explicit-any */
// Stub for engine/oh-my-pi/packages/coding-agent/src/sdk

export async function createAgentSession(_options: unknown): Promise<{
  session: any;
  eventBus: { on(channel: string, handler: (payload: unknown) => void): void };
}> {
  throw new Error('stub: should not be called at compile time');
}

export async function discoverAuthStorage(): Promise<any> {
  throw new Error('stub: should not be called at compile time');
}
