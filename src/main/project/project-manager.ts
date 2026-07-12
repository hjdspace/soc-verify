import { EventEmitter } from 'node:events';
import { readdir, stat, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { existsSync, watch as fsWatch, type FSWatcher as NodeFSWatcher } from 'node:fs';
import { join, basename, relative, extname } from 'node:path';
import { app } from 'electron';
import type {
  ProjectInfo,
  ProjectState,
  FileTreeNode,
  FileTreeUpdate,
  PluginConfig,
} from '@shared/types';
import type { PluginConfigEntry } from '@shared/types';

const SOCVERIFY_DIR = '.socverify';
const PROJECTS_DB_FILE = 'projects.json';
const PROJECT_STATE_FILE = 'project-state.json';
const PLUGIN_CONFIG_FILE = 'plugins.json';

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  '.socverify',
  'out',
  'dist',
  'build',
  '__pycache__',
  '.next',
  '*.pyc',
  'coverage',
  'work',
  'sim_build',
];

const MAX_DEPTH = 5;
const WATCH_DEBOUNCE_MS = 500;

export interface ProjectEntry {
  info: ProjectInfo;
  watcher: NodeFSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
}

class ProjectManagerImpl extends EventEmitter {
  private projects = new Map<string, ProjectEntry>();
  private fileTreeCache = new Map<string, FileTreeNode>();

  // ─── 项目数据目录 ─────────────────────────────────────

  private get dataDir(): string {
    return join(app.getPath('userData'), 'socverify-data');
  }

  private get projectsDbPath(): string {
    return join(this.dataDir, PROJECTS_DB_FILE);
  }

