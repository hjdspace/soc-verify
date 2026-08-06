import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { TEXT, defineTool, type HostToolEntry, type ToolContext } from './shared';

// ── 辅助函数 ─────────────────────────────────────────────

/** 转义正则特殊字符，用于安全构造模块名匹配正则。 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 递归扫描目录下的 Verilog/SystemVerilog 源文件（.v/.sv/.svh）。
 * 限制深度并跳过隐藏目录与 node_modules，避免遍历过深。
 */
async function findRtlFiles(dir: string, maxDepth = 4): Promise<string[]> {
  const results: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        await walk(join(current, entry.name), depth + 1);
      } else if (entry.isFile() && /\.(sv|v|svh)$/.test(entry.name)) {
        results.push(join(current, entry.name));
      }
    }
  };
  await walk(dir, 0);
  return results;
}

/**
 * AI 上下文工具（ADR 0009 决策 6）：
 * get_module_source / get_test_template
 *
 * 仅在传入 discovery 时注册。
 */
export function createContextTools(ctx: ToolContext): HostToolEntry[] {
  return [
    defineTool(
      'get_module_source',
      'Get RTL source code for a specific module. Returns file path and line range. Used by AI to understand module implementation for coverage gap analysis.',
      {
        type: 'object',
        properties: {
          module: { type: 'string', description: 'Module name or path (e.g. "top/cpu_core")' },
          maxLines: { type: 'number', description: 'Max lines to return (default 500)' },
        },
        required: ['module'],
        additionalProperties: false,
      },
      async (args) => {
        const moduleInput = typeof args.module === 'string' ? args.module : '';
        if (!moduleInput) {
          return TEXT(JSON.stringify({ error: 'module is required' }));
        }
        const moduleName = moduleInput.split('/').pop() ?? moduleInput;
        const maxLines = typeof args.maxLines === 'number' ? args.maxLines : 500;
        try {
          const files = await findRtlFiles(ctx.cwd);
          const regex = new RegExp(`\\bmodule\\s+${escapeRegex(moduleName)}\\b`);
          for (const file of files) {
            const content = await readFile(file, 'utf-8');
            const match = content.match(regex);
            if (match && match.index !== undefined) {
              const lines = content.split('\n');
              let lineStart = 1;
              let consumed = 0;
              for (let i = 0; i < lines.length; i++) {
                if (consumed + lines[i].length + 1 > match.index) {
                  lineStart = i + 1;
                  break;
                }
                consumed += lines[i].length + 1;
              }
              const sliced = lines.slice(lineStart - 1, lineStart - 1 + maxLines);
              return TEXT(JSON.stringify({
                module: moduleName,
                file,
                lineStart,
                lineEnd: lineStart + sliced.length - 1,
                source: sliced.join('\n'),
              }));
            }
          }
          return TEXT(JSON.stringify({ error: `Module ${moduleName} not found in project sources` }));
        } catch (err) {
          return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    ),

    defineTool(
      'get_test_template',
      'Get the structure of an existing test case (testbench framework, virtual sequence pattern, env config). AI uses this as a template to generate new tests with consistent style.',
      {
        type: 'object',
        properties: {
          testcase: { type: 'string', description: 'Existing testcase name to use as template' },
          subsys: { type: 'string', description: 'Subsystem name' },
        },
        required: ['testcase'],
        additionalProperties: false,
      },
      async (args) => {
        const testcase = typeof args.testcase === 'string' ? args.testcase : '';
        if (!testcase) {
          return TEXT(JSON.stringify({ error: 'testcase is required' }));
        }
        const subsys = typeof args.subsys === 'string' ? args.subsys : undefined;
        try {
          const cases = await ctx.discovery.listCases(subsys);
          const matched = cases.find((c) => c.name === testcase || c.id === testcase);
          if (!matched) {
            return TEXT(JSON.stringify({ error: `Testcase ${testcase} not found` }));
          }
          const filePath = matched.path;
          if (!filePath) {
            return TEXT(JSON.stringify({ error: `Testcase ${testcase} has no file path` }));
          }
          const resolvedPath = isAbsolute(filePath) ? filePath : resolve(ctx.cwd, filePath);
          const content = await readFile(resolvedPath, 'utf-8');
          return TEXT(JSON.stringify({
            testcase: matched.name,
            file: resolvedPath,
            content,
          }));
        } catch (err) {
          return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    ),
  ];
}
