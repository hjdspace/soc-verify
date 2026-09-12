/**
 * jiti 加载 @juicesharp/rpiv-todo 的子进程探针（供 rpiv-todo-load.test.ts 调用）。
 *
 * 单独成文件的原因：vitest vmThreads 池内 jiti 的模块 interop 会断裂
 * （"Cannot set property require ... only a getter"），而 runner 生产环境
 * 是普通 node 进程 —— 用真实 node 子进程探针才贴近运行时条件。
 * 脚本必须位于项目目录内，保证裸导入从根 node_modules 解析。
 */
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const mod = await jiti.import('@juicesharp/rpiv-todo');

const pi = {
	tools: [],
	commands: [],
	events: [],
	registerTool(tool) {
		pi.tools.push({ name: tool.name, hasParams: tool.parameters != null });
	},
	registerCommand(name) {
		pi.commands.push(name);
	},
	registerShortcut() {
		// headless 下快捷键注册空转即可
	},
	on(event) {
		pi.events.push(event);
	},
};

mod.default(pi);
process.stdout.write(
	JSON.stringify({ ok: true, tools: pi.tools, commands: pi.commands, events: pi.events }),
);
