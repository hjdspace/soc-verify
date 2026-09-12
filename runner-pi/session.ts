/**
 * pi 会话命令处理器 —— init / prompt / regenerate / steer / abort / setModel /
 * setApprovalMode / getMcpStatus / getMcpServerTools / reloadMcp / compact / destroy。
 *
 * init 通过 pi SDK 创建 AgentSession（原生用户级 session 根 + cwd bucket）：
 *   - 注册 host 转发工具（含 `ask`）作为 customTools；
 *   - DefaultResourceLoader 装配内联扩展：单次工具审批门（tool_call 拦截）、
 *     MCP 状态快照转发（pi.events 订阅）、pi-mcp-adapter（jiti 加载 TS 源码，
 *     显式注入单一来源配置绕开其多源合并）；
 *   - loader.reload({ resolveProjectTrust }) 走 host 信任存储 + 用户确认的
 *     项目信任决策，替代 SDK 默认的 ~/.pi trust.json 流程；
 * - 订阅 pi 原生事件并经 event-normalizer 归一化后转发给 host。
 *
 * pi 的 ToolDefinition 参数 schema 要求 TypeBox 类型，而 host 下发的是
 * JSON Schema 对象。运行时两者兼容（TypeBox 即 JSON Schema + 元数据符号，
 * omp runner 以同样方式透传），在 createAgentSession 边界做一次受控转换。
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type InlineExtension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { classifyContentBlock } from "./message-blocks.ts";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { createJiti } from "jiti";
import type { ApprovalMode } from "./approval-logic";
import {
	type Command,
	type HostToolDefinition,
	type InitConfig,
	type PiRunnerContext,
	type SeedHistoryMessage,
	type SessionRecoveryMode,
	sendEvent,
	sendResponse,
} from "./protocol.ts";
import { normalizePiEvent } from "./event-normalizer.ts";
import { mapPiContextUsage, sendContextUsage, shouldSendContextUsage } from "./context-usage.ts";
import { toPiThinkingLevel } from "./thinking-level.ts";
import { buildAppendSystemPrompt } from "./system-prompt.ts";
import { resolveMcpConfigSource } from "./mcp-config.ts";
import {
	createMcpRuntimeState,
	mapSnapshotToHostStatus,
	MCP_STATUS_CHANNEL,
	selectServerToolsFromSession,
	type AdapterStatusSnapshot,
	type McpRuntimeState,
} from "./mcp-runtime.ts";
import {
	buildTrustedMcpServers,
	resolveProjectTrustDecision,
	resolveToolCallGate,
} from "./extensions.ts";
import { buildSkillLoaderOptions } from "./skills.ts";
import {
	buildRpcStopRequest,
	normalizeAsyncStatusProgressFrames,
	normalizeChildStreamFrame,
	normalizeSubagentFrame,
	normalizeForegroundProgressFrames,
	resolveSubagentCeiling,
	RPC_REQUEST_CHANNEL,
	SUBAGENT_CHANNELS,
	SUBAGENT_ASYNC_STARTED_CHANNEL,
	SUBAGENT_ASYNC_COMPLETE_CHANNEL,
	SUBAGENT_CHILD_STATUS_CHANNEL,
	SUBAGENT_DELEGATION_RESPONSE_CHANNEL,
	SUBAGENT_FOREGROUND_COMPLETE_CHANNEL,
	trackSubagentRun,
	type SubagentEventBus,
	type SubagentRuntime,
} from "./subagents.ts";

// ─── 自定义工具注册（ask 等 host 转发工具） ─────────────

type ForwardedToolDefinition = {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		extensionCtx: unknown,
	): Promise<unknown>;
};

function buildCustomTools(
	defs: HostToolDefinition[],
	ctx: PiRunnerContext,
): ForwardedToolDefinition[] {
	return defs.map((def) => ({
		name: def.name,
		label: def.label ?? def.name,
		description: def.description,
		parameters: def.parameters,
		async execute(
			_toolCallId: string,
			params: unknown,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_extensionCtx: unknown,
		): Promise<unknown> {
			try {
				const result = await ctx.callHostTool(def.name, params);
				if (typeof result === "string") {
					return { content: [{ type: "text", text: result }] };
				}
				return result;
			} catch (err) {
				return {
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					isError: true,
				};
			}
		},
	}));
}

// ─── pi-mcp-adapter 加载（jiti，TS 源码入口） ───────────

/**
 * pi-mcp-adapter 的 package.json "." 出口是 TypeScript 源码（index.ts），
 * Node 无法直接导入（node_modules 内不做 type stripping）。runner 以 jiti
 * 加载；模块缓存一次，随进程生命周期复用。
 */
interface McpAdapterModule {
	createMcpAdapter(options?: {
		config?: { mcpServers: Record<string, unknown> };
		configPath?: string;
	}): (pi: unknown) => void;
}

let mcpAdapterModulePromise: Promise<McpAdapterModule> | null = null;

function loadMcpAdapter(): Promise<McpAdapterModule> {
	mcpAdapterModulePromise ??= createJiti(import.meta.url)
		.import("pi-mcp-adapter")
		.then((mod) => {
			const resolved = mod as McpAdapterModule | { default?: McpAdapterModule };
			const adapter =
				"createMcpAdapter" in resolved ? resolved : (resolved.default ?? null);
			if (!adapter || typeof adapter.createMcpAdapter !== "function") {
				throw new Error("pi-mcp-adapter loaded but createMcpAdapter export missing");
			}
			return adapter;
		});
	return mcpAdapterModulePromise;
}

// ─── pi-subagents 加载（jiti，TS 源码入口）──────────────

interface SubagentsModule {
	default: (pi: unknown) => void;
}

interface CapabilityCeilingModule {
	registerSubagentCapabilityCeiling(options: {
		sessionId: string;
		source: string;
		ceiling: { denyExtensions: true };
	}): { update(ceiling: { denyExtensions: true }): void; dispose(): void };
}

/**
 * pi-subagents 的 package.json "." 出口是 TypeScript 源码（index.ts），
 * 与 pi-mcp-adapter 同理由 jiti 加载（模块缓存随进程复用）。
 */
/**
 * pi-subagents 相关 TS 源码统一走同一 jiti 实例：扩展本体与 deep 模块
 * （child-session 工厂缝隙，见 installSubagentModelInheritance）必须命中
 * 同一份模块注册表，否则进程级工厂替换只作用于另一份模块拷贝、扩展不受影响。
 * （jiti 实例间靠全局 require.cache / 原生 ESM 注册表收敛，但同实例消除一切分叉可能。）
 */
const subagentsJiti = createJiti(import.meta.url);

function loadSubagentsModule(): Promise<SubagentsModule> {
	return subagentsJiti
		.import("pi-subagents")
		.then((mod) => {
			const resolved = mod as { default?: unknown };
			const factory = resolved.default;
			if (typeof factory !== "function") {
				throw new Error("pi-subagents loaded but default extension factory missing");
			}
			return { default: factory as (pi: unknown) => void };
		});
}

function loadCapabilityCeilingModule(): Promise<CapabilityCeilingModule> {
	return subagentsJiti.import("pi-subagents/capability-ceiling") as Promise<CapabilityCeilingModule>;
}

// ─── 子会话模型运行时继承（subagent 模型修复）────────────

/**
 * pi-subagents 的子会话工厂（src/runs/shared/child-session.ts）以
 * `ModelRuntime.create()`（无参）创建子会话共享的模型运行时，只读用户级
 * `~/.pi/agent/models.json`。本应用的自定义 provider
 * （socverify-openai-compatible 等）定义在 host 下发的独立 models.json
 * （InitConfig.modelsPath，会话级临时目录）中 —— 子代理解析继承的父模型
 * 引用（provider/modelId）时找不到 provider，全部以
 * "Model ... not found. Use --list-models to see available models." 失败。
 *
 * 修复分两层：
 *  1. 前台（async:false / 委派 / run fan-out）：子会话在 runner 进程内创建，
 *     经 pi-subagents 的进程级工厂替换口 setChildSessionFactory 安装
 *     loadPiCodingAgent 代理 —— 其 ModelRuntime.create 缺省注入父会话
 *     modelsPath + 运行时凭证（setRuntimeApiKey，与父会话对齐；models.json
 *     的 apiKey 字段无 $ 前缀是字面量，缺运行时凭证即 401 Forbidden）。
 *  2. 异步（async:true / RPC spawn）：子会话由 pi-subagents 自行 spawn 的
 *     detached runner 创建，其工厂经 runner 配置的 childSessionFactoryModule
 *     native import 注入 —— 生成一个 env 驱动的 .mjs wrapper（参数经
 *     spawnRunner 的 process.env 继承下发），wrapper 经 jiti 懒加载 seam
 *     （node_modules 下 .ts 禁止原生 type stripping）并构建同样的
 *     modelsPath + 运行时凭证注入工厂。
 *
 * 安装失败不静默降级：blockedReason 显式透出（init response + notice），
 * 子代理将以模型解析错误失败，host/UI 必须展示原因。
 */

const SOCVERIFY_SUBAGENT_MODELS_PATH_ENV = "SOCVERIFY_SUBAGENT_MODELS_PATH";
const SOCVERIFY_SUBAGENT_PI_ENTRY_URL_ENV = "SOCVERIFY_SUBAGENT_PI_ENTRY_URL";
const SOCVERIFY_SUBAGENT_SEAM_URL_ENV = "SOCVERIFY_SUBAGENT_SEAM_URL";
const SOCVERIFY_SUBAGENT_JITI_URL_ENV = "SOCVERIFY_SUBAGENT_JITI_URL";
const SOCVERIFY_SUBAGENT_PROVIDER_ENV = "SOCVERIFY_SUBAGENT_PROVIDER";
const SOCVERIFY_SUBAGENT_API_KEY_ENV = "SOCVERIFY_SUBAGENT_API_KEY";
// pi-subagents persists failed-model exclusions globally by default. Keep the
// cache scoped to this session so a stale 401 from another session cannot
// disable the currently configured model for subagent dispatch.
const PI_MODEL_EXCLUSIONS_PATH_ENV = "PI_MODEL_EXCLUSIONS_PATH";

