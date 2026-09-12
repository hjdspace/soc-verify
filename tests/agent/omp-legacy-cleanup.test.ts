/**
 * omp-legacy-cleanup（issue 08）—— 迁移完成后清理 SoC Verify 明确拥有的
 * 旧 omp 原生 session 与 artifacts。
 *
 * 验收标准（.scratch/pi-engine-migration/issues/08）：
 *   - 只删除 JSONL header id 精确匹配应用拥有 engineSessionId 的文件；
 *   - 保留 UI transcript（本模块根本不触碰 chat-messages）；
 *   - 绝不递归删除用户全局 ~/.omp —— 只处理 sessions 根下的具体文件；
 *   - artifacts（bucket 级 subagent-artifacts）仅当 bucket 内不再有其他
 *     session 文件时删除。
 */
import { mkdir, mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupLegacyOmpSessions, findOmpRoots } from '../../src/main/agent/omp-legacy-cleanup';
import { saveSessions, loadSessions } from '../../src/main/agent/session-persistence';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function headerLine(id: string): string {
  return `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-09-01T00:00:00Z', cwd: '/proj/dv' })}\n`;
}

type Env = {
  home: string;
  globalRoot: string;
  profileRoot: string;
  projectRoot: string;
};

async function makeEnv(): Promise<Env> {
  const home = await mkdtemp(join(tmpdir(), 'socv-omp-home-'));
  const projectRoot = await mkdtemp(join(tmpdir(), 'socv-omp-proj-'));
  const globalRoot = join(home, '.omp', 'agent', 'sessions');
  const profileRoot = join(home, '.omp', 'profiles', 'work', 'agent', 'sessions');
  await mkdir(join(globalRoot, '--D--proj--'), { recursive: true });
  await mkdir(join(profileRoot, '--D--proj--'), { recursive: true });
  return { home, globalRoot, profileRoot, projectRoot };
}

describe('findOmpRoots', () => {
  it('返回存在的 sessions 根（全局 + profile），缺失的跳过', async () => {
    const env = await makeEnv();
    try {
      const roots = await findOmpRoots(env.home);
      expect(roots).toContain(env.globalRoot);
      expect(roots).toContain(env.profileRoot);
      // 永不返回 ~/.omp 本身
      expect(roots.every((r) => r.endsWith(join('agent', 'sessions')))).toBe(true);
    } finally {
      await rm(env.home, { recursive: true, force: true });
      await rm(env.projectRoot, { recursive: true, force: true });
    }
  });

  it('~/.omp 不存在时返回空数组（不抛错）', async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), 'socv-omp-empty-'));
    try {
      expect(await findOmpRoots(emptyHome)).toEqual([]);
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });
});

