/**
 * Regression test for project loading performance.
 *
 * Before the fix: chokidar was used with depth=5, causing ~3 second startup
 * scan on a 2400-file fixture (each directory got its own fs.watch handle).
 *
 * After the fix: native fs.watch(root, { recursive: true }) is used, which
 * creates a single kernel handle for the entire subtree (~2ms startup).
 *
 * After the lazy-loading fix: getFileTree only reads the root level (depth 0→1).
 * Deeper directories are fetched on demand via getDirChildren().
 * This follows the VS Code AsyncDataTree pattern.
 *
 * This test locks in the performance characteristic: opening a project with
 * ~2400 files must complete in under 200ms (lazy), and file changes must still
 * be detected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

vi.mock('electron', () => {
  let userDataDir: string | null = null;
  return {
    app: {
      getPath: (name: string) => {
        if (name === 'userData') {
          if (!userDataDir) {
            const fs = require('node:fs');
            userDataDir = fs.mkdtempSync(join(tmpdir(), 'socverify-userdata-'));
          }
          return userDataDir;
        }
        return '/tmp/socverify-mock';
      },
      isReady: () => true,
    },
    dialog: { showOpenDialog: vi.fn() },
    ipcMain: { on: vi.fn(), handle: vi.fn() },
    BrowserWindow: class {},
  };
});

import { projectManager } from '../../src/main/project/project-manager';

async function buildFixture(root: string): Promise<number> {
  let count = 0;
  for (let s = 0; s < 6; s++) {
    const subsysDir = join(root, `subsys_${s}`);
    await mkdir(subsysDir, { recursive: true });
    for (let d = 0; d < 5; d++) {
      const subDir = join(subsysDir, `dir_${d}`);
      await mkdir(subDir, { recursive: true });
      for (let f = 0; f < 40; f++) {
        await writeFile(join(subDir, `file_${f}.sv`), `// file ${f}\n`);
        count++;
      }
      let cur = subDir;
      for (let e = 0; e < 2; e++) {
        cur = join(cur, `nested_${e}`);
        await mkdir(cur, { recursive: true });
        for (let f = 0; f < 20; f++) {
          await writeFile(join(cur, `nested_file_${f}.v`), `// nested ${e}/${f}\n`);
          count++;
        }
      }
    }
  }
  return count;
}

describe('project loading performance regression', () => {
  let fixtureRoot: string;
  let fileCount: number;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'socverify-reg-'));
    fileCount = await buildFixture(fixtureRoot);
  }, 60000);

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(fixtureRoot, { recursive: true, force: true });
  }, 60000);

  it('opens a 2400-file project and loads the root-level tree in under 200ms', async () => {
    // Real code path: openProject (starts watcher) + getFileTree (reads root only)
    const t0 = performance.now();
    const info = await projectManager.openProject(fixtureRoot, 'regression-fixture');
    const tree = await projectManager.getFileTree(info.id);
    const t1 = performance.now();

    const totalMs = t1 - t0;
    let nodes = 0;
    function walk(n: { children?: unknown[] }) {
      nodes++;
      n.children?.forEach((c) => walk(c as { children?: unknown[] }));
    }
    walk(tree);

    console.log(
      `[REG] total=${totalMs.toFixed(0)}ms nodes=${nodes} files=${fileCount} jsonBytes=${JSON.stringify(tree).length}`,
    );

    // With lazy loading, root + its direct children only.
    // Root level has: 6 subsys dirs + .socverify dir + .gitignore file = 8 children.
    expect(totalMs).toBeLessThan(200);
    expect(nodes).toBe(9); // 1 root + 8 direct children
  }, 120000);

  it('lazy-loads directory children via getDirChildren', async () => {
    const info = await projectManager.openProject(fixtureRoot, 'regression-fixture');
    const tree = await projectManager.getFileTree(info.id);

    // Find subsys_0 (not .socverify which sorts first)
    const subsys0 = tree.children?.find((c) => c.name === 'subsys_0');
    expect(subsys0).toBeDefined();
    expect(subsys0?.type).toBe('directory');
    expect(subsys0?.lazy).toBe(true);
    expect(subsys0?.children).toEqual([]); // empty until expanded

    // Load children of subsys_0
    const children = await projectManager.getDirChildren(info.id, subsys0!.path);
    expect(children.length).toBe(5); // 5 sub-directories (dir_0..dir_4)
    // Each sub-directory should be marked lazy
    const firstDir = children[0];
    expect(firstDir.type).toBe('directory');
    expect(firstDir.lazy).toBe(true);
  }, 120000);

  it('detects new file additions via the watcher (debounced)', async () => {
    const info = await projectManager.openProject(fixtureRoot, 'regression-fixture');
    await projectManager.getFileTree(info.id); // populate cache

    // Listen for filetree:update events
    const updates: unknown[] = [];
    const listener = (u: unknown) => updates.push(u);
    projectManager.on('filetree:update', listener);

    // Write a new file deep in the tree
    await writeFile(join(fixtureRoot, 'subsys_0/dir_0/nested_0/new_file.sv'), '// new\n');

    // Wait for the debounced event (500ms debounce + buffer)
    await new Promise((r) => setTimeout(r, 1500));

    projectManager.off('filetree:update', listener);

    console.log(`[REG] received ${updates.length} filetree:update events for new file`);

    // Should have received at least one update (debounced)
    expect(updates.length).toBeGreaterThanOrEqual(1);

    // Cache should be invalidated.
    // With lazy loading, the new file is in a sub-directory that needs to be
    // fetched via getDirChildren. The root-level tree won't contain it directly.
    const newTree = await projectManager.getFileTree(info.id);
    const subsys0 = newTree.children?.find((c) => c.name === 'subsys_0');
    expect(subsys0).toBeDefined();
    const dirChildren = await projectManager.getDirChildren(info.id, subsys0!.path);
    const dir0 = dirChildren.find((c) => c.name === 'dir_0');
    expect(dir0).toBeDefined();
    const dir0Children = await projectManager.getDirChildren(info.id, dir0!.path);
    const nested0 = dir0Children.find((c) => c.name === 'nested_0');
    expect(nested0).toBeDefined();
    const nested0Children = await projectManager.getDirChildren(info.id, nested0!.path);
    expect(nested0Children.some((c) => c.name === 'new_file.sv')).toBe(true);
  }, 120000);

  it('collapses burst of file changes into a single debounced update', async () => {
    const info = await projectManager.openProject(fixtureRoot, 'regression-fixture');
    await projectManager.getFileTree(info.id);

    const updates: unknown[] = [];
    const listener = (u: unknown) => updates.push(u);
    projectManager.on('filetree:update', listener);

    // Burst: 50 file writes in quick succession
    for (let i = 0; i < 50; i++) {
      await writeFile(join(fixtureRoot, `subsys_0/dir_0/burst_${i}.sv`), '// burst\n');
    }

    // Wait for debounce window to close
    await new Promise((r) => setTimeout(r, 1500));

    projectManager.off('filetree:update', listener);

    console.log(`[REG] burst of 50 writes → ${updates.length} debounced events`);

    // Should collapse to 1-2 events (not 50)
    expect(updates.length).toBeLessThan(5);
  }, 120000);
});
