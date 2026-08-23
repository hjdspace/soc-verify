import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, watch as fsWatch, type FSWatcher as NodeFSWatcher } from 'node:fs';
import { join, basename, relative, resolve, normalize, sep } from 'node:path';
import { app } from 'electron';
import { readFileSync } from 'node:fs';

const execFileAsync = promisify(execFile);
import type {
  ProjectInfo,
  ProjectState,
  FileTreeNode,
  FileTreeUpdate,
  ExtraDirEntry,
  DirGroup,
} from '@shared/types';

const SOCVERIFY_DIR = '.socverify';
const PROJECTS_DB_FILE = 'projects.json';
const _PROJECT_STATE_FILE = 'project-state.json';
const PLUGIN_CONFIG_FILE = 'plugins.json';

// Only hide application-internal directories. All user directories (node_modules,
// dist, build, etc.) are fully visible — performance is handled by the tree's
// virtual scroller and lazy expansion, not by hiding content.
const HIDDEN_DIRS = new Set(['.socverify', '.git']);

const WATCH_DEBOUNCE_MS = 500;
const DIRECTORY_CACHE_TTL_MS = 60_000;
const PREFETCH_CONCURRENCY = 2;
const PREFETCH_DIRECTORY_LIMIT = 500;

type DirectoryChildrenCacheEntry = {
  children: FileTreeNode[];
  expiresAt: number;
};

