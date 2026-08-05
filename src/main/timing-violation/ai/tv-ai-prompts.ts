/**
 * TV AI Advisor — Prompt 模板
 *
 * System prompt 和用户消息模板，供 TVAIAdvisor 创建 AI Agent 会话时使用。
 * 参考 error-analysis-prompts.ts 的设计模式。
 */

export const TV_AI_SYSTEM_PROMPT = `You are a timing violation analysis expert specializing in SoC post-silicon verification.

Your task:
1. Analyze timing violations based on the provided context (violation details, historical patterns, and statistics)
2. Provide a confirmation suggestion for each violation
3. Return your analysis as a JSON object

You have access to tools that can query the timing violation database for additional context. Use them when you need more information about similar violations or historical confirmation patterns.

Your response MUST be a valid JSON object with the following structure:
\`\`\`json
{
  "confirmer": "建议的确认人名称（如'时序专家'、'设计工程师'等）",
  "result": "pass 或 issue",
  "reason": "详细的判断理由，包括技术分析",
  "confidence": 0.0到1.0之间的置信度,
  "analysis": "可选的额外分析说明"
}
\`\`\`

Guidelines for determining result:
- "pass": The violation is expected behavior, reset period noise, or a known false positive. Common scenarios:
  - Violation time is within the reset period (time_fs <= reset_time_ns * 1000000)
  - The same hierarchy/check has been previously confirmed as pass
  - The violation is on a path that is not timing-critical
- "issue": The violation may indicate a real timing problem that needs investigation. Common scenarios:
  - Violation time is significantly outside the reset period
  - The hierarchy has not been previously confirmed
  - The check type suggests a setup/hold violation on a critical path

Guidelines for confidence:
- 0.9-1.0: Strong historical pattern match (exact hier + check match) or clearly within reset period
- 0.7-0.9: Fuzzy pattern match or strong contextual evidence
- 0.5-0.7: Some contextual evidence but uncertainty remains
- 0.0-0.5: Little to no evidence, mostly guessing

Always respond in Chinese for the confirmer, reason, and analysis fields.`;

/**
 * 构建用户消息（包含违例上下文）。
 */
export function buildSuggestPrompt(params: {
  violation: {
    id: number;
    caseName: string;
    corner: string | null;
    seed: string | null;
    subsys: string | null;
    num: number;
    hier: string;
    timeFs: number;
    timeDisplay: string;
    checkInfo: string;
    filePath: string;
  };
  patterns: Array<{
    hierPattern: string;
    checkPattern: string;
    defaultConfirmer: string | null;
    defaultResult: string | null;
    defaultReason: string | null;
    matchCount: number;
  }>;
  stats: {
    totalByHier: number;
    confirmedByHier: number;
    passCount: number;
    issueCount: number;
  };
  config: {
    defaultResetTimeNs: number;
  };
}): string {
  const { violation, patterns, stats, config } = params;

  const resetTimeFs = config.defaultResetTimeNs * 1_000_000;
  const isWithinReset = violation.timeFs <= resetTimeFs;

  const parts: string[] = [
    `## 时序违例确认建议请求`,
    ``,
    `### 违例详情`,
    ``,
    `- **ID**: ${violation.id}`,
    `- **用例**: ${violation.caseName}`,
    `- **Corner**: ${violation.corner ?? 'N/A'}`,
    `- **Seed**: ${violation.seed ?? 'N/A'}`,
    `- **子系统**: ${violation.subsys ?? 'N/A'}`,
    `- **NUM**: ${violation.num}`,
    `- **层级路径 (Hier)**: \`${violation.hier}\``,
    `- **违例时间**: ${violation.timeDisplay} (${violation.timeFs} fs)`,
    `- **检查信息 (Check)**: \`${violation.checkInfo}\``,
    `- **源文件**: ${violation.filePath}`,
    `- **是否在复位期间内**: ${isWithinReset ? '是' : '否'}（复位时间阈值: ${config.defaultResetTimeNs}ns = ${resetTimeFs}fs）`,
    ``,
  ];

  if (patterns.length > 0) {
    parts.push(`### 历史确认模式（同 Hier 路径）`, ``);
    for (const p of patterns) {
      parts.push(
        `- **Pattern**: hier=\`${p.hierPattern}\`, check=\`${p.checkPattern}\``,
        `  - 确认人: ${p.defaultConfirmer ?? 'N/A'}`,
        `  - 结果: ${p.defaultResult ?? 'N/A'}`,
        `  - 理由: ${p.defaultReason ?? 'N/A'}`,
        `  - 匹配次数: ${p.matchCount}`,
        ``,
      );
    }
  } else {
    parts.push(`### 历史确认模式`, ``, `暂无同 Hier 路径的历史确认记录。`, ``);
  }

  parts.push(
    `### 统计信息`,
    ``,
    `- 同 Hier 路径违例总数: ${stats.totalByHier}`,
    `- 已确认数: ${stats.confirmedByHier}`,
    `- 已确认 Pass 数: ${stats.passCount}`,
    `- 已确认 Issue 数: ${stats.issueCount}`,
    ``,
    `### 请求`,
    ``,
    `请基于以上信息，为这条时序违例提供确认建议。`,
    `你可以使用工具查询更多相关信息（如查询相似违例、查询统计信息等）。`,
    `最终请返回 JSON 格式的建议，包含 confirmer、result、reason、confidence 字段。`,
  );

  return parts.join('\n');
}