/** pi-subagents child-session 模块（seam）的进程级工厂替换口。 */
interface ChildSessionSeam {
	createDefaultChildSessionFactory(options?: {
		loadPiCodingAgent?: () => Promise<unknown>;
		shutdownTimeoutMs?: number;
	}): ChildSessionFactory;
	setChildSessionFactory(factory: ChildSessionFactory): void;
	setChildSessionFactoryModule(modulePath: string | undefined): void;
}

type ChildSessionLaunch = {
	runtime: { runId?: string; agent?: string; childIndex?: number };
};

type ChildSession = {
	subscribe(listener: (event: unknown) => void): () => void;
};

type ChildSessionFactory = {
	create(launch: ChildSessionLaunch): Promise<ChildSession>;
	dispose(): Promise<void>;
};

// ─── retry 治理（HTTP 层预算 + 会话层预算 + 误标错误改写） ───

/**
 * pi 有两层重试：
 *  - HTTP 层 provider retry（pi 默认关闭：settings `retry.provider.maxRetries`
 *    未配置时为 0）按 HTTP 状态码判定（408/409/429/5xx），不受响应体里误导性
 *    code 的影响，并遵循 retry-after / retry-after-ms 头（超过 maxRetryDelayMs
 *    的服务端延迟仍立即失败，避免长时间卡死）。maxRetries=3：退避序列约
 *    0.5s/1s/2s。
 *  - 会话级 auto retry（默认开启 3 次 × 2s 指数退避，约 14s）按 errorMessage
 *    文本分类。pi-ai 把 `insufficient_quota` 归为"配额/计费耗尽"类永久错误、
 *    fail fast 不重试 —— 而内部 OpenAI 兼容网关把瞬时 TPM/RPM 限流误用该 code
 *    上报（`type:"rate_limit_error"` + `code:"insufficient_quota"`），导致可恢复
 *    限流被当成永久错误直接终止会话。
 *
 * 两项治理：
 *  1. 预算：会话层 5 次 × 4s 指数退避（4+8+16+32+64 = 124s 窗口，末次尝试约在
 *     60s 后启动，覆盖每分钟 RPM/TPM 窗口）；HTTP 层 3 次（每次会话层尝试内部
 *     自带）。经 SettingsManager.applyOverrides 内存覆盖，不落盘、不改用户级
 *     settings.json。override 必须在 loader.reload() 之后应用（reload 会从磁盘
 *     重建 settings 冲掉内存值，见 applyRetryOverrides 调用点）；子会话经
 *     patchChildSettingsManager 在每次重建后重放。
 *  2. 误标改写：buildRetryReclassifyExtension 在 message_end 把"明确声明
 *     rate_limit_error / tpm / rpm 的瞬时错误"中的误导性配额标记改写掉，
 *     让 pi 内建会话级 retry 分类放行（真实配额耗尽不含这些瞬时信号，仍 fail fast）。
 */
const PROVIDER_HTTP_MAX_RETRIES = 3;
const SESSION_RETRY_MAX_RETRIES = 5;
const SESSION_RETRY_BASE_DELAY_MS = 4000;

/** 重试预算 override（主会话 applyRetryOverrides 与子会话 patchChildSettingsManager 共用同一数值）。 */
const RETRY_OVERRIDES = {
	retry: {
		maxRetries: SESSION_RETRY_MAX_RETRIES,
		baseDelayMs: SESSION_RETRY_BASE_DELAY_MS,
		provider: { maxRetries: PROVIDER_HTTP_MAX_RETRIES },
	},
} as Parameters<SettingsManager["applyOverrides"]>[0];

function applyRetryOverrides(settingsManager: SettingsManager): void {
	settingsManager.applyOverrides(RETRY_OVERRIDES);
}

/**
 * 子会话 SettingsManager 包装：pi-subagents 为每个子会话自建 SettingsManager，
 * 其 loader.reload() 内部的 reload()/setProjectTrusted() 会从磁盘重建 settings
 * 并冲掉内存 override（与主会话同一时序问题）——包装这两个方法，在每次重建
 * 之后重放 retry override，使子会话与父会话共享同一重试预算。
 */
function patchChildSettingsManager(manager: SettingsManager): SettingsManager {
	const reapply = () => manager.applyOverrides(RETRY_OVERRIDES);
	const originalReload = manager.reload.bind(manager);
	manager.reload = async () => {
		await originalReload();
		reapply();
	};
	const originalSetProjectTrusted = manager.setProjectTrusted.bind(manager);
	manager.setProjectTrusted = (trusted: boolean) => {
		originalSetProjectTrusted(trusted);
		reapply();
	};
	return manager;
}

/**
 * detached async runner 使用的子会话工厂 wrapper（.mjs，env 驱动）。
 * 不用 top-level await / require(esm)：工厂对象同步导出，seam 与 pi 包在
 * 首次 create 时经动态 import 懒加载。
 *
 * seam（pi-subagents 的 .ts 源码，位于 node_modules 下）禁止原生 type
 * stripping（Node ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），必须经
 * jiti 转译加载 —— tryNative 会撞同样的限制，显式关闭。JITI_ALIAS 已由
 * pi-subagents spawnRunner 注入 detached runner 进程 env，createJiti 默认
 * 读取，seam 内部的 "@earendil-works/pi-coding-agent" 导入按同一别名解析。
 * pi 包入口（dist/*.js，纯 ESM）无此限制，保持原生 import（与 runner 自身
 * 的 pi 实例收敛到同一原生 ESM 注册表）。
 */
export const SUBAGENT_CHILD_FACTORY_WRAPPER_SOURCE = `\
// Generated by SoC Verify runner-pi - do not edit.
// Subagent child session factory for the detached async runner: injects the
// parent session's models.json into the child shared ModelRuntime so the
// inherited model reference (provider/modelId) resolves. All inputs arrive
// via environment variables (inherited through pi-subagents spawnRunner).
let factoryPromise;
const RETRY_OVERRIDES = {
	retry: {
		maxRetries: ${SESSION_RETRY_MAX_RETRIES},
		baseDelayMs: ${SESSION_RETRY_BASE_DELAY_MS},
		provider: { maxRetries: ${PROVIDER_HTTP_MAX_RETRIES} },
	},
};
// 子会话 SettingsManager 包装：loader.reload() 内部的 reload/setProjectTrusted
// 会从磁盘重建 settings 并冲掉内存 override，每次重建后重放 retry override
//（与父会话同一重试预算，见 runner session.ts 的 patchChildSettingsManager）。
function patchChildSettingsManager(manager) {
	const reapply = () => manager.applyOverrides(RETRY_OVERRIDES);
	const originalReload = manager.reload.bind(manager);
	manager.reload = async () => {
		await originalReload();
		reapply();
	};
	const originalSetProjectTrusted = manager.setProjectTrusted.bind(manager);
	manager.setProjectTrusted = (trusted) => {
		originalSetProjectTrusted(trusted);
		reapply();
	};
	return manager;
}
async function resolveFactory() {
	factoryPromise ??= (async () => {
		const seamUrl = process.env.SOCVERIFY_SUBAGENT_SEAM_URL;
		const piUrl = process.env.SOCVERIFY_SUBAGENT_PI_ENTRY_URL;
		const jitiUrl = process.env.SOCVERIFY_SUBAGENT_JITI_URL;
		if (!seamUrl || !piUrl || !jitiUrl) {
			throw new Error("SOCVERIFY_SUBAGENT_SEAM_URL / SOCVERIFY_SUBAGENT_PI_ENTRY_URL / SOCVERIFY_SUBAGENT_JITI_URL not set");
		}
		const jitiModule = await import(jitiUrl);
		const createJiti = jitiModule.createJiti ?? jitiModule.default;
		if (typeof createJiti !== "function") {
			throw new Error("jiti createJiti export missing");
		}
		const jiti = createJiti(seamUrl, { tryNative: false });
		const seam = await jiti.import(seamUrl);
		const pi = await import(piUrl);
		const modelsPath = process.env.SOCVERIFY_SUBAGENT_MODELS_PATH ?? null;
		const provider = process.env.SOCVERIFY_SUBAGENT_PROVIDER;
		const apiKey = process.env.SOCVERIFY_SUBAGENT_API_KEY;
		const patchedPi = {
			...pi,
			ModelRuntime: Object.assign(Object.create(pi.ModelRuntime), {
				create: async (options) => {
					const runtime = await pi.ModelRuntime.create({
						...options,
						modelsPath: (options && options.modelsPath) ?? modelsPath,
					});
					// 与父会话 handleInit 的 setRuntimeApiKey 对齐：models.json 的
					// apiKey 字段是无 $ 前缀的字面量（不会被解析为 env 引用），
					// 运行时凭证是唯一正确的鉴权来源，缺失即 401 Forbidden。
					if (provider && apiKey) await runtime.setRuntimeApiKey(provider, apiKey);
					return runtime;
				},
			}),
			SettingsManager: Object.assign(Object.create(pi.SettingsManager), {
				create: (...args) => patchChildSettingsManager(pi.SettingsManager.create(...args)),
			}),
		};
		return seam.createDefaultChildSessionFactory({ loadPiCodingAgent: async () => patchedPi });
	})();
	return factoryPromise;
}
export default {
	async create(launch) {
		return (await resolveFactory()).create(launch);
	},
	async dispose() {
		if (!factoryPromise) return;
		const factory = await factoryPromise;
		await factory.dispose();
	},
};
`;

function resolveMaybeFileUrl(resolved: string): string {
	return resolved.startsWith("file://") ? fileURLToPath(resolved) : resolved;
}

