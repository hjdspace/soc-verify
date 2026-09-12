/**
 * SoC Verify 应用规则附加层（issue 06：Effective System Prompt 组合）。
 *
 * Effective System Prompt = pi 基础提示词（base prompt，由
 * DefaultResourceLoader 提供）→ 用户自定义提示词（可选）→ SoC Verify
 * 应用规则。
 *
 * 通过 DefaultResourceLoader 的 appendSystemPrompt 选项注入，保持 pi
 * 基础提示词的完整性（不做整体替换）。
 */

/** SoC Verify 应用规则：追加到 pi 默认系统提示词末尾。 */
export const SOCVERIFY_APPEND_SYSTEM_PROMPT = [
	"## 文件编辑规则",
	"- 修改已有文件时，**必须**优先使用 `edit` 工具（而非 `write`），以便用户可以逐一审查修改差异",
	"- 仅在创建全新文件时才使用 `write` 工具",
	"- `write` 会覆盖整个文件，导致 diff 全部显示为新增（绿色），无法逐项确认修改",
].join("\n");

/**
 * 组装 DefaultResourceLoader.appendSystemPrompt 数组。
 * 用户自定义提示词在前（更贴近 pi 默认 prompt），应用规则在后（最终约束）。
 * 空白字符串视为未提供。
 */
export function buildAppendSystemPrompt(userSystemPrompt?: string): string[] {
	const trimmed = typeof userSystemPrompt === "string" ? userSystemPrompt.trim() : "";
	const parts: string[] = [SOCVERIFY_APPEND_SYSTEM_PROMPT];
	if (trimmed) {
		parts.unshift(trimmed);
	}
	return parts;
}
