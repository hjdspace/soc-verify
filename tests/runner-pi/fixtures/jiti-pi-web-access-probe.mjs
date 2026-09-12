/**
 * jiti 加载 pi-web-access 的子进程探针（供 pi-web-access-load.test.ts 调用）。
 *
 * 与 jiti-rpiv-todo-probe.mjs 同一模式：vitest vmThreads 池内 jiti 的模块
 * interop 会断裂（"Cannot set property require ... only a getter"），而 runner
 * 生产环境是普通 node 进程 —— 用真实 node 子进程探针才贴近运行时条件。
 * 脚本必须位于项目目录内，保证裸导入从根 node_modules 解析。
 */
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const mod = await jiti.import('pi-web-access');

const pi = {
	tools: [],
	commands: [],
	shortcuts: [],
	events: [],
	registerTool(tool) {
		pi.tools.push({ name: tool.name, hasParams: tool.parameters != null, label: tool.label });
	},
	registerCommand(name) {
		pi.commands.push(name);
	},
	registerShortcut(key) {
		pi.shortcuts.push(key);
	},
	on(event) {
		pi.events.push(event);
	},
	appendEntry() {
		// headless 探针空转即可
	},
};

mod.default(pi);
process.stdout.write(
	JSON.stringify({ ok: true, tools: pi.tools, commands: pi.commands, shortcuts: pi.shortcuts, events: pi.events }),
);