/**
 * 为子会话工厂构建 pi 模块代理：
 *  - ModelRuntime.create 缺省注入 modelsPath（+ 运行时凭证），其余导出保持
 *    原引用（子会话与父会话共用同一 SDK 模块状态）；
 *  - SettingsManager.create 经 patchChildSettingsManager 包装，保证子会话
 *    loader.reload() 冲掉 settings 后重试预算 override 仍然生效。
 *
 * provider/apiKey 存在时对齐父会话的 setRuntimeApiKey —— models.json 的
 * apiKey 字段（无 $ 前缀）是字面量而非 env 引用，运行时凭证缺失会导致
 * 子会话以 Bearer <字面量> 请求 → 401 Forbidden。
 */
function buildModelInheritingPiModule(
	pi: typeof import("@earendil-works/pi-coding-agent"),
	options: { modelsPath: string; provider?: string; apiKey?: string },
): unknown {
	const { modelsPath, provider, apiKey } = options;
	return {
		...pi,
		ModelRuntime: Object.assign(Object.create(pi.ModelRuntime), {
			create: async (createOptions?: { modelsPath?: string | null }) => {
				const runtime = await pi.ModelRuntime.create({
					...createOptions,
					modelsPath: createOptions?.modelsPath ?? modelsPath,
				} as Parameters<typeof pi.ModelRuntime.create>[0]);
				if (provider && apiKey) {
					await runtime.setRuntimeApiKey(provider, apiKey);
				}
				return runtime;
			},
		}),
		SettingsManager: Object.assign(Object.create(pi.SettingsManager), {
			create: (...args: Parameters<typeof pi.SettingsManager.create>) =>
				patchChildSettingsManager(pi.SettingsManager.create(...args)),
		}),
	};
}

/** 加载 pi-subagents 的 child-session seam 模块（deep import，与扩展本体同实例）。 */
async function loadChildSessionSeam(): Promise<{ seam: ChildSessionSeam; seamPath: string }> {
	const resolved = subagentsJiti.esmResolve("pi-subagents");
	if (!resolved) {
		throw new Error("pi-subagents package root unresolved");
	}
	const rootDir = dirname(resolveMaybeFileUrl(resolved));
	const seamPath = join(rootDir, "src", "runs", "shared", "child-session.ts");
	const seam = (await subagentsJiti.import(seamPath)) as Partial<ChildSessionSeam>;
	if (
		typeof seam.createDefaultChildSessionFactory !== "function" ||
		typeof seam.setChildSessionFactory !== "function" ||
		typeof seam.setChildSessionFactoryModule !== "function"
	) {
		throw new Error("child-session seam exports missing (createDefaultChildSessionFactory / setChildSessionFactory / setChildSessionFactoryModule)");
	}
	return { seam: seam as ChildSessionSeam, seamPath };
}

/**
 * 安装子会话模型继承（前台工厂替换 + 异步 wrapper 注入）。失败写入
 * runtime.blockedReason（显式透出，不中断 init、不停用 subagent 能力）。
 */
async function installSubagentModelInheritance(
	config: InitConfig,
	modelsPath: string,
	runtime: SubagentRuntime,
): Promise<void> {
	try {
		const { seam, seamPath } = await loadChildSessionSeam();

		// 1) 前台：进程级工厂替换（ModelRuntime.create 缺省注入 modelsPath + 运行时凭证）
		const piModule = await import("@earendil-works/pi-coding-agent");
		const patchedPi = buildModelInheritingPiModule(piModule, {
			modelsPath,
			provider: config.provider,
			apiKey: config.apiKey,
		});
		const baseFactory = seam.createDefaultChildSessionFactory({
			loadPiCodingAgent: () => Promise.resolve(patchedPi),
		});
		const childSubscriptions = new Set<() => void>();
		const factory: ChildSessionFactory = {
			async create(launch) {
				const child = await baseFactory.create(launch);
				const unsubscribe = child.subscribe((event) => runtime.onChildEvent?.({
					runId: launch.runtime.runId,
					agent: launch.runtime.agent,
					index: launch.runtime.childIndex ?? 0,
					event,
				}));
				childSubscriptions.add(unsubscribe);
				return child;
			},
			async dispose() {
				for (const unsubscribe of childSubscriptions) unsubscribe();
				childSubscriptions.clear();
				await baseFactory.dispose();
			},
		};
		seam.setChildSessionFactory(factory);

		// 2) 异步：detached runner 的工厂经 env 驱动 wrapper 注入
		//    （spawnRunner 继承 runner 进程 env；wrapper 写入 models.json 同目录）
		process.env[SOCVERIFY_SUBAGENT_MODELS_PATH_ENV] = modelsPath;
		process.env[PI_MODEL_EXCLUSIONS_PATH_ENV] = join(dirname(modelsPath), "subagent-model-exclusions.json");
		process.env[SOCVERIFY_SUBAGENT_PI_ENTRY_URL_ENV] ??=
			subagentsJiti.esmResolve("@earendil-works/pi-coding-agent");
		process.env[SOCVERIFY_SUBAGENT_SEAM_URL_ENV] ??= pathToFileURL(seamPath).href;
		process.env[SOCVERIFY_SUBAGENT_JITI_URL_ENV] ??= subagentsJiti.esmResolve("jiti");
		if (config.provider) process.env[SOCVERIFY_SUBAGENT_PROVIDER_ENV] = config.provider;
		else delete process.env[SOCVERIFY_SUBAGENT_PROVIDER_ENV];
		if (config.apiKey) process.env[SOCVERIFY_SUBAGENT_API_KEY_ENV] = config.apiKey;
		else delete process.env[SOCVERIFY_SUBAGENT_API_KEY_ENV];
		const wrapperPath = join(dirname(modelsPath), "socverify-subagent-child-factory.mjs");
		mkdirSync(dirname(modelsPath), { recursive: true });
		writeFileSync(wrapperPath, SUBAGENT_CHILD_FACTORY_WRAPPER_SOURCE, "utf-8");
		seam.setChildSessionFactoryModule(wrapperPath);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		runtime.blockedReason = `Subagent model inheritance unavailable: ${reason}`;
	}
}

// ─── 内联扩展装配（审批 / trust / MCP） ─────────────────

/**
 * 单次工具审批扩展：拦截所有工具调用（pi 内置、host 工具、MCP、extension），
 * 按当前审批模式决定是否请求用户审批。审批模式运行时可变（setApprovalMode），
 * 因此 getMode 闭包读取 ctx 而非快照。
 */
function buildApprovalExtension(ctx: PiRunnerContext): InlineExtension {
	return {
		name: "socverify-approval",
		hidden: true,
		factory: (pi) => {
			pi.on("tool_call", async (event) =>
				resolveToolCallGate(
					event.toolName,
					event.input,
					() => ctx.currentApprovalMode,
					ctx.requestApproval,
				),
			);
		},
	};
}

/**
 * MCP 状态转发扩展：pi-mcp-adapter 在共享事件总线上发布状态快照
 * （channel pi-mcp-adapter/status/v1），此扩展订阅并写入 runner 侧运行时
 * 状态，供 getMcpStatus 查询 —— 无 TUI 场景下 adapter 唯一的 headless 出口。
 */
function buildMcpStatusExtension(runtime: McpRuntimeState): InlineExtension {
	return {
		name: "socverify-mcp-status",
		hidden: true,
		factory: (pi) => {
			pi.events.on(MCP_STATUS_CHANNEL, (data: unknown) => {
				runtime.applyStatusSnapshot(data as AdapterStatusSnapshot);
			});
		},
	};
}

interface McpAssembly {
	factories: InlineExtension[];
	/** 冲突/回退报告（host 展示用） */
	ignored: Awaited<ReturnType<typeof resolveMcpConfigSource>>["ignored"];
}

/**
 * MCP 装配：解析单一来源配置 → 信任过滤（未信任 server 逐个请求用户确认）
 * → adapter 工厂显式注入 server 集。无可用 server 时 adapter 不加载。
 */
async function assembleMcp(config: InitConfig, ctx: PiRunnerContext): Promise<McpAssembly> {
	if (config.enableMCP === false) {
		return { factories: [], ignored: [] };
	}

	const resolution = await resolveMcpConfigSource(config.cwd);
	const plan = await buildTrustedMcpServers(resolution, {
		enableMCP: true,
		trustedMcpServers: config.trustedMcpServers ?? [],
		requestTrust: ctx.requestTrust,
	});

	const runtime = createMcpRuntimeState(Object.keys(plan.mcpServers));
	runtime.configSourcePath = resolution.selected?.path ?? null;
	ctx.mcpRuntime = runtime;

	if (Object.keys(plan.mcpServers).length === 0) {
		return { factories: [], ignored: plan.ignored };
	}

	const adapter = await loadMcpAdapter();
	const mcpAdapterFactory = adapter.createMcpAdapter({
		config: { mcpServers: plan.mcpServers },
	});

	return {
		factories: [
			buildMcpStatusExtension(runtime),
			{
				name: "socverify-mcp-adapter",
				hidden: true,
				// adapter 工厂经 jiti 以 unknown 类型载入；pi 侧实参由 SDK 保证
				factory: (pi) => {
					(mcpAdapterFactory as (p: unknown) => void)(pi);
				},
			},
		],
		ignored: plan.ignored,
	};
}

// ─── subagent 装配（issue 05）───────────────────────────

/**
 * subagent 事件桥：订阅 pi-subagents 在 pi.events 发布的通道，归一化为
 * host SubagentFrame 契约后转发；同时跟踪活动 run（取消传播/清理用）并
 * 注入 pi.events 引用供 cancelSubagent 命令使用。
 */
