/**
 * Error analysis prompt templates.
 *
 * Externalized from ErrorAnalysisCoordinator so prompts can be
 * reviewed and modified independently of session logic.
 */

import type { ErrorType } from '@shared/types';

const COMPILE_ERROR_SYSTEM_PROMPT = `You are an EDA verification expert specializing in SystemVerilog and hardware verification.

Your task:
1. Analyze the compilation errors provided in the context
2. Identify the root cause of each error
3. Fix the source code files by editing them directly
4. After fixing, call the runsim_retry tool to re-run the simulation and verify the fix

Important guidelines:
- Focus on fixing the actual compilation errors, not style issues
- Preserve the original intent of the code
- If multiple files need fixing, fix them all before re-running
- Use the runsim_retry tool with the case name and working directory provided`;

const SIM_ERROR_SYSTEM_PROMPT = `You are an EDA verification expert specializing in SystemVerilog and UVM methodology.

Your task:
1. Analyze the simulation errors provided in the context
2. Identify the root cause of each error (UVM_ERROR, UVM_FATAL, assertion failures, etc.)
3. Provide specific fix recommendations with code snippets

Important guidelines:
- Do NOT modify any files in this session — only provide analysis and recommendations
- Explain WHY the error occurs, not just WHAT to change
- Provide code snippets showing the recommended fix
- If the error is a testbench issue, suggest specific changes
- If the error is a DUT issue, describe what might be wrong in the design`;

export function getSystemPrompt(errorType: ErrorType): string {
  return errorType === 'compile_error'
    ? COMPILE_ERROR_SYSTEM_PROMPT
    : SIM_ERROR_SYSTEM_PROMPT;
}

export function buildPromptMessage(params: {
  caseName: string;
  errorType: ErrorType;
  errorContext: string;
  command?: string;
  maxRetries: number;
}): string {
  const { caseName, errorType, errorContext, command, maxRetries } = params;

  const parts: string[] = [
    `## 仿真失败错误分析请求`,
    ``,
    `**用例名称**: ${caseName}`,
  ];

  if (command) {
    parts.push(`**执行命令**: \`${command}\``);
  }

  parts.push(
    `**错误类型**: ${errorType === 'compile_error' ? '编译错误' : '仿真错误'}`,
    ``,
    `### 错误上下文`,
    ``,
    '```',
    errorContext,
    '```',
    ``,
  );

  if (errorType === 'compile_error') {
    parts.push(
      `请分析上述编译错误，修复源代码文件，然后调用 runsim_retry 工具重新运行仿真验证修复效果。`,
      `如果修复后仍有编译错误，继续修复直到编译通过。`,
      `最多重试 ${maxRetries} 次。`,
    );
  } else {
    parts.push(
      `请分析上述仿真错误，给出详细的修复建议。`,
      `包括：错误原因分析、推荐修复方案、相关代码片段。`,
      `注意：本会话仅提供分析建议，不需要修改文件。`,
    );
  }

  return parts.join('\n');
}
