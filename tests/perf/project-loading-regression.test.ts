/**
 * Regression test for project loading performance.
 *
 * Before the fix: chokidar was used with depth=5, causing ~3 second startup
 * scan on a 2400-file fixture (each directory got its own fs.watch handle).
 *
 * After the fix: native fs.watch(root, { recursive: true }) is used, which
 * creates a single kernel handle for the entire subtree (~2ms startup).
 *
 * This test locks in the performance characteristic: opening a project with
 * ~2400 files must complete in under 1 second, and file changes must still
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

  it('opens a 2400-file project and loads the file tree in under 1 second', async () => {
    // Real code path: openProject (starts watcher) + getFileTree (walks tree)
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

    // After fix: should be well under 1 second
    expect(totalMs).toBeLessThan(1000);
    expect(nodes).toBeGreaterThan(2000); // sanity: tree actually has content
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

    // Cache should be invalidated
    // (Re-fetch should give us a tree containing the new file)
    const newTree = await projectManager.getFileTree(info.id);
    let foundNewFile = false;
    function search(n: { name?: string; children?: unknown[] }) {
      if (n.name === 'new_file.sv') foundNewFile = true;
      n.children?.forEach((c) => search(c as { name?: string; children?: unknown[] }));
    }
    search(newTree);
    expect(foundNewFile).toBe(true);
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