function buildSubagentBridgeExtension(ctx: PiRunnerContext, runtime: SubagentRuntime): InlineExtension {
	return {
		name: "socverify-subagent-bridge",
		hidden: true,
		factory: (pi) => {
			const events = (pi as { events?: SubagentEventBus }).events ?? null;
			runtime.events = events;
			if (!events) return;
			const activeToolCalls = new Map<string, { agent?: string; childCount?: number }>();
			const runParents = new Map<string, string>();
			// 前台流式进度变化检测签名（id → sig），tool_execution_end 时清理
			const progressKeys = new Map<string, string>();
			const asyncProgressRuns = new Map<string, {
				asyncDir: string;
				parentToolCallId?: string;
				eventOffset: number;
				eventRemainder: string;
				childCount?: number;
			}>();
			let asyncProgressTimer: ReturnType<typeof setInterval> | undefined;
			const parentSessionId = () => ctx.session != null
				? ((ctx.session as { sessionId?: string }).sessionId ?? null)
				: null;
			const stopAsyncProgress = (runId: string) => {
				asyncProgressRuns.delete(runId);
				for (const key of [...progressKeys.keys()].filter((candidate) => candidate === runId || candidate.startsWith(`${runId}:`))) {
					progressKeys.delete(key);
				}
				if (asyncProgressRuns.size === 0 && asyncProgressTimer) {
					clearInterval(asyncProgressTimer);
					asyncProgressTimer = undefined;
				}
			};
			const childId = (parentId: string, index: number, count: number | undefined) =>
				count === 1 ? parentId : `${parentId}:${index}`;
			const readAsyncStream = (runId: string) => {
				const run = asyncProgressRuns.get(runId);
				if (!run || run.childCount === undefined) return;
				const eventsPath = join(run.asyncDir, "events.jsonl");
				try {
					const size = statSync(eventsPath).size;
					if (size < run.eventOffset) {
						run.eventOffset = 0;
						run.eventRemainder = "";
					}
					if (size === run.eventOffset) return;
					const buffer = Buffer.alloc(size - run.eventOffset);
					const file = openSync(eventsPath, "r");
					let bytesRead = 0;
					try {
						bytesRead = readSync(file, buffer, 0, buffer.length, run.eventOffset);
					} finally {
						closeSync(file);
					}
					run.eventOffset += bytesRead;
					const lines = `${run.eventRemainder}${buffer.subarray(0, bytesRead).toString("utf8")}`.split("\n");
					run.eventRemainder = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.trim()) continue;
						const raw = JSON.parse(line) as Record<string, unknown>;
						if (raw.subagentSource !== "child" || raw.subagentRunId !== runId) continue;
						const index = typeof raw.subagentStepIndex === "number" ? raw.subagentStepIndex : 0;
						for (const frame of normalizeChildStreamFrame(childId(runId, index, run.childCount), raw, {
							parentSessionId: parentSessionId(),
							parentToolCallId: run.parentToolCallId,
							index,
							agent: typeof raw.subagentAgent === "string" ? raw.subagentAgent : undefined,
						})) sendEvent(frame);
					}
				} catch {
					// events.jsonl is best-effort and may not exist until the child emits its first event.
				}
			};
			const refreshAsyncProgress = (runId: string) => {
				const run = asyncProgressRuns.get(runId);
				if (!run) return;
				try {
					const status = JSON.parse(readFileSync(join(run.asyncDir, "status.json"), "utf8")) as unknown;
					const steps = typeof status === "object" && status !== null
						? (status as { steps?: unknown }).steps
						: undefined;
					run.childCount = Array.isArray(steps) ? steps.length : run.childCount;
					for (const frame of normalizeAsyncStatusProgressFrames(runId, status, {
						parentSessionId: parentSessionId(),
						parentToolCallId: run.parentToolCallId,
					})) {
						const id = String(frame.payload.id);
						const sig = JSON.stringify(frame.payload.progress);
						if (progressKeys.get(id) === sig) continue;
						progressKeys.set(id, sig);
						sendEvent(frame);
					}
					readAsyncStream(runId);
				} catch {
					// status.json is created and atomically replaced by the detached runner; retry on the next tick.
				}
			};
			const startAsyncProgress = (runId: string, asyncDir: string, parentToolCallId?: string) => {
				asyncProgressRuns.set(runId, {
					asyncDir,
					parentToolCallId,
					eventOffset: 0,
					eventRemainder: "",
				});
				refreshAsyncProgress(runId);
				if (asyncProgressTimer) return;
				asyncProgressTimer = setInterval(() => {
					for (const id of asyncProgressRuns.keys()) refreshAsyncProgress(id);
				}, 500);
				asyncProgressTimer.unref?.();
			};
			pi.on("session_shutdown", () => {
				if (asyncProgressTimer) clearInterval(asyncProgressTimer);
				asyncProgressTimer = undefined;
				asyncProgressRuns.clear();
				progressKeys.clear();
				runtime.onChildEvent = undefined;
			});

			const countChildren = (args: Record<string, unknown>): number | undefined => {
				if (Array.isArray(args.tasks)) return args.tasks.length;
				if (Array.isArray(args.chain)) {
					return args.chain.reduce((total, item) => {
						if (typeof item !== "object" || item === null) return total;
						const parallel = (item as Record<string, unknown>).parallel;
						return total + (Array.isArray(parallel) ? parallel.length : 1);
					}, 0);
				}
				return typeof args.agent === "string" ? 1 : undefined;
			};
			runtime.onChildEvent = ({ runId, agent, index, event }) => {
				let parentToolCallId = runId ? runParents.get(runId) : undefined;
				if (!parentToolCallId) {
					const matches = [...activeToolCalls].filter(([, active]) =>
						agent !== undefined && active.agent === agent,
					);
					if (matches.length === 1) parentToolCallId = matches[0]?.[0];
					else if (activeToolCalls.size === 1) parentToolCallId = activeToolCalls.keys().next().value;
				}
				if (!parentToolCallId) return;
				if (runId) runParents.set(runId, parentToolCallId);
				const count = activeToolCalls.get(parentToolCallId)?.childCount;
				for (const frame of normalizeChildStreamFrame(childId(parentToolCallId, index, count), event, {
					parentSessionId: parentSessionId(),
					parentToolCallId,
					index,
					agent,
				})) sendEvent(frame);
			};

			pi.on("tool_execution_start", (event) => {
				if (event.toolName !== "subagent") return;
				const args = typeof event.args === "object" && event.args !== null
					? event.args as Record<string, unknown>
					: {};
				// pi-subagents uses `action` for management/control calls. Only
				// execution calls own child lifecycle events and UI activity cards.
				if (typeof args.action === "string") return;
				activeToolCalls.set(event.toolCallId, {
					agent: typeof args.agent === "string" ? args.agent : undefined,
					childCount: countChildren(args),
				});
			});
			pi.on("tool_execution_end", (event) => {
				if (event.toolName !== "subagent") return;
				if (!activeToolCalls.has(event.toolCallId)) return;
				const result = typeof event.result === "object" && event.result !== null
					? event.result as Record<string, unknown>
					: {};
				const details = typeof result.details === "object" && result.details !== null
					? result.details as Record<string, unknown>
					: {};
				if (typeof details.asyncId === "string") runParents.set(details.asyncId, event.toolCallId);
				activeToolCalls.delete(event.toolCallId);
				for (const key of [event.toolCallId, ...[...progressKeys.keys()].filter((k) => k.startsWith(`${event.toolCallId}:`))]) {
					progressKeys.delete(key);
				}
			});

			// 前台 subagent 流式进度：pi 工具 onUpdate 快照（partialResult.details.progress，
			// AgentProgress 形状）→ subagent_progress 帧（归一化见 subagents.ts 的
			// normalizeForegroundProgressFrames）。delegation/async 原生通道只覆盖 slash
			// 委派与异步 run；主代理直接调用的前台子代理进度仅经 tool_execution_update 透出。
			pi.on("tool_execution_update", (event) => {
				if (event.toolName !== "subagent") return;
				if (!activeToolCalls.has(event.toolCallId)) return;
				const partial = typeof event.partialResult === "object" && event.partialResult !== null
					? event.partialResult as Record<string, unknown>
					: undefined;
				const details = typeof partial?.details === "object" && partial.details !== null
					? partial.details as Record<string, unknown>
					: undefined;
				const list = Array.isArray(details?.progress) ? details.progress : [];
				if (list.length === 0) return;
				const active = activeToolCalls.get(event.toolCallId);
				if (active) active.childCount = list.length;
				for (const frame of normalizeForegroundProgressFrames(event.toolCallId, list, {
					parentSessionId:
						ctx.session != null
							? ((ctx.session as { sessionId?: string }).sessionId ?? null)
							: null,
					parentToolCallId: event.toolCallId,
				})) {
					// 变化检测：fireUpdate 由子会话事件驱动、频率高，内容未变不重复发帧
					const prog = frame.payload.progress as Record<string, unknown>;
					const sig = JSON.stringify(prog);
					const id = String(frame.payload.id);
					if (progressKeys.get(id) === sig) continue;
					progressKeys.set(id, sig);
					sendEvent(frame);
				}
			});

			for (const channel of SUBAGENT_CHANNELS) {
				events.on(channel, (payload: unknown) => {
					const native = typeof payload === "object" && payload !== null
						? payload as Record<string, unknown>
						: {};
					const runId = [native.runId, native.requestId, native.id, native.childId]
						.find((value): value is string => typeof value === "string" && value.length > 0);
					let parentToolCallId = typeof native.parentToolCallId === "string"
						? native.parentToolCallId
						: typeof native.toolCallId === "string"
							? native.toolCallId
							: runId
								? runParents.get(runId)
								: undefined;
					if (!parentToolCallId) {
						const agent = typeof native.agent === "string" ? native.agent : undefined;
						const matches = [...activeToolCalls].filter(([, active]) =>
							agent !== undefined && active.agent === agent,
						);
						if (matches.length === 1) parentToolCallId = matches[0]?.[0];
						else if (activeToolCalls.size === 1) parentToolCallId = activeToolCalls.keys().next().value;
					}
					if (runId && parentToolCallId) runParents.set(runId, parentToolCallId);
					if (
						channel === SUBAGENT_ASYNC_STARTED_CHANNEL &&
						runId &&
						typeof native.asyncDir === "string"
					) {
						startAsyncProgress(runId, native.asyncDir, parentToolCallId);
					}
					// 活动 run 登记（async-started）：destroy 时据此下发 stop
					trackSubagentRun.onStart(runtime.registry, { channel, payload });
					if (runId && channel === SUBAGENT_ASYNC_COMPLETE_CHANNEL) refreshAsyncProgress(runId);
					for (const frame of normalizeSubagentFrame(channel, payload, {
						parentSessionId:
							ctx.session != null
								? ((ctx.session as { sessionId?: string }).sessionId ?? null)
								: null,
						parentToolCallId,
					})) {
						if (
							frame.type === "subagent_lifecycle" &&
							(channel === SUBAGENT_DELEGATION_RESPONSE_CHANNEL ||
								channel === SUBAGENT_ASYNC_COMPLETE_CHANNEL ||
								channel === SUBAGENT_FOREGROUND_COMPLETE_CHANNEL ||
								channel === SUBAGENT_CHILD_STATUS_CHANNEL)
						) {
							trackSubagentRun.onTerminal(runtime.registry, String(frame.payload.id));
							runParents.delete(String(frame.payload.id));
						}
						sendEvent(frame);
					}
					if (runId && channel === SUBAGENT_ASYNC_COMPLETE_CHANNEL) stopAsyncProgress(runId);
				});
			}
		},
	};
}

