import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SETTINGS_FILE = 'agent-tools.json';

export type BuiltinToolInfo = {
  name: string;
  /** 中文标签（来自静态目录，设置页展示用） */
  label?: string;
  description: string;
};

type StoredToolSettings = {
  /** 被禁用的工具名（host 工具 + omp 内置工具共用一个命名空间） */
  disabledTools: string[];
  /** 最近一次从 omp 会话枚举到的内置工具快照（用于无活跃会话时展示设置页） */
  builtinCatalog: BuiltinToolInfo[];
};

const DEFAULTS: StoredToolSettings = {
  disabledTools: [],
  builtinCatalog: [],
};

class ToolSettingsImpl {
  private cached: StoredToolSettings | null = null;

  private get dataDir(): string {
    return join(app.getPath('userData'), 'socverify-data');
  }

  private get settingsPath(): string {
    return join(this.dataDir, SETTINGS_FILE);
  }

  async load(): Promise<StoredToolSettings> {
    if (this.cached) return this.cached;
    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, 'utf-8')) as Partial<StoredToolSettings>;
      this.cached = {
        disabledTools: Array.isArray(parsed.disabledTools)
          ? parsed.disabledTools.filter((n): n is string => typeof n === 'string')
          : [],
        builtinCatalog: Array.isArray(parsed.builtinCatalog)
          ? parsed.builtinCatalog.filter(
              (t): t is BuiltinToolInfo =>
                typeof t === 'object' && t !== null && typeof t.name === 'string',
            )
          : [],
      };
    } catch {
      this.cached = { ...DEFAULTS };
    }
    return this.cached;
  }

  private async save(next: StoredToolSettings): Promise<void> {
    this.cached = next;
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.settingsPath, JSON.stringify(next, null, 2), 'utf-8');
  }

  async getDisabledTools(): Promise<string[]> {
    return (await this.load()).disabledTools;
  }

  async setDisabledTools(tools: string[]): Promise<void> {
    const current = await this.load();
    await this.save({ ...current, disabledTools: Array.from(new Set(tools)) });
  }

  async getBuiltinCatalog(): Promise<BuiltinToolInfo[]> {
    return (await this.load()).builtinCatalog;
  }

  /** 缓存最近一次枚举到的 omp 内置工具列表（仅当发生变化时写盘） */
  async saveBuiltinCatalog(tools: BuiltinToolInfo[]): Promise<void> {
    const current = await this.load();
    if (
      current.builtinCatalog.length === tools.length &&
      current.builtinCatalog.every((t, i) => t.name === tools[i]?.name)
    ) {
      return;
    }
    await this.save({ ...current, builtinCatalog: tools });
  }
}

export const toolSettings = new ToolSettingsImpl();
