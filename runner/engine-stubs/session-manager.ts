/* eslint-disable @typescript-eslint/no-explicit-any */
// Stub for engine/oh-my-pi/packages/coding-agent/src/session/session-manager

export class SessionManager {
  static create(_cwd: string, _sessionDir: string): any {
    throw new Error('stub: should not be called at compile time');
  }
  static inMemory(): any {
    throw new Error('stub: should not be called at compile time');
  }
  static async list(_cwd: string, _sessionDir?: string): Promise<Array<{ id: string; path: string }>> {
    throw new Error('stub: should not be called at compile time');
  }
  static async open(_path: string): Promise<any> {
    throw new Error('stub: should not be called at compile time');
  }
  appendMessage(_msg: unknown): void {
    throw new Error('stub: should not be called at compile time');
  }
}