type SubagentsAssembly = {
	factories: InlineExtension[];
};

/**
 * subagent 装配：加载 pi-subagents 扩展 + 事件桥。
 *
 * 能力不足不静默降级：加载失败时 runtime.enabled=false 且携带显式
 * blockedReason（init response 透出 + notice 事件），host/UI 必须展示。
 */
async function assembleSubagents(config: InitConfig, ctx: PiRunnerContext): Promise<SubagentsAssembly> {
	const runtime: SubagentRuntime = {
		enabled: false,
		blockedReason: null,
		registry: trackSubagentRun.create(),
		events: null,
		ceilingHandle: null,
	};
	ctx.subagentRuntime = runtime;

	if (config.enableSubagents === false) {
		return { factories: [] };
	}

	let extensionFactory: (pi: unknown) => void;
	try {
		const mod = await loadSubagentsModule();
		extensionFactory = (pi: unknown) => {
			mod.default(pi);
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		runtime.blockedReason = `Subagent extension unavailable: ${reason}`;
		return { factories: [] };
	}

	runtime.enabled = true;

	// 子会话模型继承（详见 installSubagentModelInheritance 注释）：host 的
	// 自定义 provider 只存在于 modelsPath 指向的会话级 models.json，不注入时
	// 子代理解析继承的父模型引用必失败（"Model ... not found"）。失败显式
	// blockedReason，不停用 subagent 能力（内置 provider 的子代理仍可用）。
	if (config.modelsPath) {
		await installSubagentModelInheritance(config, config.modelsPath, runtime);
	}

	return {
		factories: [
			buildSubagentBridgeExtension(ctx, runtime),
			{
				name: "socverify-subagents",
				hidden: true,
				factory: (pi) => {
					extensionFactory(pi);
				},
			},
		],
	};
}

/**
 * 注册审批继承 ceiling（session 创建后调用，需要 sessionId）。
 * yolo 不注册（单次审批放宽；extension/MCP 信任边界独立于审批模式）。
 */
async function registerApprovalInheritance(runtime: SubagentRuntime | null, sessionId: string, mode: ApprovalMode): Promise<void> {
	if (!runtime?.enabled) return;
	const ceiling = resolveSubagentCeiling(mode);
	if (!ceiling) return;
	try {
		const mod = await loadCapabilityCeilingModule();
		runtime.ceilingHandle = mod.registerSubagentCapabilityCeiling({
			sessionId,
			source: "socverify-approval-inheritance",
			ceiling,
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		runtime.blockedReason = `Subagent approval inheritance unavailable: ${reason}`;
	}
}

// ─── rpiv-todo 加载（jiti，TS 源码入口）─────────────────

interface TodoExtensionModule {
	default: (pi: unknown) => void;
}

/**
 * @juicesharp/rpiv-todo 的 package.json "." 出口是 TypeScript 源码（index.ts），
 * 与 pi-mcp-adapter / pi-subagents 同理由 jiti 加载（模块缓存随进程复用）。
 * 扩展注册 `todo` 工具（create/update/list/get/delete/clear，4 态任务机），
 * headless 下 TUI overlay / 快捷键自动空转（ctx.hasUI 守卫），todo 状态经
 * 工具结果 details.tasks（Task[] 快照）随 tool_execution_end 回流 UI。
 */
let todoModulePromise: Promise<TodoExtensionModule> | null = null;

function loadTodoExtension(): Promise<TodoExtensionModule> {
	todoModulePromise ??= createJiti(import.meta.url)
		.import("@juicesharp/rpiv-todo")
		.then((mod) => {
			const resolved = mod as { default?: unknown };
			const factory = resolved.default;
			if (typeof factory !== "function") {
				throw new Error("rpiv-todo loaded but default extension factory missing");
			}
			return { default: factory as (pi: unknown) => void };
		});
	return todoModulePromise;
}

// ─── todo 装配（rpiv-todo 内置扩展）─────────────────────

type TodoAssembly = {
	factories: InlineExtension[];
	/** 加载失败原因（host/UI 显式展示，不静默降级） */
	blockedReason: string | null;
};

/**
 * todo 装配：加载 @juicesharp/rpiv-todo 扩展（注册 `todo` 工具与 /todos 命令）。
 * 失败不中断 init：blockedReason 由 handleInit 以 notice 事件透出。
 */
async function assembleTodo(): Promise<TodoAssembly> {
	try {
		const mod = await loadTodoExtension();
		return {
			factories: [
				{
					name: "socverify-todo",
					hidden: true,
					factory: (pi) => {
						mod.default(pi);
					},
				},
			],
			blockedReason: null,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { factories: [], blockedReason: reason };
	}
}

// ─── pi-web-access 加载（jiti，TS 源码入口）─────────────

interface WebAccessExtensionModule {
	default: (pi: unknown) => void;
}

/**
 * pi-web-access 的 package.json "." 出口是 TypeScript 源码（index.ts），
 * 与 pi-mcp-adapter / pi-subagents / rpiv-todo 同理由 jiti 加载（模块缓存随
 * 进程复用）。扩展注册 web_search / fetch_content / get_search_content /
 * source_check 四个网络工具与 /websearch /curator 等命令。
 */
let webAccessModulePromise: Promise<WebAccessExtensionModule> | null = null;

function loadWebAccessExtension(): Promise<WebAccessExtensionModule> {
	webAccessModulePromise ??= createJiti(import.meta.url)
		.import("pi-web-access")
		.then((mod) => {
			const resolved = mod as { default?: unknown };
			const factory = resolved.default;
			if (typeof factory !== "function") {
				throw new Error("pi-web-access loaded but default extension factory missing");
			}
			return { default: factory as (pi: unknown) => void };
		});
	return webAccessModulePromise;
}

// ─── web access 装配（pi-web-access 内置扩展）────────────

type WebAccessAssembly = {
	factories: InlineExtension[];
	/** 加载失败原因（host/UI 显式展示，不静默降级） */
	blockedReason: string | null;
};

/**
 * web access 装配：加载 pi-web-access 扩展（网络搜索 + URL 抓取 + 来源核查）。
 * 失败不中断 init：blockedReason 由 handleInit 以 notice 事件透出。
 * runner 为 headless（ctx.hasUI=false），浏览器 curator 工作流按扩展自身
 * 语义自动降级为 "none"（不弹浏览器、不启动 curator server），搜索直接
 * 返回带引用的综合答案。
 */
async function assembleWebAccess(): Promise<WebAccessAssembly> {
	try {
		const mod = await loadWebAccessExtension();
		return {
			factories: [
				{
					name: "socverify-web-access",
					hidden: true,
					factory: (pi) => {
						mod.default(pi);
					},
				},
			],
			blockedReason: null,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { factories: [], blockedReason: reason };
	}
}

// ─── 原生 session 恢复与 transcript 重建（issue 07）──────

/**
 * 提取 session entry 树中首条 user message 的纯文本。用于检测原生文件是否
 * 与 UI transcript 对齐：不匹配说明该文件只覆盖对话尾部（半覆盖），恢复它会
 * 静默丢失更早的 turn —— 必须改走 transcript 全量重建。
 */
function firstUserMessageText(manager: { getEntries(): unknown[] }): string | undefined {
	for (const entry of manager.getEntries()) {
		const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "user") continue;
		const content = msg.content;
		if (typeof content === "string") return content.trim();
		if (Array.isArray(content)) {
			return content
				.filter(
					(b): b is { type: "text"; text: string } =>
						typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
				)
				.map((b) => b.text)
				.join("\n")
				.trim();
		}
		return undefined;
	}
	return undefined;
}

/**
 * 原生恢复：在持久化 cwd 的 canonical bucket 中查找 resumeSessionId 对应的
 * pi 原生 session 并打开。不传 sessionDir —— pi 默认用户级根目录 + cwd bucket
 * （不新增项目级副本）。首条 user message 与 seedHistory 不一致时不恢复。
 * 任何失败（缺失 / 损坏 / 不匹配）返回 null，由调用方降级重建。
 */
async function openNativeSession(config: InitConfig): Promise<SessionManager | null> {
	if (!config.resumeSessionId) return null;
	try {
		const sessions: Array<{ id: string; path: string }> = await SessionManager.list(config.cwd);
		const target = sessions.find((s) => s.id === config.resumeSessionId);
		if (!target) {
			console.error(
				`[socverify-runner] native pi session ${config.resumeSessionId} not found in cwd bucket — rebuilding from transcript`,
			);
			return null;
		}
		const candidate = SessionManager.open(target.path);
		const seedFirstUser = config.seedHistory?.find((m) => m.role === "user")?.content.trim();
		if (seedFirstUser === undefined) return candidate;
		const nativeFirstUser = firstUserMessageText(candidate);
		if (nativeFirstUser === seedFirstUser) return candidate;
		console.error(
			`[socverify-runner] native pi session ${config.resumeSessionId} covers only a partial transcript (first user message mismatch) — rebuilding from stored UI history`,
		);
		return null;
	} catch (err) {
		console.error(
			`[socverify-runner] native pi session ${config.resumeSessionId} unavailable (${err instanceof Error ? err.message : String(err)}) — rebuilding from stored UI history`,
		);
		return null;
	}
}

/**
 * 把 UI transcript 写入新 session（重建路径）。种子消息使用零 usage 的占位
 * AssistantMessage（context builder 只读 content blocks，bookkeeping 字段不参与）。
 */
function seedTranscript(manager: SessionManager, seedHistory: SeedHistoryMessage[], config: InitConfig): void {
	const seededProvider = config.provider ?? "socverify-openai-compatible";
	const seededModel = config.model ?? "unknown";
	for (const msg of seedHistory) {
		if (msg.role === "user") {
			manager.appendMessage({
				role: "user",
				content: msg.content,
				timestamp: msg.timestamp,
			});
		} else {
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: msg.content }],
				api: "openai-completions",
				provider: seededProvider,
				model: seededModel,
				stopReason: "stop",
				timestamp: msg.timestamp,
				usage: {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
		}
	}
	console.error(`[socverify-runner] seeded ${seedHistory.length} messages from stored UI history into new pi session`);
}

/**
 * 解析 init 使用的 SessionManager 与恢复模式（issue 07）：
 *   native  —— 原生 session 命中且校验通过（权威历史，含工具结果/分支/compaction）
 *   rebuilt —— 原生不可用，create(cwd) 重建并写入 transcript（新 bucket、新 sessionId）
 *   new     —— 全新会话（无可恢复历史）
 */
async function resolveSessionManager(
	config: InitConfig,
): Promise<{ manager: SessionManager; recovery: SessionRecoveryMode }> {
	const resumed = await openNativeSession(config);
	if (resumed) return { manager: resumed, recovery: "native" };

	const manager = SessionManager.create(config.cwd);
	if (config.seedHistory && config.seedHistory.length > 0) {
		seedTranscript(manager, config.seedHistory, config);
		return { manager, recovery: "rebuilt" };
	}
	return { manager, recovery: "new" };
}

/** 瞬时限流强信号：type=rate_limit_error 或 tpm/rpm 字样。不含裸 429 —— 真实配额耗尽也是 429。 */
const TRANSIENT_RATE_LIMIT_SIGNAL = /"type"\s*:\s*"rate_limit_error"|tpm\b|rpm\b/i;
/** pi-ai 归为永久错误的配额/计费标记（NON_RETRYABLE 优先判定）。 */
const PERMANENT_QUOTA_MARKER = /insufficient_quota|quota exceeded|out of budget|billing/i;

/**
 * 改写网关误标的限流错误文本：仅当文本同时携带瞬时限流强信号与误导性配额标记时，
 * 把配额标记替换为限流措辞（保持 JSON 文本形态）。其余情况返回 null（不改写）。
 */
export function reclassifyTransientRateLimitError(text: string | undefined): string | null {
	if (!text || !PERMANENT_QUOTA_MARKER.test(text) || !TRANSIENT_RATE_LIMIT_SIGNAL.test(text)) {
		return null;
	}
	return text
		.replace(/insufficient_quota/gi, "rate_limit_error")
		.replace(/quota exceeded/gi, "rate limited")
		.replace(/out of budget/gi, "rate limited")
		.replace(/\bbilling\b/gi, "rate limited");
}

/**
 * message_end 误标改写扩展：pi 官方缝隙 —— message_end handler 返回替换消息时
 * AgentSession 以 _replaceMessageInPlace 原位替换，且发生在持久化与
 * _handlePostAgentRun 的 retry 分类之前。替换后的 errorMessage 经
 * isRetryableAssistantError 判为可重试 → 内建会话级 auto retry 接管
 * （auto_retry_start/end 事件 → event-normalizer → UI notice）。
 */
export function buildRetryReclassifyExtension(): InlineExtension {
	return {
		name: "socverify-retry-reclassify",
		hidden: true,
		factory: (pi) => {
			pi.on("message_end", (event) => {
				const message = event.message;
				if (message.role !== "assistant" || message.stopReason !== "error") return;
				if (typeof message.errorMessage !== "string") return;
				const rewritten = reclassifyTransientRateLimitError(message.errorMessage);
				if (!rewritten) return;
				return { message: { ...message, errorMessage: rewritten } };
			});
		},
	};
}

// ─── init ───────────────────────────────────────────────

export async function handleInit(
	cmd: Command & { type: "init" },
	ctx: PiRunnerContext,
): Promise<void> {
	const config = cmd.config;
	ctx.currentCwd = config.cwd;
	ctx.currentApprovalMode = config.approvalMode ?? "always-ask";

	// 应用环境变量（provider 认证等）
	if (config.env) {
		for (const [key, value] of Object.entries(config.env)) {
			process.env[key] = value;
		}
	}

	// OpenAI 兼容 provider：把 apiKey/baseUrl 同步到标准环境变量，
	// 供 pi-ai 的 openai-compatible provider 解析（与 omp runner 行为一致）。
	if (config.apiKey && config.provider) {
		const provider = config.provider.toLowerCase();
		const isOpenAiCompat =
			provider === "openai" || provider === "openai-compatible" || provider.includes("openai-compat");
		if (isOpenAiCompat) {
			process.env.OPENAI_API_KEY = config.apiKey;
			if (config.baseUrl) {
				process.env.OPENAI_BASE_URL = config.baseUrl;
			}
		}
	}

	// 资源装载器：内联扩展（审批门 + MCP + subagent）+ host 信任存储驱动的项目信任决策
	// appendSystemPrompt：Effective System Prompt = pi 基础提示词（base prompt）→ 用户自定义
	// 提示词 → SoC Verify 应用规则（issue 06，不做整体替换）。
	const mcp = await assembleMcp(config, ctx);
	const subagents = await assembleSubagents(config, ctx);
	const todo = await assembleTodo();
	const webAccess = await assembleWebAccess();
	const agentDir = getAgentDir();
	// 单一 SettingsManager 实例同时供 loader 与 createAgentSession 使用
	// （createAgentSession 不传 settingsManager 时会自建新实例，override 会丢失）。
	const settingsManager = SettingsManager.create(config.cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd: config.cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			buildApprovalExtension(ctx),
			// retry 误标改写需在 message_end 抢在持久化与 retry 分类之前（pi 官方替换缝隙）
			buildRetryReclassifyExtension(),
			...mcp.factories,
			...subagents.factories,
			...todo.factories,
			...webAccess.factories,
		],
		appendSystemPrompt: buildAppendSystemPrompt(config.systemPrompt),
		// skill 装载（issue 09）：host 下发有序 skillPaths（与 UI 发现同源），
		// runner 不自行发现 —— noSkills 关闭 pi 默认来源，additionalSkillPaths
		// 按顺序 first-wins（project > builtin > user，canonical 优先于 legacy）。
		...buildSkillLoaderOptions(config),
	});
	await loader.reload({
		// 项目信任：host 信任存储（trustedProjectDirs）命中直接放行；否则请求
		// 用户确认。拒绝时 pi 以 untrusted 设置装载（项目 extension 不加载）。
		resolveProjectTrust: async () =>
			resolveProjectTrustDecision(
				config.cwd,
				config.trustedProjectDirs ?? [],
				hasTrustRequiringProjectResources(config.cwd),
				ctx.requestTrust,
			),
	});

	// 重试 override 必须在 loader.reload() 之后应用：reload 内部会调
	// SettingsManager.reload()/setProjectTrusted() 从磁盘重建 settings，
	// 之前应用的内存 override 会被冲掉（曾导致 retry 退回 pi 默认 3 次）。
	applyRetryOverrides(settingsManager);

	// 初始思考强度：'default'/'auto' 不下发（跟随引擎默认，pi 会按模型能力 clamp）
	const initialThinkingLevel = toPiThinkingLevel(config.thinkingLevel);

	// 原生 session 恢复优先，缺失/损坏/不匹配时 transcript 重建（issue 07）。
	// SessionManager.list/open 不传 sessionDir —— pi 原生用户级根目录 + cwd bucket。
	const { manager, recovery } = await resolveSessionManager(config);

	// modelsPath 解耦（issue 07）：host 为 pi 引擎提供独立 models.json（临时目录），
	// agentDir 保持用户级 —— session 与模型配置不共用目录，原生 session 不随
	// 临时 runtimeDir 销毁而丢失。
	const modelRuntime = config.modelsPath
		? await ModelRuntime.create({
				authPath: join(getAgentDir(), "auth.json"),
				modelsPath: config.modelsPath,
			})
		: undefined;

	const result = await createAgentSession({
		cwd: config.cwd,
		sessionManager: manager,
		settingsManager,
		...(modelRuntime ? { modelRuntime } : {}),
		resourceLoader: loader,
		customTools: buildCustomTools(
			config.customToolDefinitions ?? [],
			ctx,
		) as unknown as ToolDefinition[],
		excludeTools: config.disabledTools,
		...(initialThinkingLevel ? { thinkingLevel: initialThinkingLevel } : {}),
	});
	const session = result.session;
	ctx.session = session;

	// 运行时 API key（优先于 auth.json 的凭证）
	if (config.apiKey && config.provider) {
		await session.modelRuntime.setRuntimeApiKey(config.provider, config.apiKey);
	}

	// 初始模型选择：注册表命中时切换；未命中保持引擎默认模型。
	// contextWindow 覆盖（issue 06）：host 配置窗口与模型声明窗口取 min
	// （与 omp runner 语义一致），以浅拷贝应用、不改写注册表对象。
	if (config.provider && config.model) {
		const model = session.modelRuntime.getModel(config.provider, config.model);
		if (model) {
			await session.setModel(applyContextWindowOverride(model, config.contextWindow));
		}
	}

	// 订阅 pi 原生事件 → 归一化为 Agent Event Contract → 转发 host。
	// pi 原生事件名不越出 runner 进程（issue 03 验收标准）。
	// 上下文增长边界（message_end / agent_end / compaction）额外推送
	// context_usage（pi 原生值优先，issue 06）。
	ctx.unsubscribe = session.subscribe((event) => {
		for (const normalized of normalizePiEvent(event)) {
			sendEvent(normalized);
		}
		if (
			typeof event === "object" &&
			event !== null &&
			typeof (event as { type?: unknown }).type === "string" &&
			shouldSendContextUsage((event as { type: string }).type)
		) {
			sendContextUsage(session);
		}
	});
	sendContextUsage(session);

	// 审批继承：按父会话 sessionId 注册 subagent capability ceiling（yolo 不收紧）
	await registerApprovalInheritance(ctx.subagentRuntime, session.sessionId, ctx.currentApprovalMode);

	// subagent 能力状态透出（能力不足时 host 显式展示阻断原因，不静默降级）
	const subagentStatus = ctx.subagentRuntime
		? { enabled: ctx.subagentRuntime.enabled, blockedReason: ctx.subagentRuntime.blockedReason }
		: { enabled: false, blockedReason: "Subagent runtime not assembled" };
	if (subagentStatus.blockedReason) {
		sendEvent({ type: "notice", text: subagentStatus.blockedReason, message: subagentStatus.blockedReason });
	}

	// todo 扩展状态透出（加载失败显式展示，不静默降级 —— `todo` 工具不可用时
	// 模型无法创建任务清单，UI 必须知道原因）
	if (todo.blockedReason) {
		const text = `Todo extension unavailable: ${todo.blockedReason}`;
		sendEvent({ type: "notice", text, message: text });
	}

	// web access 扩展状态透出（加载失败显式展示，不静默降级 —— `web_search`
	// 等网络工具不可用时模型无法联网，UI 必须知道原因）
	if (webAccess.blockedReason) {
		const text = `Web access extension unavailable: ${webAccess.blockedReason}`;
		sendEvent({ type: "notice", text, message: text });
	}

	// recovered 标记（issue 07）：host 据此在重建后更新 engineSessionId
	// （重建 = 新 pi session id；原生恢复时 id 与持久化记录一致）。
	sendResponse(cmd.id, true, {
		sessionId: session.sessionId,
		recovered: recovery,
		subagent: subagentStatus,
	});
}

// ─── 图片解析 ───────────────────────────────────────────

/** data URL（data:image/png;base64,...）解析 MIME；裸 base64 回退 image/png。 */
function parseImage(img: string): { type: "image"; data: string; mimeType: string } {
	const match = /^data:([^;]+);base64,(.+)$/.exec(img);
	if (match) {
		return { type: "image", data: match[2], mimeType: match[1] };
	}
	return { type: "image", data: img, mimeType: "image/png" };
}

// ─── prompt / steer / abort ─────────────────────────────

export async function handlePrompt(
	cmd: Command & { type: "prompt" },
	ctx: PiRunnerContext,
): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as AgentSession;
	let images: Array<{ type: "image"; data: string; mimeType: string }> | undefined;
	if (cmd.images?.length) {
		images = cmd.images.map(parseImage);
	}
	await session.prompt(cmd.message, images ? { images } : undefined);
	sendResponse(cmd.id, true, { ok: true });
}

