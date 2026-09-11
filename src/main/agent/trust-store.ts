/**
 * TrustStore — host 侧持久化信任存储（issue 04）。
 *
 * 记录两类信任决策，均在 pi 会话 init 时下发给 runner：
 *   - trustedProjectDirs：项目目录信任（决定 pi 项目 extension/settings 是否加载）
 *   - trustedMcpServers：MCP server 信任（决定 server 是否随会话启动）
 *
 * 安全边界：信任决策存储在 userData（应用数据目录）而非项目内 —— 不可被
 * 项目自身改写。文件缺失/损坏时 fail open 为「未信任」（重新走确认流程），
 * 绝不臆测为已信任。
 *
 * 文件格式：userData/<dir>/trust.json，versioned JSON，原子写（tmp + rename）。
 * 键为 workspace 目录（cwd），值为该 workspace 的信任集合。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE_NAME = 'trust.json';
const TMP_SUFFIX = '.tmp';
const CURRENT_VERSION = 1;

interface WorkspaceTrust {
  projectDirs: string[];
  mcpServers: string[];
}

interface PersistedTrust {
  version: number;
  workspaces: Record<string, WorkspaceTrust>;
}

function emptyWorkspaceTrust(): WorkspaceTrust {
  return { projectDirs: [], mcpServers: [] };
}

export class TrustStore {
  private readonly filePath: string;
  private readonly tmpPath: string;
  private cache: PersistedTrust | null = null;

  constructor(dirPath: string) {
    this.filePath = join(dirPath, FILE_NAME);
    this.tmpPath = `${this.filePath}${TMP_SUFFIX}`;
  }

  /** 从磁盘加载（带内存缓存）；缺失/损坏按空状态处理。 */
  async load(): Promise<void> {
    if (this.cache) return;
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as PersistedTrust;
      if (
        parsed.version !== CURRENT_VERSION ||
        typeof parsed.workspaces !== 'object' ||
        parsed.workspaces === null
      ) {
        this.cache = { version: CURRENT_VERSION, workspaces: {} };
        return;
      }
      this.cache = { version: CURRENT_VERSION, workspaces: parsed.workspaces };
    } catch {
      this.cache = { version: CURRENT_VERSION, workspaces: {} };
    }
  }

  getTrustedProjectDirs(workspaceDir: string): string[] {
    return [...(this.cache?.workspaces[workspaceDir]?.projectDirs ?? [])];
  }

  getTrustedMcpServers(workspaceDir: string): string[] {
    return [...(this.cache?.workspaces[workspaceDir]?.mcpServers ?? [])];
  }

  async addTrustedProjectDir(workspaceDir: string, dir: string): Promise<void> {
    await this.add(workspaceDir, (t) => {
      if (!t.projectDirs.includes(dir)) t.projectDirs.push(dir);
    });
  }

  async addTrustedMcpServer(workspaceDir: string, name: string): Promise<void> {
    await this.add(workspaceDir, (t) => {
      if (!t.mcpServers.includes(name)) t.mcpServers.push(name);
    });
  }

  private async add(
    workspaceDir: string,
    mutate: (t: WorkspaceTrust) => void,
  ): Promise<void> {
    await this.load();
    const cache = this.cache as PersistedTrust;
    const trust = cache.workspaces[workspaceDir] ?? emptyWorkspaceTrust();
    mutate(trust);
    cache.workspaces[workspaceDir] = trust;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true });
    await writeFile(this.tmpPath, `${JSON.stringify(this.cache, null, 2)}\n`, 'utf-8');
    await rename(this.tmpPath, this.filePath);
  }
}