export function shouldUseRecursiveFileWatcher(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Per-directory watcher state: one fs.watch handle + debounce timer. */
export interface DirWatcherEntry {
  watcher: NodeFSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
}

export interface ProjectEntry {
  info: ProjectInfo;
  watcher: NodeFSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
  /** Extra directory watchers: keyed by dirId. */
  dirWatchers: Map<string, DirWatcherEntry>;
}

class ProjectManagerImpl extends EventEmitter {
  private projects = new Map<string, ProjectEntry>();
  private fileTreeCache = new Map<string, FileTreeNode>();
  private directoryChildrenCache = new Map<string, DirectoryChildrenCacheEntry>();
  private directoryChildrenRequests = new Map<string, Promise<FileTreeNode[]>>();
  private fileTreeCacheGenerations = new Map<string, number>();

  /** Cache key suffix for rootPath file tree. */
  private static readonly ROOT_DIR_ID = 'root';

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
        // Migrate old projects: ensure extraDirs is initialized
        this.migrateExtraDirs(entry.info);
        if (!entry.watcher) {
          entry.watcher = this.startFileWatcher(entry.info.id, rootPath);
        }
        await this.saveProjectsDb();
        return entry.info;
      }
    }

    const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const projectName = name ?? basename(rootPath);

    // Restore extraDirs from persisted projects.json if this rootPath was previously saved.
    // This handles the close→reopen cycle: closeProject removes from memory, but the
    // projects.json on disk still has the extraDirs data.
    const persisted = await this.loadProjectsDb();
    const existing = persisted.find(
      (p) => normalize(resolve(p.rootPath)) === normalize(resolve(rootPath)),
    );

    // Resolve projectLabel: persisted > $PROJ_RTL env > null
    const projectLabel = existing?.projectLabel ?? (await this.resolveProjectLabel(rootPath));

    const info: ProjectInfo = {
      id: projectId,
      name: projectName,
      rootPath,
      projectLabel: projectLabel ?? undefined,
      extraDirs: existing?.extraDirs,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    };

    // Create .socverify directory if it doesn't exist
    await this.ensureSocverifyDir(rootPath);

    // Start file watcher
    const watcher = this.startFileWatcher(projectId, rootPath);

    this.projects.set(projectId, { info, watcher, debounceTimer: null, dirWatchers: new Map() });

    // Start watchers for any extraDirs restored from persisted state
    await this.startExtraDirWatchers(projectId, info);
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
    // Close all extra directory watchers
    for (const [, dirEntry] of entry.dirWatchers) {
      if (dirEntry.debounceTimer) {
        clearTimeout(dirEntry.debounceTimer);
      }
      if (dirEntry.watcher) {
        dirEntry.watcher.close();
      }
    }
    // Save before deleting from memory so projects.json retains the project
    // (including extraDirs) for restoration on next openProject.
    await this.saveProjectsDb();
    this.projects.delete(projectId);
    // Clear all file tree caches for this project (root + all extra dirs)
    for (const key of this.fileTreeCache.keys()) {
      if (key.startsWith(projectId + ':')) {
        this.fileTreeCache.delete(key);
      }
    }
    for (const key of this.directoryChildrenCache.keys()) {
      if (key.startsWith(projectId + ':')) {
        this.directoryChildrenCache.delete(key);
      }
    }
    for (const key of this.directoryChildrenRequests.keys()) {
      if (key.startsWith(projectId + ':')) {
        this.directoryChildrenRequests.delete(key);
      }
    }
    for (const [scopeKey, generation] of this.fileTreeCacheGenerations) {
      if (scopeKey.startsWith(projectId + ':')) {
        this.fileTreeCacheGenerations.set(scopeKey, generation + 1);
      }
    }
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

    const cacheKey = `${projectId}:${ProjectManagerImpl.ROOT_DIR_ID}`;
    const cached = this.fileTreeCache.get(cacheKey);
    if (cached) return cached;

    // Lazy loading: only build the root level (depth 0 → 1) for instant display.
    // Deeper directories are fetched on demand via getDirChildren().
    // This follows the VS Code AsyncDataTree pattern: the root resolves quickly,
    // children are loaded when the user expands a directory.
    const tree = await this.buildFileTreeShallow(entry.info.rootPath);

    // git-ignore marking is deferred — it requires running `git ls-files --ignored`
    // which can be slow on large repos. The UI renders immediately; ignored paths
    // are marked via a separate non-blocking pass (getDirChildren applies it per-dir).
    // Only do the initial mark if git is available and fast.
    this.fileTreeCache.set(cacheKey, tree);
    this.scheduleDirectoryPrefetch(projectId, ProjectManagerImpl.ROOT_DIR_ID, tree.children ?? []);
    return tree;
  }

  /**
   * Get the file tree for an extra directory (by dirId).
   * Each directory has its own independent cache and lazy loading.
   * The watcher is started on first access if not already running.
   */
  async getDirFileTree(projectId: string, dirId: string): Promise<FileTreeNode> {
    const entry = this.projects.get(projectId);
    if (!entry) throw new Error(`Project not found: ${projectId}`);

    const dirs = entry.info.extraDirs ?? [];
    const dir = dirs.find((d) => d.id === dirId);
    if (!dir) throw new Error(`Directory not found: ${dirId}`);

    const cacheKey = `${projectId}:${dirId}`;
    const cached = this.fileTreeCache.get(cacheKey);
    if (cached) return cached;

    const tree = await this.buildFileTreeShallow(dir.path);
    this.fileTreeCache.set(cacheKey, tree);
    this.scheduleDirectoryPrefetch(projectId, dirId, tree.children ?? []);

    // Ensure the watcher is started for this directory
    this.ensureDirWatcher(projectId, entry, dirId, dir.path);

    return tree;
  }

  /**
   * Get the direct children of a directory (one level deep).
   * Used for lazy loading: the UI calls this when a directory is first expanded.
   * Returns sorted entries with directories marked `lazy: true` if they may have children.
   * Applies git-ignore marking if the ignored-paths cache is available.
   *
   * @param dirId Optional: when provided, the security check uses the directory
   *              identified by dirId (an extraDir or 'root' for rootPath).
   *              When omitted, falls back to rootPath security check.
   */
  async getDirChildren(projectId: string, dirPath: string, dirId?: string): Promise<FileTreeNode[]> {
    const entry = this.projects.get(projectId);
    if (!entry) throw new Error(`Project not found: ${projectId}`);

    // Security: ensure the path is within an allowed directory
    if (dirId && dirId !== ProjectManagerImpl.ROOT_DIR_ID) {
      // Extra directory: check against the specific extraDir path
      const dirs = entry.info.extraDirs ?? [];
      const dir = dirs.find((d) => d.id === dirId);
      if (!dir) throw new Error(`Directory not found: ${dirId}`);
      const rel = relative(dir.path, dirPath);
      if (rel.startsWith('..')) throw new Error('Path is outside directory scope');
    } else {
      // RootPath security check
      const rel = relative(entry.info.rootPath, dirPath);
      if (rel.startsWith('..')) throw new Error('Path is outside project root');
    }

    return this.loadDirectoryChildren(projectId, dirId ?? ProjectManagerImpl.ROOT_DIR_ID, dirPath);
  }

  private scheduleDirectoryPrefetch(projectId: string, dirId: string, rootChildren: FileTreeNode[]): void {
    const scopeKey = this.fileTreeScopeKey(projectId, dirId);
    const generation = this.fileTreeCacheGenerations.get(scopeKey) ?? 0;

    setTimeout(() => {
      if (!this.projects.has(projectId)) return;
      void this.prefetchDirectories(projectId, dirId, rootChildren, generation);
    }, 0);
  }

  private async prefetchDirectories(
    projectId: string,
    dirId: string,
    rootChildren: FileTreeNode[],
    generation: number,
  ): Promise<void> {
    const scopeKey = this.fileTreeScopeKey(projectId, dirId);
    const queue = rootChildren.filter(
      (child) => child.type === 'directory' && !HIDDEN_DIRS.has(child.name),
    );
    let nextIndex = 0;
    let visited = 0;

    const worker = async (): Promise<void> => {
      while (
        nextIndex < queue.length
        && visited < PREFETCH_DIRECTORY_LIMIT
        && this.projects.has(projectId)
        && (this.fileTreeCacheGenerations.get(scopeKey) ?? 0) === generation
      ) {
        const directory = queue[nextIndex++];
        visited++;

        try {
          const children = await this.loadDirectoryChildren(projectId, dirId, directory.path);
          for (const child of children) {
            if (child.type === 'directory' && !HIDDEN_DIRS.has(child.name)) {
              queue.push(child);
            }
          }
        } catch {
          // Background prefetch is best-effort; foreground expansion reports its own result.
        }
      }
    };

    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, () => worker()));
  }

  private async loadDirectoryChildren(
    projectId: string,
    dirId: string,
    dirPath: string,
  ): Promise<FileTreeNode[]> {
    const scopeKey = this.fileTreeScopeKey(projectId, dirId);
    const cacheKey = `${scopeKey}:${normalize(resolve(dirPath))}`;
    const cached = this.directoryChildrenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.children;
    if (cached) this.directoryChildrenCache.delete(cacheKey);

    const pending = this.directoryChildrenRequests.get(cacheKey);
    if (pending) return pending;

    const generation = this.fileTreeCacheGenerations.get(scopeKey) ?? 0;
    const request = this.buildFileTreeShallowChildren(dirPath)
      .then((children) => {
        if (
          this.projects.has(projectId)
          && (this.fileTreeCacheGenerations.get(scopeKey) ?? 0) === generation
        ) {
          this.directoryChildrenCache.set(cacheKey, {
            children,
            expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS,
          });
        }
        return children;
      })
      .finally(() => {
        if (this.directoryChildrenRequests.get(cacheKey) === request) {
          this.directoryChildrenRequests.delete(cacheKey);
        }
      });

    this.directoryChildrenRequests.set(cacheKey, request);
    return request;
  }

  private fileTreeScopeKey(projectId: string, dirId: string): string {
    return `${projectId}:${dirId}`;
  }

  private invalidateFileTreeScope(projectId: string, dirId: string): void {
    const scopeKey = this.fileTreeScopeKey(projectId, dirId);
    this.fileTreeCache.delete(scopeKey);
    this.fileTreeCacheGenerations.set(
      scopeKey,
      (this.fileTreeCacheGenerations.get(scopeKey) ?? 0) + 1,
    );

    const prefix = `${scopeKey}:`;
    for (const key of this.directoryChildrenCache.keys()) {
      if (key.startsWith(prefix)) this.directoryChildrenCache.delete(key);
    }
    for (const key of this.directoryChildrenRequests.keys()) {
      if (key.startsWith(prefix)) this.directoryChildrenRequests.delete(key);
    }
  }

  /**
   * Run `git ls-files --ignored` once to get the set of ignored paths.
   * Returns an empty set when the project is not a git repo or git is unavailable.
   * Paths are normalised to absolute, OS-native form (matching FileTreeNode.path).
   */
  private async getGitIgnoredPaths(rootPath: string): Promise<Set<string>> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', rootPath, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
        { cwd: rootPath, maxBuffer: 10 * 1024 * 1024 },
      );

      const ignored = new Set<string>();
      for (const raw of stdout.split('\0')) {
        if (!raw) continue;
        // `--directory` emits trailing '/' for directories; strip it so join() works.
        const clean = raw.replace(/\/$/, '');
        if (clean) ignored.add(join(rootPath, clean));
      }
      return ignored;
    } catch {
      // Not a git repo or git not installed — no git-ignore info available.
      return new Set();
    }
  }

  /**
   * Walk the file tree and set `gitIgnored` on every node.
   * If a parent directory is ignored, all descendants inherit the flag.
   */
  private markGitIgnored(node: FileTreeNode, ignoredPaths: Set<string>, parentIgnored: boolean): void {
    if (parentIgnored || ignoredPaths.has(node.path)) {
      node.gitIgnored = true;
    }
    if (node.children) {
      for (const child of node.children) {
        this.markGitIgnored(child, ignoredPaths, node.gitIgnored ?? false);
      }
    }
  }

  /**
   * Build the root tree node with only its direct children (one level deep).
   * Directories are marked `lazy: true` so the UI knows to fetch children on expand.
   * This replaces the old recursive buildFileTree that walked the entire tree.
   */
  private async buildFileTreeShallow(rootPath: string): Promise<FileTreeNode> {
    const name = basename(rootPath);
    const node: FileTreeNode = {
      name,
      path: rootPath,
      type: 'directory',
      children: [],
    };

    try {
      node.children = await this.buildFileTreeShallowChildren(rootPath);
    } catch {
      // Permission errors etc — return empty children
    }

    return node;
  }

  /**
   * Read the direct children of a directory and return sorted FileTreeNode[].
   * Directories are marked `lazy: true` (children not yet loaded).
   * Internal directories (.socverify, .git) are marked gitIgnored.
   */
  private async buildFileTreeShallowChildren(dirPath: string): Promise<FileTreeNode[]> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    return sorted.map((entry) => {
      const childPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const child: FileTreeNode = {
          name: entry.name,
          path: childPath,
          type: 'directory',
          children: [],
          lazy: true,
        };
        if (HIDDEN_DIRS.has(entry.name)) {
          child.gitIgnored = true;
        }
        return child;
      }
      return {
        name: entry.name,
        path: childPath,
        type: 'file' as const,
      };
    });
  }

  /**
   * Start fs.watch for an extra directory and store it in the project's dirWatchers map.
   * Idempotent: if a watcher already exists for this dirId, it is not recreated.
   */
  private ensureDirWatcher(projectId: string, entry: ProjectEntry, dirId: string, dirPath: string): void {
    if (entry.dirWatchers.has(dirId)) return;

    const watcher = this.startDirFileWatcher(projectId, dirPath, dirId);
    entry.dirWatchers.set(dirId, { watcher, debounceTimer: null });
  }

  /**
   * Start watchers for all extraDirs that are already in the project's extraDirs.
   * Called during project open/restore to re-establish watchers for persisted dirs.
   */
  private async startExtraDirWatchers(projectId: string, info: ProjectInfo): Promise<void> {
    const entry = this.projects.get(projectId);
    if (!entry) return;
    const dirs = info.extraDirs ?? [];
    for (const dir of dirs) {
      if (!existsSync(dir.path)) continue;
      this.ensureDirWatcher(projectId, entry, dir.id, dir.path);
    }
  }

  /**
   * Create an fs.watch handle for an extra directory, emitting filetree:update
   * on changes with the dirId for cache invalidation.
   */
  private startDirFileWatcher(projectId: string, rootPath: string, dirId: string): NodeFSWatcher | null {
    let watcher: NodeFSWatcher | null = null;
    try {
      watcher = fsWatch(
        rootPath,
        { recursive: shouldUseRecursiveFileWatcher(process.platform) },
        (_eventType, filename) => {
          if (!filename) return;
          const fullPath = join(rootPath, filename);
          if (filename.includes('.socverify') || filename.includes('.git')) return;
          this.scheduleDebouncedUpdate(projectId, fullPath, dirId);
        },
      );
    } catch (err) {
      console.warn(`[project-manager] fs.watch failed for extra dir ${rootPath}:`, err);
      return null;
    }
    return watcher;
  }

  private startFileWatcher(projectId: string, rootPath: string): NodeFSWatcher | null {
    // Windows/macOS provide native recursive watching. On Linux, Node emulates it
    // by synchronously walking the entire tree and watching every entry, which
    // blocks project opening on large or network-mounted repositories.
    let watcher: NodeFSWatcher | null = null;
    try {
      watcher = fsWatch(
        rootPath,
        { recursive: shouldUseRecursiveFileWatcher(process.platform) },
        (_eventType, filename) => {
          if (!filename) return;
          const fullPath = join(rootPath, filename);
          // Filter out application-internal directory changes
          if (filename.includes('.socverify') || filename.includes('.git')) return;
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
   *
   * @param dirId The directory ID for cache key ('root' for rootPath, or an extraDir ID).
   *              Defaults to 'root'.
   */
  private scheduleDebouncedUpdate(projectId: string, path: string, dirId: string = ProjectManagerImpl.ROOT_DIR_ID): void {
    const entry = this.projects.get(projectId);
    if (!entry) return;

    // Determine which timer to use: root watcher or a specific extraDir watcher
    let timer: NodeJS.Timeout | null;
    let setTimer: (t: NodeJS.Timeout | null) => void;

    if (dirId === ProjectManagerImpl.ROOT_DIR_ID) {
      timer = entry.debounceTimer;
      setTimer = (t) => { entry.debounceTimer = t; };
    } else {
      const dirEntry = entry.dirWatchers.get(dirId);
      if (!dirEntry) return;
      timer = dirEntry.debounceTimer;
      setTimer = (t) => { dirEntry.debounceTimer = t; };
    }

    if (timer) {
      clearTimeout(timer);
    }

    const newTimer = setTimeout(() => {
      this.invalidateFileTreeScope(projectId, dirId);
      const update: FileTreeUpdate = { projectId, type: 'change', path };
      this.emit('filetree:update', update);
      setTimer(null);
    }, WATCH_DEBOUNCE_MS);
    setTimer(newTimer);
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

    // Ensure `.socverify` is git-ignored: append to `.gitignore` if missing,
    // create `.gitignore` if it doesn't exist. Idempotent — no-op when already ignored.
    await this.ensureGitignoreEntry(projectRoot);
    return dir;
  }

  /**
   * 保证项目根目录的 `.gitignore` 中包含 `.socverify` 条目。
   *
   * - `.gitignore` 不存在：新建并写入条目
   * - `.gitignore` 存在但未忽略 `.socverify`：在末尾追加条目
   * - 已存在条目（含 `.socverify/` 变体）：幂等不修改
   *
   * 写入失败仅记录日志，不阻断项目打开流程。
   */
  private async ensureGitignoreEntry(projectRoot: string): Promise<void> {
    const gitignorePath = join(projectRoot, '.gitignore');
    const ENTRY = SOCVERIFY_DIR; // `.socverify`

    let content = '';
    try {
      content = await readFile(gitignorePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[project-manager] failed to read .gitignore at ${gitignorePath}:`, err);
        return;
      }
      // .gitignore 不存在 — 新建并写入条目
      try {
        await writeFile(gitignorePath, `# SoC Verify workspace\n${ENTRY}\n`, 'utf-8');
      } catch (writeErr) {
        console.warn(`[project-manager] failed to create .gitignore at ${gitignorePath}:`, writeErr);
      }
      return;
    }

    // 检查是否已忽略：行首匹配 `.socverify` 或 `.socverify/`，允许前导空白和行内注释
    const alreadyIgnored = content.split(/\r?\n/).some((line) => {
      const hashIdx = line.indexOf('#');
      const pattern = (hashIdx >= 0 ? line.slice(0, hashIdx) : line).trim();
      return pattern === ENTRY || pattern === `${ENTRY}/`;
    });
    if (alreadyIgnored) return;

    // 追加条目，确保既有内容以换行结尾
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    try {
      await writeFile(gitignorePath, content + `${prefix}\n# SoC Verify workspace\n${ENTRY}\n`, 'utf-8');
    } catch (writeErr) {
      console.warn(`[project-manager] failed to append .socverify to ${gitignorePath}:`, writeErr);
    }
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
      // Try to resolve projectLabel from $PROJ_RTL on first open
      const projectLabel = await this.resolveProjectLabel(projectRoot);
      await writeFile(
        configPath,
        JSON.stringify({ name: basename(projectRoot), createdAt: Date.now(), ...(projectLabel ? { projectLabel } : {}) }, null, 2),
        'utf-8',
      );
    }
  }

  // ─── 项目标记名（projectLabel）解析与修改 ────────────────

  /**
   * 解析项目标记名（projectLabel），优先级：
   * 1. .socverify/config.json 中已保存的 projectLabel
   * 2. $PROJ_RTL 环境变量路径中的项目名（/proj/<ProjectName>/xxx → 第二级目录）
   * 3. null（无可用标记，UI 显示目录名）
   *
   * $PROJ_RTL 的解析顺序：process.env → .socverify/env.json
   * 路径结构 /proj/<ProjectName>/xxx，取第二级目录作为项目名。
   */
  async resolveProjectLabel(rootPath: string): Promise<string | null> {
    // 1. Try persisted config
    const configLabel = this.readProjectConfigLabel(rootPath);
    if (configLabel) return configLabel;

    // 2. Try $PROJ_RTL
    const projRtl = this.resolveProjRtl(rootPath);
    if (projRtl) {
      const parsed = this.parseProjectNameFromPath(projRtl);
      if (parsed) return parsed;
    }

    // 3. No label available
    return null;
  }

  /**
   * 从 $PROJ_RTL 路径中解析项目名。
   *
   * 目录结构 /proj/<ProjectName>/xxx，取第二级目录名。
   * 例如：/proj/kunlun/rtl → kunlun
   *      /home/user/proj/chipA/de → chipA
   *
   * 如果路径不符合 /proj/<name>/ 结构，返回 null。
   */
  private parseProjectNameFromPath(projRtlPath: string): string | null {
    const normalized = normalize(resolve(projRtlPath));
    const parts = normalized.split(sep).filter(Boolean);

    // Find 'proj' in the path, take the next segment as project name
    const projIdx = parts.findIndex((p) => p.toLowerCase() === 'proj');
    if (projIdx >= 0 && projIdx + 1 < parts.length) {
      return parts[projIdx + 1];
    }

    return null;
  }

  /**
   * Resolve $PROJ_RTL from process.env, falling back to .socverify/env.json.
   * Matches the pattern used by git-manager and sysbase-gen tools.
   */
  private resolveProjRtl(projectDir: string): string | null {
    const envVal = process.env.PROJ_RTL;
    if (envVal && envVal.trim()) return envVal.trim();

    try {
      const configPath = join(projectDir, SOCVERIFY_DIR, 'env.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        envVars?: Record<string, string>;
      };
      const configured = config?.envVars?.PROJ_RTL;
      if (typeof configured === 'string' && configured.trim()) {
        return configured.trim();
      }
    } catch {
      // Config file not found or invalid
    }

    return null;
  }

  /** Read the projectLabel from .socverify/config.json (if it exists). */
  private readProjectConfigLabel(projectRoot: string): string | null {
    try {
      const configPath = join(projectRoot, SOCVERIFY_DIR, 'config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        projectLabel?: string;
      };
      if (typeof config.projectLabel === 'string' && config.projectLabel.trim()) {
        return config.projectLabel.trim();
      }
    } catch {
      // Config not found or invalid
    }
    return null;
  }

  /**
   * 修改项目标记名（projectLabel）。
   *
   * - 更新 ProjectInfo.projectLabel（内存 + projects.json）
   * - 同步更新 .socverify/config.json 中的 projectLabel 字段
   * - 发出 'project:renamed' 事件
   */
  async renameProject(projectId: string, newLabel: string): Promise<ProjectInfo> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const trimmed = newLabel.trim();
    if (!trimmed) throw new Error('Project label cannot be empty');

    project.projectLabel = trimmed;

    // Sync to .socverify/config.json
    await this.updateProjectConfigLabel(project.rootPath, trimmed);

    // Persist to projects.json
    await this.saveProjectsDb();

    this.emit('project:renamed', project);
    return project;
  }

  /** Update the projectLabel field in .socverify/config.json, preserving other fields. */
  private async updateProjectConfigLabel(projectRoot: string, label: string): Promise<void> {
    const configPath = join(projectRoot, SOCVERIFY_DIR, 'config.json');
    let config: Record<string, unknown> = {};
    try {
      const content = await readFile(configPath, 'utf-8');
      config = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // File doesn't exist — will create
    }
    config.projectLabel = label;
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
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
      this.projects.set(info.id, { info, watcher: null, debounceTimer: null, dirWatchers: new Map() });
    }
    return persisted.length;
  }

  async saveProjectsDb(): Promise<void> {
    await this.ensureDataDir();
    const projects = this.listProjects();
    await writeFile(this.projectsDbPath, JSON.stringify(projects, null, 2), 'utf-8');
  }

  // ─── 文件读写 ─────────────────────────────────────────

  async readFile(projectId: string, filePath: string): Promise<string> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    if (!this.isPathWithinProjectDirs(project, filePath)) {
      throw new Error('File path is outside project directories');
    }

    return readFile(filePath, 'utf-8');
  }

  async writeFile(projectId: string, filePath: string, content: string): Promise<void> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    if (!this.isPathWithinProjectDirs(project, filePath)) {
      throw new Error('File path is outside project directories');
    }

    await writeFile(filePath, content, 'utf-8');
  }

  // ─── 新建项目 ─────────────────────────────────────────

  async createProject(rootPath: string, name: string): Promise<ProjectInfo> {
    // Verify path exists or create it
    if (!existsSync(rootPath)) {
      await mkdir(rootPath, { recursive: true });
    }

    const info = await this.openProject(rootPath, name);

    return info;
  }

  // ─── 多目录管理 ───────────────────────────────────────

  /**
   * 获取项目的所有额外目录列表。
   * 旧项目（extraDirs 不存在）返回空数组——rootPath 隐式作为验证组第一项和 cwd。
   */
  getExtraDirs(projectId: string): ExtraDirEntry[] {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project.extraDirs ?? [];
  }

  /**
   * 向项目添加一个额外目录。
   *
   * - 路径必须是已存在的目录
   * - 不允许重复添加（路径已存在于 rootPath 或 extraDirs 中）
   * - group 必须是 'verify' 或 'design'
   * - 新目录的 order 为同组已有最大 order + 1
   * - 新目录默认 isCwd = false（rootPath 是隐式 cwd）
   *
   * 添加后持久化到 projects.json。
   */
  async addDir(
    projectId: string,
    path: string,
    group: DirGroup,
    label?: string,
  ): Promise<ExtraDirEntry> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // Validate group
    if (group !== 'verify' && group !== 'design') {
      throw new Error(`Invalid directory group: ${group}. Must be 'verify' or 'design'`);
    }

    // Normalize paths for comparison
    const normalizedNew = normalize(resolve(path));
    const normalizedRoot = normalize(resolve(project.rootPath));

    // Reject if path equals rootPath
    if (normalizedNew === normalizedRoot) {
      throw new Error('Path is the project rootPath — rootPath is implicitly included');
    }

    // Check path exists and is a directory
    const statResult = await stat(path);
    if (!statResult.isDirectory()) {
      throw new Error(`Path is not a directory: ${path}`);
    }

    // Check for duplicates in existing extraDirs
    const dirs = project.extraDirs ?? [];
    if (dirs.some((d) => normalize(resolve(d.path)) === normalizedNew)) {
      throw new Error(`Directory already added: ${path}`);
    }

    // Calculate order: max order in same group + 1
    const sameGroupOrders = dirs.filter((d) => d.group === group).map((d) => d.order);
    const order = sameGroupOrders.length > 0 ? Math.max(...sameGroupOrders) + 1 : 0;

    const entry: ExtraDirEntry = {
      id: `dir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      path,
      group,
      label,
      isCwd: false,
      order,
      createdAt: Date.now(),
    };

    project.extraDirs = [...dirs, entry];
    await this.saveProjectsDb();
    return entry;
  }

  /**
   * 从项目移除一个额外目录。
   *
   * - 如果被移除的目录是 cwd，自动回退到验证组第一个剩余目录
   * - 如果验证组没有剩余目录，rootPath 成为隐式 cwd（无 extraDir 标记 isCwd）
   *
   * 移除后持久化到 projects.json。
   */
  async removeDir(projectId: string, dirId: string): Promise<void> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const dirs = project.extraDirs ?? [];
    const target = dirs.find((d) => d.id === dirId);
    if (!target) {
      throw new Error(`Directory not found: ${dirId}`);
    }

    const remaining = dirs.filter((d) => d.id !== dirId);

    // If removed dir was cwd, fall back to verify group first remaining dir
    let newCwdPath: string | null = null;
    if (target.isCwd) {
      const verifyRemaining = remaining
        .filter((d) => d.group === 'verify')
        .sort((a, b) => a.order - b.order);

      if (verifyRemaining.length > 0) {
        verifyRemaining[0].isCwd = true;
        newCwdPath = verifyRemaining[0].path;
      } else {
        // No verify dirs remain — rootPath is implicit cwd
        newCwdPath = project.rootPath;
      }
    }

    project.extraDirs = remaining.length > 0 ? remaining : undefined;
    await this.saveProjectsDb();
    this.invalidateFileTreeScope(projectId, dirId);

    // If the removed dir was cwd, notify the renderer to rebuild the active
    // AI session with the new cwd (same as explicit setCwd).
    if (newCwdPath) {
      this.emit('cwd:changed', { projectId, cwd: newCwdPath, dirId: 'root' });
    }
  }

  /**
   * 设置某个目录为 cwd。
   *
   * 将目标目录的 isCwd 设为 true，其余所有目录（含 rootPath 的隐式 cwd）取消标记。
   * 注意：rootPath 的隐式 cwd 不存储在 extraDirs 中——当没有 extraDir 标记 isCwd 时，
   * rootPath 自动是 cwd。设置任意 extraDir 为 cwd 会覆盖此默认行为。
   *
   * 持久化到 projects.json。
   */
  async setCwd(projectId: string, dirId: string): Promise<string> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const dirs = project.extraDirs ?? [];

    // Special case: switching cwd back to project rootPath.
    // rootPath is the implicit cwd when no extraDir is marked isCwd —
    // clear all extraDir isCwd flags so rootPath takes over.
    if (dirId === ProjectManagerImpl.ROOT_DIR_ID) {
      for (const d of dirs) {
        d.isCwd = false;
      }
      await this.saveProjectsDb();
      this.emit('cwd:changed', { projectId, cwd: project.rootPath, dirId });
      return project.rootPath;
    }

    const target = dirs.find((d) => d.id === dirId);
    if (!target) {
      throw new Error(`Directory not found: ${dirId}`);
    }

    for (const d of dirs) {
      d.isCwd = d.id === dirId;
    }

    await this.saveProjectsDb();

    // Notify listeners that cwd has changed — the renderer uses this to
    // rebuild the active AI session (destroy + create) with the new cwd.
    this.emit('cwd:changed', { projectId, cwd: target.path, dirId });
    return target.path;
  }

  /**
   * 更新某个目录的标签。
   *
   * 持久化到 projects.json。
   */
  async updateDirLabel(projectId: string, dirId: string, label: string): Promise<void> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const dirs = project.extraDirs ?? [];
    const target = dirs.find((d) => d.id === dirId);
    if (!target) {
      throw new Error(`Directory not found: ${dirId}`);
    }

    target.label = label;
    await this.saveProjectsDb();
  }

  // ─── 路径安全检查 ─────────────────────────────────────

  /**
   * 检查文件路径是否在项目的任意已添加目录内（rootPath + extraDirs）。
   *
   * - rootPath 始终是允许的目录
   * - extraDirs 中的每个目录也是允许的
   * - 路径在任一目录内即返回 true
   *
   * 路径比较使用 normalize + resolve 避免符号链接和相对路径绕过。
   */
  isPathWithinProjectDirs(project: ProjectInfo, filePath: string): boolean {
    const normalizedFile = normalize(resolve(filePath));

    // Check rootPath
    const normalizedRoot = normalize(resolve(project.rootPath));
    if (normalizedFile === normalizedRoot) return true;
    if (normalizedFile.startsWith(normalizedRoot + '/')) return true;
    // Windows path separator: resolve may use \ on Windows
    if (normalizedFile.startsWith(normalizedRoot + '\\')) return true;
    if (normalizedFile.startsWith(normalizedRoot + sep)) return true;

    // Check extraDirs
    const dirs = project.extraDirs ?? [];
    for (const dir of dirs) {
      const normalizedDir = normalize(resolve(dir.path));
      if (normalizedFile === normalizedDir) return true;
      if (normalizedFile.startsWith(normalizedDir + '/')) return true;
      if (normalizedFile.startsWith(normalizedDir + '\\')) return true;
      if (normalizedFile.startsWith(normalizedDir + sep)) return true;
    }

    return false;
  }

  /**
   * 旧项目迁移：如果 extraDirs 不存在或为空，不做任何操作——
   * rootPath 隐式作为验证组第一项和 cwd，无需显式存储。
   *
   * 此方法目前是幂等的 no-op，保留为扩展点以备未来迁移逻辑变化。
   */
  private migrateExtraDirs(info: ProjectInfo): void {
    // Old projects have no extraDirs field — rootPath is implicit verify group first item and cwd.
    // No explicit migration needed: extraDirs stays undefined, and getExtraDirs returns [].
    // This method exists as a documented extension point for future schema changes.
    void info;
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
      // Close all extra directory watchers
      for (const [, dirEntry] of entry.dirWatchers) {
        if (dirEntry.debounceTimer) {
          clearTimeout(dirEntry.debounceTimer);
        }
        if (dirEntry.watcher) {
          dirEntry.watcher.close();
        }
      }
    }
    this.projects.clear();
    this.fileTreeCache.clear();
    this.directoryChildrenCache.clear();
    this.directoryChildrenRequests.clear();
    this.fileTreeCacheGenerations.clear();
  }
}

export const projectManager = new ProjectManagerImpl();
