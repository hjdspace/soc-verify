/**
 * rpiv-todo 扩展加载冒烟测试（pi 引擎内置 todo 能力）。
 *
 * @juicesharp/rpiv-todo 的 package.json "." 出口是 TypeScript 源码（index.ts），
 * runner 经 jiti 转译加载（与 pi-mcp-adapter / pi-subagents 同一模式）。
 *
 * 通过真实 node 子进程探针验证加载链路（TS 源码入口 → 相对 .js→.ts 解析 →
 * peer deps @earendil-works/pi-ai / typebox → 注册 `todo` 工具与 /todos 命令）。
 * 不在测试进程内直接 jiti.import：vitest vmThreads 池会破坏 jiti 的模块
 * interop（"Cannot set property require ... only a getter"），而 runner 生产
 * 环境是普通 node 进程，子进程探针才是真实运行条件（见 fixtures/ 探针）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 项目根（探针脚本必须位于项目目录内，裸导入才能命中根 node_modules）
const PROJECT_ROOT = join(HERE, '..', '..');
const PROBE = join(HERE, 'fixtures', 'jiti-rpiv-todo-probe.mjs');

interface ProbeResult {
	ok: boolean;
	toolName: string;
	tools: Array<{ name: string; hasParams: boolean }>;
	commands: string[];
	events: string[];
}

function runProbe(): ProbeResult {
	const proc = spawnSync(process.execPath, [PROBE], {
		cwd: PROJECT_ROOT,
		encoding: 'utf-8',
		timeout: 60_000,
	});
	if (proc.status !== 0 || !proc.stdout) {
		throw new Error(
			`probe failed (status=${proc.status}): ${proc.stderr?.slice(0, 2000) ?? 'no output'}`,
		);
	}
	return JSON.parse(proc.stdout) as ProbeResult;
}

describe('rpiv-todo 扩展加载（jiti，TS 源码入口）', () => {
	it('注册 todo 工具与 /todos 命令（TOOL_NAME 为 replay 持久化键，契约固定）', () => {
		const result = runProbe();
		expect(result.ok).toBe(true);
		expect(result.tools.map((t) => t.name)).toContain('todo');
		const todo = result.tools.find((t) => t.name === 'todo')!;
		expect(todo.hasParams).toBe(true);
		expect(result.commands).toContain('todos');
	}, 90_000);

	it('扩展订阅 session 生命周期事件（replay / overlay 刷新时序）', () => {
		const result = runProbe();
		// session_start 触发 replay；tool_execution_end 触发 overlay 刷新（headless 空转）
		expect(result.events).toContain('session_start');
		expect(result.events).toContain('tool_execution_end');
	}, 90_000);
});
