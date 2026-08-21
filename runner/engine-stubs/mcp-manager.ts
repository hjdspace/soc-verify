/* eslint-disable @typescript-eslint/no-explicit-any */
// Stub for engine/oh-my-pi/packages/coding-agent/src/mcp/manager

export class MCPManager {
  static instance(): MCPManager | null {
    throw new Error('stub: should not be called at compile time');
  }
  getAllServerNames(): string[] {
    throw new Error('stub: should not be called at compile time');
  }
  getConnectionStatus(_name: string): string {
    throw new Error('stub: should not be called at compile time');
  }
  getConnection(_name: string): { tools?: any[] } | null {
    throw new Error('stub: should not be called at compile time');
  }
  getTools(): any[] {
    throw new Error('stub: should not be called at compile time');
  }
  disconnectAll(): void {
    throw new Error('stub: should not be called at compile time');
  }
  async discoverAndConnect(): Promise<void> {
    throw new Error('stub: should not be called at compile time');
  }
}
