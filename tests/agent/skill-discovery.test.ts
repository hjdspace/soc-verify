import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock resolveBuiltInExtensionDir：默认 null（无内置技能），部分用例指向临时目录
let mockBuiltInDir: string | null = null;

vi.mock('../../src/main/agent/paths', () => ({
  resolveBuiltInExtensionDir: () => mockBuiltInDir,
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
  discoverSkills,
  createUserSkill,
  deleteUserSkill,
  getSkillInstallInfo,
  getSkillDirectoryInfo,
  resolveSkillUriPath,
  resolveSkillLoadPaths,
} from '../../src/main/agent/skill-discovery';

/** 在指定技能目录下写一个 SKILL.md（<dir>/<name>/SKILL.md）。 */
async function writeSkill(dir: string, name: string, description: string): Promise<string> {
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  const filePath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  return filePath;
}

describe('skill-discovery（issue 09 — pi canonical 来源与信任治理）', () => {
  let tempHome: string;
  let tempBuiltIn: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-test-'));
    tempBuiltIn = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-builtin-'));
    mockHome = tempHome;
    mockBuiltInDir = null;
  });

  afterEach(async () => {
    mockBuiltInDir = null;
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(tempBuiltIn, { recursive: true, force: true });
  });

  describe('来源定义 — pi canonical + 旧 omp 只读兼容', () => {
    it('发现 pi canonical 项目级技能（<root>/.pi/skills）', async () => {
      const project = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-proj-'));
      try {
        await writeSkill(path.join(project, '.pi/skills'), 'pi-project-skill', 'pi canonical');
        const skills = await discoverSkills(project);
        const skill = skills.find((s) => s.name === 'pi-project-skill');
        expect(skill).toBeDefined();
        expect(skill?.source).toBe('project');
        expect(skill?.filePath).toContain(path.join('.pi', 'skills', 'pi-project-skill', 'SKILL.md'));
      } finally {
        await fs.rm(project, { recursive: true, force: true });
      }
    });

    it('发现 pi canonical 用户级技能（~/.pi/agent/skills）', async () => {
      await writeSkill(path.join(tempHome, '.pi/agent/skills'), 'pi-user-skill', 'pi canonical user');
      const skills = await discoverAllSkills();
      const skill = skills.find((s) => s.name === 'pi-user-skill');
      expect(skill).toBeDefined();
      expect(skill?.source).toBe('user');
      expect(skill?.filePath).toContain(path.join('.pi', 'agent', 'skills', 'pi-user-skill', 'SKILL.md'));
    });

    it('旧 .omp/skills（项目级）只读兼容：仍被发现但可从文件判断来自旧目录', async () => {
      const project = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-proj-'));
      try {
        await writeSkill(path.join(project, '.omp/skills'), 'legacy-project-skill', 'omp legacy');
        const skills = await discoverSkills(project);
        expect(skills.some((s) => s.name === 'legacy-project-skill')).toBe(true);
      } finally {
        await fs.rm(project, { recursive: true, force: true });
      }
    });

    it('旧 ~/.omp/agent/skills（用户级）只读兼容：仍被发现', async () => {
      await writeSkill(path.join(tempHome, '.omp/agent/skills'), 'legacy-user-skill', 'omp legacy');
      const skills = await discoverAllSkills();
      expect(skills.some((s) => s.name === 'legacy-user-skill')).toBe(true);
    });

    it('managed-skills 不被发现（不迁移），目录信息中也不出现', async () => {
      await writeSkill(path.join(tempHome, '.omp/agent/managed-skills'), 'managed-skill', 'auto-learn');
      const skills = await discoverAllSkills();
      expect(skills.some((s) => s.name === 'managed-skill')).toBe(false);

      const dirs = await getSkillDirectoryInfo();
      expect(dirs.some((d) => d.path.includes('managed-skills'))).toBe(false);
    });

    it('omp 时代的镜像目录（.claude/.agents/.github/.codex）不再扫描', async () => {
      await writeSkill(path.join(tempHome, '.claude/skills'), 'claude-mirror', 'mirror');
      await writeSkill(path.join(tempHome, '.agents/skills'), 'agents-mirror', 'mirror');
      await writeSkill(path.join(tempHome, '.codex/skills'), 'codex-mirror', 'mirror');
      const project = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-proj-'));
      try {
        await writeSkill(path.join(project, '.claude/skills'), 'proj-claude-mirror', 'mirror');
        await writeSkill(path.join(project, '.github/skills'), 'proj-github-mirror', 'mirror');
        const skills = await discoverSkills(project);
        const names = skills.map((s) => s.name);
        expect(names).not.toContain('claude-mirror');
        expect(names).not.toContain('agents-mirror');
        expect(names).not.toContain('codex-mirror');
        expect(names).not.toContain('proj-claude-mirror');
        expect(names).not.toContain('proj-github-mirror');
      } finally {
        await fs.rm(project, { recursive: true, force: true });
      }
    });
  });

  describe('同名解析 — project > builtin > user，canonical 来源优先，只暴露一个结果', () => {
    it('五处同名时 project canonical 胜出，且结果唯一', async () => {
      mockBuiltInDir = tempBuiltIn;
      await writeSkill(path.join(tempBuiltIn, 'skills'), 'shared-x', 'builtin version');

      const project = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-proj-'));
      try {
        await writeSkill(path.join(project, '.pi/skills'), 'shared-x', 'project canonical');
        await writeSkill(path.join(project, '.omp/skills'), 'shared-x', 'project legacy');
        await writeSkill(path.join(tempHome, '.pi/agent/skills'), 'shared-x', 'user canonical');
        await writeSkill(path.join(tempHome, '.omp/agent/skills'), 'shared-x', 'user legacy');

        const skills = await discoverSkills(project);
        const shared = skills.filter((s) => s.name === 'shared-x');
        expect(shared).toHaveLength(1);
        expect(shared[0]!.description).toBe('project canonical');
        expect(shared[0]!.filePath).toContain(path.join('.pi', 'skills', 'shared-x', 'SKILL.md'));
      } finally {
        await fs.rm(project, { recursive: true, force: true });
      }
    });

    it('project canonical 缺席时 project legacy 胜出（项目作用域优先于内置）', async () => {
      mockBuiltInDir = tempBuiltIn;
      await writeSkill(path.join(tempBuiltIn, 'skills'), 'shared-p', 'builtin version');

      const project = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-proj-'));
      try {
        await writeSkill(path.join(project, '.omp/skills'), 'shared-p', 'project legacy');
        const skills = await discoverSkills(project);
        const shared = skills.filter((s) => s.name === 'shared-p');
        expect(shared).toHaveLength(1);
        expect(shared[0]!.description).toBe('project legacy');
      } finally {
        await fs.rm(project, { recursive: true, force: true });
      }
    });

    it('builtin 胜出 user canonical（project > builtin > user）', async () => {
      mockBuiltInDir = tempBuiltIn;
      await writeSkill(path.join(tempBuiltIn, 'skills'), 'shared-b', 'builtin version');
      await writeSkill(path.join(tempHome, '.pi/agent/skills'), 'shared-b', 'user canonical');
      await writeSkill(path.join(tempHome, '.omp/agent/skills'), 'shared-b', 'user legacy');

      const project = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-proj-'));
      try {
        const skills = await discoverSkills(project);
        const shared = skills.filter((s) => s.name === 'shared-b');
        expect(shared).toHaveLength(1);
        expect(shared[0]!.description).toBe('builtin version');
      } finally {
        await fs.rm(project, { recursive: true, force: true });
      }
    });

    it('user 作用域内 canonical 胜出 legacy', async () => {
      await writeSkill(path.join(tempHome, '.pi/agent/skills'), 'shared-u', 'user canonical');
      await writeSkill(path.join(tempHome, '.omp/agent/skills'), 'shared-u', 'user legacy');

      const skills = await discoverAllSkills();
      const shared = skills.filter((s) => s.name === 'shared-u');
      expect(shared).toHaveLength(1);
      expect(shared[0]!.description).toBe('user canonical');
    });

    it('frontmatter 缺失 name 时回退到目录名', async () => {
      const skillDir = path.join(tempHome, '.pi/agent/skills', 'no-name-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\ndescription: No name in frontmatter\n---\n\n# No Name\n',
      );

      const skills = await discoverAllSkills();
      expect(skills.some((s) => s.name === 'no-name-skill')).toBe(true);
    });
  });

  describe('resolveSkillLoadPaths — runner 装载列表（与 UI 发现一致）', () => {
    it('按 project canonical > project legacy > builtin > user canonical > user legacy 排序，且只含存在的目录', async () => {
      mockBuiltInDir = tempBuiltIn;
      const project = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-proj-'));
      try {
        await writeSkill(path.join(project, '.pi/skills'), 'a', 'x');
        await writeSkill(path.join(project, '.omp/skills'), 'b', 'x');
        await writeSkill(path.join(tempBuiltIn, 'skills'), 'c', 'x');
        await writeSkill(path.join(tempHome, '.pi/agent/skills'), 'd', 'x');
        await writeSkill(path.join(tempHome, '.omp/agent/skills'), 'e', 'x');

        const paths = await resolveSkillLoadPaths(project);
        const rel = (p: string) => p.slice(project.length + 1);
        const rels = paths.map(rel);
        expect(rels[0]).toBe(path.join('.pi', 'skills'));
        expect(rels[1]).toBe(path.join('.omp', 'skills'));
        expect(paths[2]).toBe(path.join(tempBuiltIn, 'skills'));
        expect(paths[3]).toBe(path.join(tempHome, '.pi', 'agent', 'skills'));
        expect(paths[4]).toBe(path.join(tempHome, '.omp', 'agent', 'skills'));
      } finally {
        await fs.rm(project, { recursive: true, force: true });
      }
    });

    it('不存在的目录被跳过（不产生无效 skill path）', async () => {
      const project = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-proj-'));
      try {
        await writeSkill(path.join(tempHome, '.pi/agent/skills'), 'only', 'x');
        const paths = await resolveSkillLoadPaths(project);
        expect(paths).toEqual([path.join(tempHome, '.pi', 'agent', 'skills')]);
      } finally {
        await fs.rm(project, { recursive: true, force: true });
      }
    });
  });

  describe('createUserSkill — 写入 pi canonical 用户级目录', () => {
    it('创建到 ~/.pi/agent/skills/<name>/SKILL.md，且不触碰 ~/.omp', async () => {
      const skill = await createUserSkill({
        name: 'my-new-skill',
        description: 'A newly created skill',
        body: '# My Skill\n\nDoes things.',
      });

      expect(skill.name).toBe('my-new-skill');
      expect(skill.source).toBe('user');
      // Cross-platform path check (Windows uses backslashes)
      const expectedSuffix = path.join('.pi', 'agent', 'skills', 'my-new-skill', 'SKILL.md');
      expect(skill.filePath).toContain(expectedSuffix);

      // Verify file was actually written
      const content = await fs.readFile(skill.filePath, 'utf-8');
      expect(content).toContain('name: my-new-skill');
      expect(content).toContain('description: "A newly created skill"');
      expect(content).toContain('# My Skill');

      // managed-skills 与旧 omp 目录不被创建/修改
      expect(await fs.stat(path.join(tempHome, '.omp')).then(() => true, () => false)).toBe(false);
    });

    it('拒绝非法技能名（空名、特殊字符、路径穿越）', async () => {
      await expect(
        createUserSkill({ name: 'Invalid Name!', description: 'desc', body: 'body' }),
      ).rejects.toThrow();
      await expect(
        createUserSkill({ name: '', description: 'desc', body: 'body' }),
      ).rejects.toThrow();
      await expect(
        createUserSkill({ name: 'a/b', description: 'desc', body: 'body' }),
      ).rejects.toThrow();
    });

    it('拒绝空描述与空内容', async () => {
      await expect(
        createUserSkill({ name: 'test', description: '', body: 'body' }),
      ).rejects.toThrow();
      await expect(
        createUserSkill({ name: 'test', description: 'desc', body: '' }),
      ).rejects.toThrow();
    });

    it('canonical 目录下同名重复创建被拒绝', async () => {
      await createUserSkill({ name: 'duplicate', description: 'First', body: '# First' });
      await expect(
        createUserSkill({ name: 'duplicate', description: 'Second', body: '# Second' }),
      ).rejects.toThrow();
    });

    it('与旧 omp 只读目录同名不冲突（canonical 覆盖旧来源，互不修改）', async () => {
      await writeSkill(path.join(tempHome, '.omp/agent/skills'), 'overlap', 'legacy');
      const skill = await createUserSkill({ name: 'overlap', description: 'canonical', body: '# C' });
      expect(skill.filePath).toContain(path.join('.pi', 'agent', 'skills'));
      // 旧文件未被修改
      const legacy = await fs.readFile(
        path.join(tempHome, '.omp/agent/skills/overlap/SKILL.md'),
        'utf-8',
      );
      expect(legacy).toContain('legacy');
    });
  });

  describe('deleteUserSkill — 只删 canonical，旧目录只读', () => {
    it('删除 canonical 用户级技能', async () => {
      await createUserSkill({ name: 'to-delete', description: 'Will be deleted', body: '# Delete Me' });
      await deleteUserSkill('to-delete');
      const skills = await discoverAllSkills();
      expect(skills.some((s) => s.name === 'to-delete')).toBe(false);
    });

    it('技能只在旧 omp 目录时拒绝删除（只读兼容），且文件保留', async () => {
      const legacyPath = await writeSkill(path.join(tempHome, '.omp/agent/skills'), 'legacy-only', 'legacy');
      await expect(deleteUserSkill('legacy-only')).rejects.toThrow(/只读|旧版/);
      await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    });

    it('技能不存在时抛错', async () => {
      await expect(deleteUserSkill('nonexistent')).rejects.toThrow();
    });
  });

  describe('getSkillInstallInfo / getSkillDirectoryInfo — 目录展示', () => {
    it('canonical 用户级目录可管理；旧 omp 用户级目录只读不可管理', async () => {
      const info = await getSkillInstallInfo();
      expect(info.directories).toBeInstanceOf(Array);
      expect(info.guidance).toContain('SKILL.md');
      expect(info.guidance).toContain('技能');

      const canonical = info.directories.find((d) => d.path.includes(path.join('.pi', 'agent', 'skills')));
      expect(canonical).toBeDefined();
      expect(canonical!.manageable).toBe(true);

      const legacy = info.directories.find((d) => d.path.includes(path.join('.omp', 'agent', 'skills')));
      expect(legacy).toBeDefined();
      expect(legacy!.manageable).toBe(false);

      expect(info.guidance).toContain('.pi');
    });

    it('marks existing directories correctly', async () => {
      await fs.mkdir(path.join(tempHome, '.pi/agent/skills'), { recursive: true });

      const dirs = await getSkillDirectoryInfo();
      const canonical = dirs.find((d) => d.path.includes(path.join('.pi', 'agent', 'skills')));
      expect(canonical!.exists).toBe(true);

      const legacy = dirs.find((d) => d.path.includes(path.join('.omp', 'agent', 'skills')));
      expect(legacy!.exists).toBe(false);
    });
  });

  describe('resolveSkillUriPath — skill:// URI 稳定解析与穿越拒绝', () => {
    let tempProject: string;

    beforeEach(async () => {
      tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-uri-proj-'));
      // canonical 项目技能 + 同名旧技能 + 带引用文件的技能
      await writeSkill(path.join(tempProject, '.pi/skills'), 'drawio-skill', 'canonical');
      await writeSkill(path.join(tempProject, '.omp/skills'), 'drawio-skill', 'legacy');
      const refDir = path.join(tempProject, '.pi/skills/drawio-skill/references');
      await fs.mkdir(refDir, { recursive: true });
      await fs.writeFile(path.join(refDir, 'xml-authoring.md'), '# XML authoring\n');
    });

    afterEach(async () => {
      await fs.rm(tempProject, { recursive: true, force: true });
    });

    it('returns null for non-skill:// input', async () => {
      expect(await resolveSkillUriPath(tempProject, 'D:/some/file.md')).toBeNull();
      expect(await resolveSkillUriPath(tempProject, '')).toBeNull();
    });

    it('resolves skill://<name> to the canonical SKILL.md path', async () => {
      const resolved = await resolveSkillUriPath(tempProject, 'skill://drawio-skill');
      expect(resolved).toBe(path.join(tempProject, '.pi/skills/drawio-skill/SKILL.md'));
    });

    it('resolves skill://<name>/<rel> to a file inside the skill baseDir', async () => {
      const resolved = await resolveSkillUriPath(tempProject, 'skill://drawio-skill/references/xml-authoring.md');
      expect(resolved).toBe(
        path.join(tempProject, '.pi/skills/drawio-skill/references/xml-authoring.md'),
      );
    });

    it('decodes percent-encoded relative paths', async () => {
      const resolved = await resolveSkillUriPath(tempProject, 'skill://drawio-skill/references%2Fxml-authoring.md');
      expect(resolved).toBe(
        path.join(tempProject, '.pi/skills/drawio-skill/references/xml-authoring.md'),
      );
    });

    it('returns null for unknown skill names', async () => {
      expect(await resolveSkillUriPath(tempProject, 'skill://references/xml-authoring.md')).toBeNull();
      expect(await resolveSkillUriPath(tempProject, 'skill://nope')).toBeNull();
    });

    it('returns null when the relative file does not exist', async () => {
      expect(await resolveSkillUriPath(tempProject, 'skill://drawio-skill/references/missing.md')).toBeNull();
    });

    it('rejects .. traversal', async () => {
      expect(await resolveSkillUriPath(tempProject, 'skill://drawio-skill/../../etc/passwd')).toBeNull();
    });

    it('rejects absolute paths in the relative part', async () => {
      expect(await resolveSkillUriPath(tempProject, 'skill://drawio-skill/C:/Windows/win.ini')).toBeNull();
      expect(await resolveSkillUriPath(tempProject, 'skill://drawio-skill//etc/passwd')).toBeNull();
    });
  });
});