export async function handleSteer(
	cmd: Command & { type: "steer" },
	ctx: PiRunnerContext,
): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	await (ctx.session as AgentSession).steer(cmd.message);
	sendResponse(cmd.id, true, { ok: true });
}

export async function handleAbort(
	cmd: Command & { type: "abort" },
	ctx: PiRunnerContext,
): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	await (ctx.session as AgentSession).abort();
	sendResponse(cmd.id, true, { ok: true });
}

// ─── regenerate（issue 08：真实分支 + 新 engineSessionId）─

/**
 * 提取 user message 内容中的纯文本与图片块。文本块以换行拼接；
 * 图片块原样透传给 prompt（PromptOptions.images）。
 */
function extractUserContent(content: unknown): {
	text: string;
	images: Array<{ type: "image"; data: string; mimeType: string }> | undefined;
} {
	if (typeof content === "string") {
		return { text: content, images: undefined };
	}
	if (!Array.isArray(content)) {
		return { text: "", images: undefined };
	}
	const textParts: string[] = [];
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	for (const block of content) {
		const b = classifyContentBlock(block);
		if (!b) continue;
		if (b.kind === "text") {
			textParts.push(b.text);
		} else {
			images.push({ type: "image", data: b.data, mimeType: b.mimeType });
		}
	}
	return { text: textParts.join("\n"), images: images.length > 0 ? images : undefined };
}

