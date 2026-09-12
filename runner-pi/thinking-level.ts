/**
 * host 思考强度设置 → pi 引擎值映射（issue 06）。
 *
 * 值域与主仓库 src/shared/types/thinking-level.ts 对齐（runner 独立编译，
 * 不引 @shared，需手工保持同步）。pi 0.85.1 的 ThinkingLevel 不含 'auto'：
 * 'default' 与 'auto' 都交还引擎默认行为；具体强度原样透传，pi 侧会按
 * 模型声明的思考能力做 clamp。
 */
export type ThinkingLevelSetting =
	| "default"
	| "auto"
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 'default'/'auto'（或缺省）→ undefined（跟随引擎默认），其余值原样透传。 */
export function toPiThinkingLevel(level: ThinkingLevelSetting | undefined): PiThinkingLevel | undefined {
	if (level === undefined) return undefined;
	if (level === "default" || level === "auto") return undefined;
	return level;
}