  async ensureDataDir(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true });
    }
  }

  // ─── 项目打开/关闭/列表 ───────────────────────────────

  async openProject(rootPath: string, name?: string): Promise<ProjectInfo> {
    const statResult = await stat(rootPath);
    if (!statResult.isDirectory()) {
      throw new Error(`Path is not a directory: ${rootPath}`);
    }

    // Check if already open (including cold-restored entries with watcher=null)
    for (const [, entry] of this.projects) {
      if (entry.info.rootPath === rootPath) {
        entry.info.lastOpenedAt = Date.now();
        if (!entry.watcher) {
          entry.watcher = this.startFileWatcher(entry.info.id, rootPath);
        }
        await this.saveProjectsDb();
        return entry.info;
      }
    }

    const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const projectName = name ?? basename(rootPath);

    const info: ProjectInfo = {
      id: projectId,
      name: projectName,
      rootPath,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    };

    // Create .socverify directory if it doesn't exist
    await this.ensureSocverifyDir(rootPath);

    // Start file watcher
    const watcher = this.startFileWatcher(projectId, rootPath);

    this.projects.set(projectId, { info, watcher, debounceTimer: null });
    await this.saveProjectsDb();

    this.emit('project:opened', info);
    return info;
  }

  async closeProject(projectId: string): Promise<void> {
    const entry = this.projects.get(projectId);
    if (!entry) return;

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    if (entry.watcher) {
      entry.watcher.close();
    }
    this.projects.delete(projectId);
    this.fileTreeCache.delete(projectId);
    await this.saveProjectsDb();
    this.emit('project:closed', projectId);
  }

  async closeAllProjects(): Promise<void> {
    const ids = Array.from(this.projects.keys());
    await Promise.all(ids.map((id) => this.closeProject(id)));
  }

  listProjects(): ProjectInfo[] {
    return Array.from(this.projects.values()).map((e) => e.info);
  }

  getProject(projectId: string): ProjectInfo | null {
    return this.projects.get(projectId)?.info ?? null;
  }

  getProjectByPath(rootPath: string): ProjectInfo | null {
    for (const [, entry] of this.projects) {
      if (entry.info.rootPath === rootPath) return entry.info;
    }
    return null;
  }

  // ─── 文件树 ───────────────────────────────────────────

  async getFileTree(projectId: string): Promise<FileTreeNode> {
    const entry = this.projects.get(projectId);
    if (!entry) throw new Error(`Project not found: ${projectId}`);

    const cached = this.fileTreeCache.get(projectId);
    if (cached) return cached;

    const tree = await this.buildFileTree(entry.info.rootPath, 0);
    this.fileTreeCache.set(projectId, tree);
    return tree;
  }

  private async buildFileTree(dirPath: string, depth: number): Promise<FileTreeNode> {
    const name = basename(dirPath);
    const node: FileTreeNode = {
      name,
      path: dirPath,
      type: 'directory',
      children: [],
    };

    if (depth >= MAX_DEPTH) return node;

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      const filtered = sorted.filter((entry) =>
        !DEFAULT_IGNORE_PATTERNS.some((pattern) => {
          if (pattern.startsWith('*')) {
            return entry.name.endsWith(pattern.slice(1));
          }
          return entry.name === pattern;
        }),
      );

      // Build children in parallel for better performance
      const children = await Promise.all(
        filtered.map(async (entry) => {
          const childPath = join(dirPath, entry.name);
          if (entry.isDirectory()) {
            return this.buildFileTree(childPath, depth + 1);
          }
          return {
            name: entry.name,
            path: childPath,
            type: 'file' as const,
          };
        }),
      );
      node.children = children;
    } catch {
      // Permission errors etc — return empty children
    }

    return node;
  }

  private startFileWatcher(projectId: string, rootPath: string): NodeFSWatcher | null {
    // Use native fs.watch with recursive: true — a single kernel handle
    // watches the entire subtree (Windows/macOS use ReadDirectoryChangesW/FSEvents).
    // This is ~1500x faster than chokidar's per-directory handles on deep trees.
    let watcher: NodeFSWatcher | null = null;
    try {
      watcher = fsWatch(
        rootPath,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          const fullPath = join(rootPath, filename);
          // Filter out .socverify internal changes (config writes etc.)
          if (filename.includes('.socverify')) return;
          // Ignore changes to known build/dependency dirs
          for (const pattern of DEFAULT_IGNORE_PATTERNS) {
            const needle = pattern.startsWith('*') ? pattern.slice(1) : pattern;
            if (filename.includes(needle)) return;
          }
          this.scheduleDebouncedUpdate(projectId, fullPath);
        },
      );
    } catch (err) {
      console.warn(`[project-manager] fs.watch failed for ${rootPath}:`, err);
      return null;
    }
    return watcher;
  }

  /**
   * Collapse a burst of file-change events into a single cache-invalidation +
   * filetree:update emission. Without this, 50 file changes trigger 50 full
   * tree re-walks (each ~120ms) — a multi-second cascade.
   */
  private scheduleDebouncedUpdate(projectId: string, path: string): void {
    const entry = this.projects.get(projectId);
    if (!entry) return;

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }

    entry.debounceTimer = setTimeout(() => {
      this.fileTreeCache.delete(projectId);
      const update: FileTreeUpdate = { projectId, type: 'change', path };
      this.emit('filetree:update', update);
      entry.debounceTimer = null;
    }, WATCH_DEBOUNCE_MS);
  }

  // ─── .socverify 配置目录 ──────────────────────────────

  async ensureSocverifyDir(projectRoot: string): Promise<string> {
    const dir = join(projectRoot, SOCVERIFY_DIR);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Ensure default config files exist
    await this.ensurePluginConfig(projectRoot);
    await this.ensureProjectConfig(projectRoot);
    return dir;
  }

  private async ensurePluginConfig(projectRoot: string): Promise<void> {
    const configPath = join(projectRoot, SOCVERIFY_DIR, PLUGIN_CONFIG_FILE);
    if (!existsSync(configPath)) {
      await writeFile(configPath, JSON.stringify({ plugins: [] }, null, 2), 'utf-8');
    }
  }

  private async ensureProjectConfig(projectRoot: string): Promise<void> {
    const configPath = join(projectRoot, SOCVERIFY_DIR, 'config.json');
    if (!existsSync(configPath)) {
      await writeFile(
        configPath,
        JSON.stringify({ name: basename(projectRoot), createdAt: Date.now() }, null, 2),
        'utf-8',
      );
    }
  }

  // ─── 插件配置 ─────────────────────────────────────────

  async getPluginConfig(projectRoot: string): Promise<PluginConfig> {
    const configPath = join(projectRoot, SOCVERIFY_DIR, PLUGIN_CONFIG_FILE);
    try {
      const content = await readFile(configPath, 'utf-8');
      return JSON.parse(content) as PluginConfig;
    } catch {
      return { plugins: [] };
    }
  }

  async savePluginConfig(projectRoot: string, config: PluginConfig): Promise<void> {
    const configPath = join(projectRoot, SOCVERIFY_DIR, PLUGIN_CONFIG_FILE);
    await this.ensureSocverifyDir(projectRoot);
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  async togglePlugin(projectRoot: string, pluginId: string, enabled: boolean): Promise<PluginConfig> {
    const config = await this.getPluginConfig(projectRoot);
    const entry = config.plugins.find((p) => p.id === pluginId);
    if (entry) {
      entry.enabled = enabled;
      await this.savePluginConfig(projectRoot, config);
    }
    return config;
  }

  // ─── 项目状态持久化 ───────────────────────────────────

  async saveProjectState(state: ProjectState): Promise<void> {
    await this.ensureDataDir();
    const statePath = join(this.dataDir, `state_${state.projectId}.json`);
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  async getProjectState(projectId: string): Promise<ProjectState | null> {
    const statePath = join(this.dataDir, `state_${projectId}.json`);
    try {
      const content = await readFile(statePath, 'utf-8');
      return JSON.parse(content) as ProjectState;
    } catch {
      return null;
    }
  }

  // ─── 项目数据库（项目列表持久化）────────────────────

  async loadProjectsDb(): Promise<ProjectInfo[]> {
    try {
      const content = await readFile(this.projectsDbPath, 'utf-8');
      return JSON.parse(content) as ProjectInfo[];
    } catch {
      return [];
    }
  }

  /**
   * Cold-restore persisted projects on app startup: load ProjectInfo metadata
   * into memory without starting chokidar watchers. Watchers are lazily
   * started by `openProject()` when the user actually activates the project.
   * Projects whose rootPath no longer exists on disk are skipped.
   */
  async restorePersistedProjects(): Promise<number> {
    const persisted = await this.loadProjectsDb();
    for (const info of persisted) {
      if (this.projects.has(info.id)) continue;
      if (!existsSync(info.rootPath)) continue;
      this.projects.set(info.id, { info, watcher: null, debounceTimer: null });
    }
    return persisted.length;
  }

  async saveProjectsDb(): Promise<void> {
    await this.ensureDataDir();
    const projects = this.listProjects();
    await writeFile(this.projectsDbPath, JSON.stringify(projects, null, 2), 'utf-8');
  }

  // ─── 文件读取 ─────────────────────────────────────────

  async readFile(projectId: string, filePath: string): Promise<string> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // Ensure file is within project root
    const rel = relative(project.rootPath, filePath);
    if (rel.startsWith('..')) throw new Error('File path is outside project root');

    return readFile(filePath, 'utf-8');
  }

  // ─── 新建项目 ─────────────────────────────────────────

  async createProject(rootPath: string, name: string, pluginEntries?: PluginConfigEntry[]): Promise<ProjectInfo> {
    // Verify path exists or create it
    if (!existsSync(rootPath)) {
      await mkdir(rootPath, { recursive: true });
    }

    const info = await this.openProject(rootPath, name);

    // Save initial plugin config
    if (pluginEntries && pluginEntries.length > 0) {
      await this.savePluginConfig(rootPath, { plugins: pluginEntries });
    }

    return info;
  }

  // ─── 清理 ─────────────────────────────────────────────

  destroy(): void {
    for (const [, entry] of this.projects) {
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
      }
      if (entry.watcher) {
        entry.watcher.close();
      }
    }
    this.projects.clear();
    this.fileTreeCache.clear();
  }
}

export const projectManager = new ProjectManagerImpl();