/**
 * Regenerate 最后一个回合（issue 08）：创建真实新分支并产生新的
 * engineSessionId，旧分支的文件不被修改或删除（parentSession 链保留回看入口）。
 *
 * 分支点 = 最后一条 user message 的 parent（Regenerate Branch 语义：新分支在
 * user message 之前分叉，re-prompt 以同一文本重新追加 user turn）。
 *   - 持久化 manager：createBranchedSession(parentId) 在同一 bucket 创建新
 *     文件并原地切换（新 sessionId，header 记录 parentSession 链）；最后一条
 *     user message 是根（parentId null）时用 newSession() 开新文件。
 *   - 非持久化 manager（in-memory）：退化为同文件 branch()/resetLeaf()，
 *     sessionId 不变。
 * 分支后按 SDK navigateTree 的模式重置 agent 内存状态，再以原文本
 * fire-and-forget re-prompt —— response 先行（host 拿到新 engineSessionId
 * 持久化），turn 结果经正常事件通道流回。
 */
export async function handleRegenerate(
	cmd: Command & { type: "regenerate" },
	ctx: PiRunnerContext,
): Promise<void> {
	if (!ctx.session) {
		sendResponse(cmd.id, false, undefined, "Session not initialized");
		return;
	}
	const session = ctx.session as AgentSession;
	if (session.isStreaming) {
		sendResponse(cmd.id, false, undefined, "Session is streaming — wait until idle before regenerating");
		return;
	}

	const manager = session.sessionManager;
	let lastUser: { parentId: string | null; content: unknown } | null = null;
	for (const entry of manager.getBranch()) {
		const e = entry as {
			parentId: string | null;
			type?: string;
			message?: { role?: string; content?: unknown };
		};
		if (e.type === "message" && e.message?.role === "user") {
			lastUser = { parentId: e.parentId, content: e.message.content };
		}
	}
	if (!lastUser) {
		sendResponse(cmd.id, false, undefined, "No user message to regenerate");
		return;
	}

	const { text, images } = extractUserContent(lastUser.content);

	if (lastUser.parentId === null) {
		// 分支点在根之前：开全新 session 文件（同样产生新 id）
		if (manager.newSession() === undefined) {
			manager.resetLeaf();
		}
	} else if (manager.createBranchedSession(lastUser.parentId) === undefined) {
		// 非持久化 manager：退化为同文件分支（不产生新 id）
		manager.branch(lastUser.parentId);
	}

	// 分支后重置 agent 内存状态（与 SDK navigateTree 相同的模式），
	// 丢弃被重新生成的旧回合。
	session.agent.state.messages = manager.buildSessionContext().messages;

	sendResponse(cmd.id, true, { engineSessionId: manager.getSessionId() });

	// fire-and-forget：response 已发出，turn 结果经事件通道流回；
	// re-prompt 失败不影响已发出的 response。
	void session.prompt(text, images ? { images } : undefined).catch((err: unknown) => {
		const reason = err instanceof Error ? err.message : String(err);
		console.error(`[socverify-runner] regenerate re-prompt failed: ${reason}`);
		sendEvent({ type: "error", error: reason, message: reason });
	});
}

// ─── setModel ───────────────────────────────────────────

/**
 * contextWindow 覆盖（issue 06）：host 配置窗口与模型声明窗口取 min，
 * 以浅拷贝应用（不改写注册表对象）。init 与运行时 setModel 共用，
 * 保证运行时切换模型不丢 host 配置窗口。
 */
function applyContextWindowOverride<T extends { contextWindow?: number }>(
	model: T,
	configuredWindow: number | undefined,
): T {
	const advertisedWindow = model.contextWindow ?? 0;
	const configWindow = configuredWindow ?? 0;
	const effectiveWindow =
		advertisedWindow > 0
			? configWindow > 0
				? Math.min(configWindow, advertisedWindow)
				: advertisedWindow
			: configWindow;
	return effectiveWindow > 0 && effectiveWindow !== advertisedWindow
		? { ...model, contextWindow: effectiveWindow }
		: model;
}

export async function handleSetModel(
	cmd: Command & { type: "setModel" },
	ctx: PiRunnerContext,
): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as AgentSession;
	const model = session.modelRuntime.getModel(cmd.provider, cmd.modelId);
	if (!model) {
		throw new Error(`Model not found: ${cmd.provider}/${cmd.modelId}`);
	}
	await session.setModel(applyContextWindowOverride(model, ctx.configuredContextWindow));
	sendResponse(cmd.id, true, { ok: true });
}

