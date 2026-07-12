import { EventEmitter } from 'node:events';
import { readdir, stat, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, relative, extname } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
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

export interface ProjectEntry {
  info: ProjectInfo;
  watcher: FSWatcher | null;
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

    // Check if already open
    for (const [, entry] of this.projects) {
      if (entry.info.rootPath === rootPath) {
        entry.info.lastOpenedAt = Date.now();
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

    this.projects.set(projectId, { info, watcher });
    await this.saveProjectsDb();

    this.emit('project:opened', info);
    return info;
  }

  async closeProject(projectId: string): Promise<void> {
    const entry = this.projects.get(projectId);
    if (!entry) return;

    if (entry.watcher) {
      await entry.watcher.close();
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

      for (const entry of sorted) {
        if (DEFAULT_IGNORE_PATTERNS.some((pattern) => {
          if (pattern.startsWith('*')) {
            return entry.name.endsWith(pattern.slice(1));
          }
          return entry.name === pattern;
        })) continue;

        const childPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          node.children!.push(await this.buildFileTree(childPath, depth + 1));
        } else {
          node.children!.push({
            name: entry.name,
            path: childPath,
            type: 'file',
          });
        }
      }
    } catch {
      // Permission errors etc — return empty children
    }

    return node;
  }

  private startFileWatcher(projectId: string, rootPath: string): FSWatcher {
    const watcher = watch(rootPath, {
      ignored: DEFAULT_IGNORE_PATTERNS.map((p) =>
        p.startsWith('*') ? new RegExp(p.slice(1) + '$') : p
      ),
      persistent: false,
      ignoreInitial: true,
      depth: MAX_DEPTH,
    });

    watcher.on('add', (path) => {
      this.fileTreeCache.delete(projectId);
      const update: FileTreeUpdate = { projectId, type: 'add', path };
      this.emit('filetree:update', update);
    });

    watcher.on('unlink', (path) => {
      this.fileTreeCache.delete(projectId);
      const update: FileTreeUpdate = { projectId, type: 'unlink', path };
      this.emit('filetree:update', update);
    });

    watcher.on('addDir', () => {
      this.fileTreeCache.delete(projectId);
      const update: FileTreeUpdate = { projectId, type: 'add', path: rootPath };
      this.emit('filetree:update', update);
    });

    watcher.on('unlinkDir', () => {
      this.fileTreeCache.delete(projectId);
      const update: FileTreeUpdate = { projectId, type: 'unlink', path: rootPath };
      this.emit('filetree:update', update);
    });

    watcher.on('change', (path) => {
      const update: FileTreeUpdate = { projectId, type: 'change', path };
      this.emit('filetree:update', update);
    });

    return watcher;
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
      if (entry.watcher) {
        entry.watcher.close().catch(() => {});
      }
    }
    this.projects.clear();
    this.fileTreeCache.clear();
  }
}

export const projectManager = new ProjectManagerImpl();
