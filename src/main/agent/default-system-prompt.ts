/**
 * omp 引擎默认系统提示词模板。
 *
 * 使用 Vite 的 `?raw` import 在**构建时**将模板文件内容嵌入到输出中，
 * 因此在开发模式和打包二进制模式下都能访问（不依赖运行时文件系统）。
 *
 * 模板来源：engine/oh-my-pi/packages/coding-agent/src/prompts/system/
 */

import mainPrompt from '../../../engine/oh-my-pi/packages/coding-agent/src/prompts/system/system-prompt.md?raw';
import personalityPrompt from '../../../engine/oh-my-pi/packages/coding-agent/src/prompts/system/personalities/default.md?raw';

/** 主系统提示词模板（system-prompt.md），含 Handlebars 动态片段。 */
export const DEFAULT_SYSTEM_PROMPT: string = mainPrompt;

/** 默认个性模板（personalities/default.md），注入到主模板的 <personality> 块。 */
export const DEFAULT_PERSONALITY: string = personalityPrompt;

/**
 * 返回合并后的默认系统提示词（主模板 + 个性模板），用分隔线隔开。
 * 用于设置页面只读展示。
 */
export function getCombinedDefaultSystemPrompt(): string {
  const sections: string[] = [];

  if (mainPrompt) {
    sections.push(
      '<!-- 主系统提示词模板（system-prompt.md）— 含 Handlebars 动态片段，实际内容随工具/技能/规则变化 -->\n' +
      mainPrompt,
    );
  }

  if (personalityPrompt) {
    sections.push(
      '<!-- 默认个性（personalities/default.md）— 注入到主模板的 <personality> 块 -->\n' +
      personalityPrompt,
    );
  }

  return sections.join('\n\n---\n\n');
}
