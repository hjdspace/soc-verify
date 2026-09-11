/**
 * skill 装载装配（issue 09）—— host 下发 skillPaths → DefaultResourceLoader 选项。
 *
 * 纯逻辑、不导入 pi SDK，保持可单元测试。skill 的发现与同名解析优先级
 * 全部在 host 侧（src/main/agent/skill-discovery.ts 的
 * resolveSkillLoadPaths）完成；runner 不自行发现，保证"UI 列表里看到的"
 * 就是"会话实际加载的"（issue 09 验收：来源确定性）。
 *
 * skillPaths 非空时以 noSkills + additionalSkillPaths 装载：
 *   - 关闭 pi 默认发现（<cwd>/.pi/skills + <agentDir>/skills），避免与
 *     host 列表产生隐式第二来源；
 *   - loadSkills 对 skillPaths 按顺序 first-wins 去重，host 的顺序
 *     （见 getSkillRootDirs）即解析结果。
 *
 * skillPaths 缺省/为空时返回空配置，保持 pi 默认行为。安全网语义：host
 * 列表为空意味着 homedir/project 两侧技能目录都不存在，pi 默认发现同样
 * 加载空集 —— 两种路径等价；保留回退是为 runner agentDir 与 host homedir
 * 推导分叉时（如未来引入 PI_CODING_AGENT_DIR）不静默清空技能面。
 */

import type { InitConfig } from "./protocol";

export type SkillLoaderOptions = {
	noSkills?: boolean;
	additionalSkillPaths?: string[];
};

export function buildSkillLoaderOptions(config: Pick<InitConfig, "skillPaths">): SkillLoaderOptions {
	const skillPaths = config.skillPaths ?? [];
	if (skillPaths.length === 0) return {};
	return { noSkills: true, additionalSkillPaths: [...skillPaths] };
}
