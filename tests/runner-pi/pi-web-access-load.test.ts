/**
 * pi-web-access 扩展加载冒烟测试（pi 引擎内置网络搜索能力）。
 *
 * pi-web-access 的 package.json "." 出口是 TypeScript 源码（index.ts），
 * runner 经 jiti 转译加载（与 pi-mcp-adapter / pi-subagents / rpiv-todo
 * 同一模式，见 runner-pi/session.ts 的 assembleWebAccess）。
 *
 * 通过真实 node 子进程探针验证加载链路（TS 源码入口 → 相对 .js→.ts 解析 →
 * peer deps @earendil-works/pi-ai / pi-coding-agent / pi-tui → 注册
 * web_search / fetch_content / get_search_content / source_check 工具与
 * /websearch /curator /search 命令）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 项目根（探针脚本必须位于项目目录内，裸导入才能命中根 node_modules）
const PROJECT_ROOT = join(HERE, '..', '..');
const PROBE = join(HERE, 'fixtures', 'jiti-pi-web-access-probe.mjs');

interface ProbeResult {
	ok: boolean;
	tools: Array<{ name: string; hasParams: boolean; label?: string }>;
	commands: string[];
	shortcuts: string[];
	events: string[];
}

function runProbe(): ProbeResult {
	const proc = spawnSync(process.execPath, [PROBE], {
		cwd: PROJECT_ROOT,
		encoding: 'utf-8',
		timeout: 120_000,
	});
	if (proc.status !== 0 || !proc.stdout) {
		throw new Error(
			`probe failed (status=${proc.status}): ${proc.stderr?.slice(0, 2000) ?? 'no output'}`,
		);
	}
	return JSON.parse(proc.stdout) as ProbeResult;
}

describe('pi-web-access 扩展加载（jiti，TS 源码入口）', () => {
	it('注册 web_search / fetch_content / get_search_content / source_check 工具（工具名与 UI 卡片注册表契约固定）', () => {
		const result = runProbe();
		expect(result.ok).toBe(true);
		const names = result.tools.map((t) => t.name);
		expect(names).toContain('web_search');
		expect(names).toContain('fetch_content');
		expect(names).toContain('get_search_content');
		expect(names).toContain('source_check');
		for (const name of ['web_search', 'fetch_content', 'get_search_content', 'source_check']) {
			const tool = result.tools.find((t) => t.name === name)!;
			expect(tool.hasParams).toBe(true);
		}
	}, 150_000);

	it('注册 /websearch /curator /search 命令与会话生命周期事件', () => {
		const result = runProbe();
		expect(result.commands).toContain('websearch');
		expect(result.commands).toContain('curator');
		expect(result.commands).toContain('search');
		// session_start / session_tree 触发缓存恢复；curator 生命周期由扩展自身订阅
		expect(result.events).toContain('session_start');
		expect(result.events).toContain('session_tree');
	}, 150_000);
});