// ─── setThinkingLevel（issue 06）────────────────────────

/**
 * 动态设置会话思考强度。
 * 'default'/'auto'：交还引擎默认 —— 按 pi SDK 的默认解析顺序重置
 * （模型级覆盖 → 全局默认值 → 兜底 'medium'），而不是保持上次设置的值。
 * 具体强度原样透传，pi 会按模型能力 clamp；变更写入 session transcript。
 */
export function handleSetThinkingLevel(
	cmd: Command & { type: "setThinkingLevel" },
	ctx: PiRunnerContext,
): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as AgentSession;
	if (cmd.level === "default" || cmd.level === "auto") {
		const settings = (session as { settingsManager?: { getModelThinkingLevel?(p: string, m: string): unknown; getDefaultThinkingLevel?(): unknown } }).settingsManager;
		const model = session.model;
		const perModel =
			model && settings?.getModelThinkingLevel
				? (settings.getModelThinkingLevel(model.provider, model.id) as string | undefined)
				: undefined;
		const globalDefault = settings?.getDefaultThinkingLevel
			? (settings.getDefaultThinkingLevel() as string | undefined)
			: undefined;
		const resolved = (perModel ?? globalDefault ?? "medium") as Parameters<
			typeof session.setThinkingLevel
		>[0];
		session.setThinkingLevel(resolved);
	} else {
		session.setThinkingLevel(cmd.level);
	}
	sendResponse(cmd.id, true, { ok: true });
}

// ─── setToolFilter / listAgentTools（issue 06）──────────

/** 动态更新禁用工具列表：从当前活动工具集中移除（`ask` 强制保留）。 */
export function handleSetToolFilter(
	cmd: Command & { type: "setToolFilter" },
	ctx: PiRunnerContext,
): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as AgentSession;
	const disabled = new Set(cmd.disabledTools ?? []);
	// `ask` 是 host 问答通道，禁用会阻断 Agent 向用户提问 —— 强制保留。
	disabled.delete("ask");
	const enabled = session.getActiveToolNames().filter((name) => !disabled.has(name));
	if (!enabled.includes("ask")) enabled.push("ask");
	session.setActiveToolsByName(enabled);
	sendResponse(cmd.id, true, { ok: true, disabledCount: disabled.size });
}

/** 枚举会话当前注册的全部工具（设置页工具面板展示用）。 */
export function handleListAgentTools(cmd: Command & { type: "listAgentTools" }, ctx: PiRunnerContext): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const tools = (ctx.session as AgentSession)
		.getAllTools()
		.map((t) => ({
			name: t.name,
			description: typeof t.description === "string" ? t.description : "",
		}));
	sendResponse(cmd.id, true, { tools });
}

// ─── getState / getMessages / getSystemPrompt（issue 06）─

export function handleGetMessages(cmd: Command & { type: "getMessages" }, ctx: PiRunnerContext): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const messages = (ctx.session as AgentSession).messages;
	sendResponse(cmd.id, true, { messages });
}

/**
 * 返回会话状态快照：模型、思考强度、context_usage（pi 原生值优先，
 * 未知时近似估算并带 approximate 标记）、压缩状态与当前 provider 认证状态。
 */
export function handleGetState(cmd: Command & { type: "getState" }, ctx: PiRunnerContext): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as AgentSession & {
		autoCompactionEnabled: boolean;
		modelRuntime: { getProviderAuthStatus(providerId: string): unknown };
	};
	const model = session.model
		? { provider: session.model.provider, id: session.model.id }
		: undefined;
	const nativeUsage = session.getContextUsage?.();
	// 认证状态查询 provider：优先当前模型，未选模型时回退 init 的 provider
	const authProvider = model?.provider ?? ctx.currentProvider;
	const state = {
		model,
		thinkingLevel: session.thinkingLevel,
		contextUsage: mapPiContextUsage(nativeUsage, { messages: session.messages }),
		isCompacting: session.isCompacting === true,
		autoCompactionEnabled: session.autoCompactionEnabled !== false,
		authStatus:
			authProvider != null
				? session.modelRuntime.getProviderAuthStatus(authProvider)
				: undefined,
	};
	sendResponse(cmd.id, true, { state });
}

/**
 * 返回会话当前生效的系统提示词（AgentSession.systemPrompt getter =
 * pi 基础提示词 + 附加内容经扩展修改后的最终值），供设置/会话 UI 查看。
 */
export function handleGetSystemPrompt(cmd: Command & { type: "getSystemPrompt" }, ctx: PiRunnerContext): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const systemPrompt = (ctx.session as AgentSession).systemPrompt;
	sendResponse(cmd.id, true, { systemPrompt });
}

// ─── setApprovalMode ────────────────────────────────────

/** 动态切换审批模式；对进行中的下一次工具调用立即生效，并同步 subagent 审批继承 ceiling。 */
export function handleSetApprovalMode(
	cmd: Command & { type: "setApprovalMode" },
	ctx: PiRunnerContext,
): void {
	ctx.currentApprovalMode = cmd.approvalMode;
	const handle = ctx.subagentRuntime?.ceilingHandle ?? null;
	if (handle) {
		const ceiling = resolveSubagentCeiling(cmd.approvalMode);
		if (ceiling) {
			handle.update(ceiling);
		} else {
			handle.dispose();
			ctx.subagentRuntime!.ceilingHandle = null;
		}
	}
	sendResponse(cmd.id, true, { approvalMode: ctx.currentApprovalMode });
}

// ─── cancelSubagent（取消传播 host 出口，issue 05）──────

/**
 * 显式取消一个 subagent run（async runs 不随父会话 turn 中止而取消，
 * 这是异步委派的语义；host 侧用户显式取消经此命令下发）。
 *
 * 通过 pi-subagents RPC 桥（subagents:rpc:v1:request → stop）下发，
 * 回复经 subagents:rpc:v1:reply:<requestId> 通道返回。
 */
export async function handleCancelSubagent(
	cmd: Command & { type: "cancelSubagent" },
	ctx: PiRunnerContext,
): Promise<void> {
	const runtime = ctx.subagentRuntime;
	if (!runtime?.enabled || !runtime.events) {
		throw new Error(`Subagent runtime not available${runtime?.blockedReason ? `: ${runtime.blockedReason}` : ""}`);
	}

	const requestId = `socverify-stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const { envelope, replyChannel } = buildRpcStopRequest(requestId, cmd.target);

	const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error(`Subagent stop request timed out (${requestId})`));
		}, 15_000);
		timeout.unref?.();
		const unsubscribe = runtime.events!.on(replyChannel, (data: unknown) => {
			clearTimeout(timeout);
			unsubscribe();
			if (typeof data === "object" && data !== null) {
				resolve(data as Record<string, unknown>);
			} else {
				reject(new Error("Malformed subagent stop reply"));
			}
		});
		runtime.events!.emit(RPC_REQUEST_CHANNEL, envelope);
	});

	if (reply.success === false) {
		const error = reply.error as { message?: string } | undefined;
		throw new Error(error?.message ?? "Subagent stop request failed");
	}
	sendResponse(cmd.id, true, reply.data ?? { stopped: true });
}

// ─── MCP 查询命令 ───────────────────────────────────────

export function handleGetMcpStatus(cmd: Command & { type: "getMcpStatus" }, ctx: PiRunnerContext): void {
	if (!ctx.mcpRuntime) {
		sendResponse(cmd.id, true, { enabled: false, adapterLoaded: false, configSourcePath: null, servers: {} });
		return;
	}
	sendResponse(cmd.id, true, {
		enabled: true,
		adapterLoaded: ctx.mcpRuntime.adapterLoaded,
		configSourcePath: ctx.mcpRuntime.configSourcePath,
		servers: mapSnapshotToHostStatus(ctx.mcpRuntime),
	});
}

export function handleGetMcpServerTools(
	cmd: Command & { type: "getMcpServerTools" },
	ctx: PiRunnerContext,
): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as AgentSession;
	const allTools = session.getAllTools().map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.parameters,
	}));
	sendResponse(cmd.id, true, {
		serverName: cmd.serverName,
		tools: selectServerToolsFromSession(allTools, cmd.serverName),
	});
}

export function handleReloadMcp(cmd: Command & { type: "reloadMcp" }, ctx: PiRunnerContext): void {
	// adapter 无 in-place reload 出口：显式报告需要重建会话生效（不自动重放 turn）
	void ctx;
	sendResponse(cmd.id, true, { requiresSessionRestart: true });
}

// ─── compact ────────────────────────────────────────────

export async function handleCompact(
	cmd: Command & { type: "compact" },
	ctx: PiRunnerContext,
): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	const result = await (ctx.session as AgentSession).compact();
	sendResponse(cmd.id, true, { result });
}

// ─── destroy ────────────────────────────────────────────

export async function handleDestroy(
	cmd: Command & { type: "destroy" },
	ctx: PiRunnerContext,
): Promise<void> {
	// 活动 async runs 随会话销毁显式取消（fire-and-forget；销毁路径不等待）
	const runtime = ctx.subagentRuntime;
	if (runtime?.enabled && runtime.events) {
		for (const runId of trackSubagentRun.activeRunIds(runtime.registry)) {
			const { envelope } = buildRpcStopRequest(`socverify-destroy-${runId}`, { runId });
			try {
				runtime.events.emit(RPC_REQUEST_CHANNEL, envelope);
			} catch (err) {
				console.error(`[socverify-runner] subagent stop on destroy failed: ${String(err)}`);
			}
		}
	}
	if (ctx.unsubscribe) {
		ctx.unsubscribe();
		ctx.unsubscribe = null;
	}
	if (ctx.session) {
		(ctx.session as AgentSession).dispose();
		ctx.session = null;
	}
	sendResponse(cmd.id, true, { ok: true });
}