describe('cleanupLegacyOmpSessions', () => {
  let env: Env;

  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(async () => {
    await rm(env.home, { recursive: true, force: true });
    await rm(env.projectRoot, { recursive: true, force: true });
  });

  it('只删除应用拥有的 omp 原生文件（header id 精确匹配），其余文件不动', async () => {
    const ownedFile = join(env.globalRoot, '--D--proj--', 'omp-owned.jsonl');
    const foreignFile = join(env.globalRoot, '--D--proj--', 'omp-foreign.jsonl');
    await writeFile(ownedFile, `${headerLine('omp-owned-1')}{"type":"message"}\n`, 'utf-8');
    await writeFile(foreignFile, `${headerLine('omp-foreign-9')}{"type":"message"}\n`, 'utf-8');

    await saveSessions(env.projectRoot, [
      {
        sessionId: 'app-1',
        engine: 'omp',
        engineSessionId: 'omp-owned-1',
        cwd: '/proj/dv',
        name: '旧会话',
        projectId: 'proj-1',
        createdAt: 1,
        lastActivityAt: 1,
      },
    ]);

    const report = await cleanupLegacyOmpSessions(env.projectRoot, {
      roots: [env.globalRoot, env.profileRoot],
    });

    expect(report.removed).toHaveLength(1);
    expect(report.removed[0]).toBe(ownedFile);
    expect(await exists(ownedFile)).toBe(false);
    expect(await exists(foreignFile)).toBe(true);
    expect(report.residual).toEqual([]);
  });

  it('profile 目录下的拥有文件同样清理', async () => {
    const profileFile = join(env.profileRoot, '--D--proj--', 'omp-profile.jsonl');
    await writeFile(profileFile, `${headerLine('omp-prof-1')}\n`, 'utf-8');
    await saveSessions(env.projectRoot, [
      {
        sessionId: 'app-2',
        engine: 'omp',
        engineSessionId: 'omp-prof-1',
        cwd: '/proj/dv',
        name: 'x',
        projectId: 'proj-1',
        createdAt: 1,
        lastActivityAt: 1,
      },
    ]);

    const report = await cleanupLegacyOmpSessions(env.projectRoot, {
      roots: [env.globalRoot, env.profileRoot],
    });
    expect(report.removed).toContain(profileFile);
  });

  it('bucket 清空时删除 subagent-artifacts；有其他会话文件时保留', async () => {
    const bucket = join(env.globalRoot, '--D--proj--');
    const ownedFile = join(bucket, 'omp-owned.jsonl');
    const otherFile = join(bucket, 'omp-other.jsonl');
    await writeFile(ownedFile, `${headerLine('omp-owned-1')}\n`, 'utf-8');
    await writeFile(otherFile, `${headerLine('omp-other-1')}\n`, 'utf-8');
    await mkdir(join(bucket, 'subagent-artifacts'), { recursive: true });
    await writeFile(join(bucket, 'subagent-artifacts', 'a.txt'), 'x', 'utf-8');

    await saveSessions(env.projectRoot, [
      {
        sessionId: 'app-1',
        engine: 'omp',
        engineSessionId: 'omp-owned-1',
        cwd: '/proj/dv',
        name: 'x',
        projectId: 'proj-1',
        createdAt: 1,
        lastActivityAt: 1,
      },
    ]);

    // bucket 还有 omp-other → artifacts 保留
    const report1 = await cleanupLegacyOmpSessions(env.projectRoot, { roots: [env.globalRoot] });
    expect(report1.keptArtifacts.length).toBe(1);
    expect(await exists(join(bucket, 'subagent-artifacts'))).toBe(true);

    // omp-other 也被拥有并删除后 → artifacts 清理
    await saveSessions(env.projectRoot, [
      {
        sessionId: 'app-1',
        engine: 'omp',
        engineSessionId: 'omp-owned-1',
        cwd: '/proj/dv',
        name: 'x',
        projectId: 'proj-1',
        createdAt: 1,
        lastActivityAt: 1,
      },
      {
        sessionId: 'app-2',
        engine: 'omp',
        engineSessionId: 'omp-other-1',
        cwd: '/proj/dv',
        name: 'y',
        projectId: 'proj-1',
        createdAt: 1,
        lastActivityAt: 1,
      },
    ]);
    const report2 = await cleanupLegacyOmpSessions(env.projectRoot, { roots: [env.globalRoot] });
    // omp-owned-1 已在上一轮删除，本轮只删 omp-other-1
    expect(report2.removed).toHaveLength(1);
    expect(await exists(join(bucket, 'subagent-artifacts'))).toBe(false);
    expect(report2.keptArtifacts).toHaveLength(0);
  });

  it('损坏的 JSONL 首行 → 跳过该文件（不崩溃、不误删）', async () => {
    const corrupt = join(env.globalRoot, '--D--proj--', 'corrupt.jsonl');
    await writeFile(corrupt, 'not-json-at-all\n', 'utf-8');
    await saveSessions(env.projectRoot, [
      {
        sessionId: 'app-1',
        engine: 'omp',
        engineSessionId: 'omp-owned-1',
        cwd: '/proj/dv',
        name: 'x',
        projectId: 'proj-1',
        createdAt: 1,
        lastActivityAt: 1,
      },
    ]);

    const report = await cleanupLegacyOmpSessions(env.projectRoot, { roots: [env.globalRoot] });
    expect(report.removed).toHaveLength(0);
    expect(await exists(corrupt)).toBe(true);
  });

  it('UI transcript 与应用索引不受影响（保留 transcript）', async () => {
    const transcriptDir = join(env.projectRoot, '.socverify', 'chat-messages');
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(join(transcriptDir, 'app-1.json'), '[{"role":"user"}]', 'utf-8');
    const ownedFile = join(env.globalRoot, '--D--proj--', 'omp-owned.jsonl');
    await writeFile(ownedFile, `${headerLine('omp-owned-1')}\n`, 'utf-8');
    await saveSessions(env.projectRoot, [
      {
        sessionId: 'app-1',
        engine: 'omp',
        engineSessionId: 'omp-owned-1',
        cwd: '/proj/dv',
        name: 'x',
        projectId: 'proj-1',
        createdAt: 1,
        lastActivityAt: 1,
      },
    ]);

    await cleanupLegacyOmpSessions(env.projectRoot, { roots: [env.globalRoot] });

    // transcript 保留
    const raw = await readFile(join(transcriptDir, 'app-1.json'), 'utf-8');
    expect(raw).toContain('user');
    // 索引保留（迁移记录不因清理而丢失）
    expect(await loadSessions(env.projectRoot)).toHaveLength(1);
  });

  it('无可清理内容 → 空报告不抛错', async () => {
    const report = await cleanupLegacyOmpSessions(env.projectRoot, { roots: [env.globalRoot] });
    expect(report.removed).toEqual([]);
    expect(report.residual).toEqual([]);
  });
});
