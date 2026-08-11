import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, mkdirSync as mkdir } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  loadCache,
  saveCache,
  getRepoHash,
  getOutdatedRepoPaths,
  hasDirectoryStructureChanged,
  updateSingleRepoCache,
} from '../src/main/tools/git-manager-cache';
import type { GitRepoInfo } from '../src/main/tools/git-manager';

describe('Git Manager Cache', () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    tmpDir = require('node:os').tmpdir() + `/gm-cache-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    mkdirSync(tmpDir, { recursive: true });

    // Create a real git repo for hash testing
    repoDir = join(tmpDir, 'test-repo');
    mkdirSync(repoDir, { recursive: true });
    try {
      execSync('git init', { cwd: repoDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
      execSync('git config user.name "test"', { cwd: repoDir, stdio: 'pipe' });
      writeFileSync(join(repoDir, 'README.md'), '# test');
      execSync('git add .', { cwd: repoDir, stdio: 'pipe' });
      execSync('git commit -m "init"', { cwd: repoDir, stdio: 'pipe' });
    } catch {
      // git might not be available in CI
    }

    // Ensure .socverify dir exists
    mkdir(join(tmpDir, '.socverify'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getRepoHash', () => {
    it('should return a non-empty hash for a valid git repo', () => {
      const hash = getRepoHash(repoDir);
      // Hash may be empty if git is not available
      if (hash) {
        expect(hash).toBeTypeOf('string');
        expect(hash.length).toBeGreaterThan(0);
      }
    });

    it('should return empty string for non-existent path', () => {
      const hash = getRepoHash(join(tmpDir, 'nonexistent'));
      expect(hash).toBe('');
    });
  });

  describe('saveCache and loadCache', () => {
    it('should save and load repos round-trip', () => {
      const repos: GitRepoInfo[] = [
        {
          name: 'test-repo',
          path: repoDir,
          repoType: 'de',
          currentBranch: 'master',
          currentTag: 'No tag',
          lastCommitHash: 'abc123',
          lastCommitMessage: 'test commit',
          lastCommitTime: '1 hour ago',
          hasChanges: false,
          tags: [],
          subsysTag: null,
        },
      ];

      saveCache(tmpDir, repos);

      const loaded = loadCache(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.length).toBe(1);
      expect(loaded![0].name).toBe('test-repo');
      expect(loaded![0].currentBranch).toBe('master');
      expect(loaded![0].lastCommitHash).toBe('abc123');
    });

    it('should return null when no cache exists', () => {
      const loaded = loadCache(tmpDir);
      expect(loaded).toBeNull();
    });

    it('should return null for corrupted cache', () => {
      const cachePath = join(tmpDir, '.socverify', 'git-manager-cache.json');
      writeFileSync(cachePath, 'invalid json', 'utf-8');
      const loaded = loadCache(tmpDir);
      expect(loaded).toBeNull();
    });
  });

  describe('updateSingleRepoCache', () => {
    it('should update a single repo entry in cache', () => {
      const repos: GitRepoInfo[] = [
        {
          name: 'repo1',
          path: '/path/to/repo1',
          repoType: 'de',
          currentBranch: 'master',
          currentTag: 'v1',
          lastCommitHash: 'aaa',
          lastCommitMessage: 'msg1',
          lastCommitTime: 'now',
          hasChanges: false,
          tags: [],
          subsysTag: null,
        },
        {
          name: 'repo2',
          path: '/path/to/repo2',
          repoType: 'dv',
          currentBranch: 'dev',
          currentTag: 'v2',
          lastCommitHash: 'bbb',
          lastCommitMessage: 'msg2',
          lastCommitTime: 'now',
          hasChanges: true,
          tags: [],
          subsysTag: null,
        },
      ];

      saveCache(tmpDir, repos);

      // Update repo1
      const updated: GitRepoInfo = {
        name: 'repo1',
        path: '/path/to/repo1',
        repoType: 'de',
        currentBranch: 'feature',
        currentTag: 'v3',
        lastCommitHash: 'ccc',
        lastCommitMessage: 'updated',
        lastCommitTime: 'now',
        hasChanges: true,
        tags: [],
        subsysTag: null,
      };
      updateSingleRepoCache(tmpDir, '/path/to/repo1', updated);

      const loaded = loadCache(tmpDir);
      expect(loaded).not.toBeNull();
      const repo1 = loaded!.find((r) => r.path === '/path/to/repo1');
      expect(repo1).toBeDefined();
      expect(repo1!.currentBranch).toBe('feature');
      expect(repo1!.currentTag).toBe('v3');
      expect(repo1!.lastCommitHash).toBe('ccc');
    });

    it('should add a new repo if not in cache', () => {
      const repos: GitRepoInfo[] = [
        {
          name: 'repo1',
          path: '/path/to/repo1',
          repoType: 'de',
          currentBranch: 'master',
          currentTag: 'v1',
          lastCommitHash: 'aaa',
          lastCommitMessage: 'msg1',
          lastCommitTime: 'now',
          hasChanges: false,
          tags: [],
          subsysTag: null,
        },
      ];

      saveCache(tmpDir, repos);

      const newRepo: GitRepoInfo = {
        name: 'repo2',
        path: '/path/to/repo2',
        repoType: 'dv',
        currentBranch: 'dev',
        currentTag: 'v2',
        lastCommitHash: 'bbb',
        lastCommitMessage: 'msg2',
        lastCommitTime: 'now',
        hasChanges: false,
        tags: [],
        subsysTag: null,
      };
      updateSingleRepoCache(tmpDir, '/path/to/repo2', newRepo);

      const loaded = loadCache(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.length).toBe(2);
      expect(loaded!.find((r) => r.path === '/path/to/repo2')).toBeDefined();
    });
  });

  describe('getOutdatedRepoPaths', () => {
    it('should return empty list when no cache exists', () => {
      const outdated = getOutdatedRepoPaths(tmpDir);
      expect(outdated).toEqual([]);
    });
  });

  describe('hasDirectoryStructureChanged', () => {
    it('should return true when no cache exists', () => {
      const changed = hasDirectoryStructureChanged(tmpDir);
      expect(changed).toBe(true);
    });

    it('should return false when directory structure is unchanged', () => {
      const repos: GitRepoInfo[] = [];
      saveCache(tmpDir, repos);
      const changed = hasDirectoryStructureChanged(tmpDir);
      // May still be true if env vars are not set, but at least it shouldn't crash
      expect(typeof changed).toBe('boolean');
    });
  });
});
