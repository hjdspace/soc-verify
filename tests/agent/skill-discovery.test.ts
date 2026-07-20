import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock resolveBuiltInExtensionDir to return null in tests (no built-in skills)
vi.mock('../../src/main/agent/paths', () => ({
  resolveBuiltInExtensionDir: () => null,
}));

// Module-level variable so the mock factory can reference it.
// vi.mock is hoisted, but the factory closure reads mockHome at call time.
let mockHome = '/tmp/skill-test-placeholder';

vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => mockHome,
  };
});

import {
  discoverAllSkills,
  createUserSkill,
  deleteUserSkill,
  getSkillInstallInfo,
  getSkillDirectoryInfo,
} from '../../src/main/agent/skill-discovery';

describe('skill-discovery', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-test-'));
    mockHome = tempHome;
  });

  afterEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  describe('discoverAllSkills', () => {
    it('returns empty array when no skill directories exist', async () => {
      const skills = await discoverAllSkills();
      expect(skills).toEqual([]);
    });

    it('discovers skills from omp user-level directory', async () => {
      const skillDir = path.join(tempHome, '.omp/agent/skills', 'test-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: test-skill\ndescription: A test skill\n---\n\n# Test Skill\n',
      );

      const skills = await discoverAllSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0]!.name).toBe('test-skill');
      expect(skills[0]!.description).toBe('A test skill');
      expect(skills[0]!.source).toBe('user');
    });

    it('discovers skills from managed-skills directory', async () => {
      const skillDir = path.join(tempHome, '.omp/agent/managed-skills', 'managed-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: managed-skill\ndescription: A managed skill\n---\n\n# Managed\n',
      );

      const skills = await discoverAllSkills();
      expect(skills.some((s) => s.name === 'managed-skill')).toBe(true);
    });

    it('discovers skills from claude user-level directory', async () => {
      const skillDir = path.join(tempHome, '.claude/skills', 'claude-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: claude-skill\ndescription: Claude skill\n---\n\n# Claude\n',
      );

      const skills = await discoverAllSkills();
      expect(skills.some((s) => s.name === 'claude-skill')).toBe(true);
    });

    it('deduplicates skills by name with builtin priority over user', async () => {
      // Since we mock built-in to null, we test user-level dedup across directories
      const ompDir = path.join(tempHome, '.omp/agent/skills', 'shared');
      const claudeDir = path.join(tempHome, '.claude/skills', 'shared');
      await fs.mkdir(ompDir, { recursive: true });
      await fs.mkdir(claudeDir, { recursive: true });
      await fs.writeFile(
        path.join(ompDir, 'SKILL.md'),
        '---\nname: shared\ndescription: OMP version\n---\n\n# OMP\n',
      );
      await fs.writeFile(
        path.join(claudeDir, 'SKILL.md'),
        '---\nname: shared\ndescription: Claude version\n---\n\n# Claude\n',
      );

      const skills = await discoverAllSkills();
      const sharedSkills = skills.filter((s) => s.name === 'shared');
      expect(sharedSkills).toHaveLength(1);
    });

    it('falls back to directory name when frontmatter name is missing', async () => {
      const skillDir = path.join(tempHome, '.omp/agent/skills', 'no-name-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\ndescription: No name in frontmatter\n---\n\n# No Name\n',
      );

      const skills = await discoverAllSkills();
      expect(skills.some((s) => s.name === 'no-name-skill')).toBe(true);
    });
  });

  describe('createUserSkill', () => {
    it('creates a new skill in omp user-level directory', async () => {
      const skill = await createUserSkill({
        name: 'my-new-skill',
        description: 'A newly created skill',
        body: '# My Skill\n\nDoes things.',
      });

      expect(skill.name).toBe('my-new-skill');
      expect(skill.source).toBe('user');
      // Cross-platform path check (Windows uses backslashes)
      const expectedSuffix = path.join('.omp', 'agent', 'skills', 'my-new-skill', 'SKILL.md');
      expect(skill.filePath).toContain(expectedSuffix);

      // Verify file was actually written
      const content = await fs.readFile(skill.filePath, 'utf-8');
      expect(content).toContain('name: my-new-skill');
      expect(content).toContain('description: "A newly created skill"');
      expect(content).toContain('# My Skill');
    });

    it('rejects invalid skill names', async () => {
      // Names with spaces or special characters are rejected
      await expect(
        createUserSkill({ name: 'Invalid Name!', description: 'desc', body: 'body' }),
      ).rejects.toThrow();

      // Empty name is rejected
      await expect(
        createUserSkill({ name: '', description: 'desc', body: 'body' }),
      ).rejects.toThrow();

      // Names with slashes are rejected (path traversal protection)
      await expect(
        createUserSkill({ name: 'a/b', description: 'desc', body: 'body' }),
      ).rejects.toThrow();
    });

    it('rejects empty description', async () => {
      await expect(
        createUserSkill({ name: 'test', description: '', body: 'body' }),
      ).rejects.toThrow();
    });

    it('rejects empty body', async () => {
      await expect(
        createUserSkill({ name: 'test', description: 'desc', body: '' }),
      ).rejects.toThrow();
    });

    it('rejects duplicate skill name', async () => {
      await createUserSkill({
        name: 'duplicate',
        description: 'First',
        body: '# First',
      });

      await expect(
        createUserSkill({ name: 'duplicate', description: 'Second', body: '# Second' }),
      ).rejects.toThrow();
    });
  });

  describe('deleteUserSkill', () => {
    it('deletes an existing user-level skill', async () => {
      await createUserSkill({
        name: 'to-delete',
        description: 'Will be deleted',
        body: '# Delete Me',
      });

      await deleteUserSkill('to-delete');

      const skills = await discoverAllSkills();
      expect(skills.some((s) => s.name === 'to-delete')).toBe(false);
    });

    it('throws when skill does not exist', async () => {
      await expect(deleteUserSkill('nonexistent')).rejects.toThrow();
    });
  });

  describe('getSkillInstallInfo', () => {
    it('returns directory info and guidance text', async () => {
      const info = await getSkillInstallInfo();

      expect(info.directories).toBeInstanceOf(Array);
      expect(info.directories.length).toBeGreaterThan(0);
      expect(info.guidance).toContain('SKILL.md');
      expect(info.guidance).toContain('技能');
    });

    it('includes omp user-level directory in the list', async () => {
      const info = await getSkillInstallInfo();
      const ompDir = info.directories.find((d) => d.label === 'OMP 用户级');
      expect(ompDir).toBeDefined();
      // Cross-platform path check
      const expectedSegment = path.join('.omp', 'agent', 'skills');
      expect(ompDir!.path).toContain(expectedSegment);
      expect(ompDir!.manageable).toBe(true);
    });
  });

  describe('getSkillDirectoryInfo', () => {
    it('marks existing directories correctly', async () => {
      // Create the omp directory
      await fs.mkdir(path.join(tempHome, '.omp/agent/skills'), { recursive: true });

      const dirs = await getSkillDirectoryInfo();
      const ompDir = dirs.find((d) => d.label === 'OMP 用户级');
      expect(ompDir!.exists).toBe(true);

      const codexDir = dirs.find((d) => d.label === 'Codex 用户级');
      expect(codexDir!.exists).toBe(false);
    });
  });
});
