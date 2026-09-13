/**
 * KB 写入守卫 — 应用受控写入入口的只读强制（spec §2）。
 *
 * 「知识库预览与通用文件编辑器识别受管 Wiki 页面并只读；应用受控
 * 写入入口不得绕过 KB 发布服务。」本模块挂在通用写路径
 * （projectManager.writeFile → FileEditor 保存）上：
 *
 *  - 挂载 wiki 布局库时，`<kb>/wiki/**`、`schema.md`、`purpose.md`
 *    的直接写入一律拒绝；
 *  - schema/purpose 的合法修改走规则编辑器（kb.saveWikiRules，
 *    内含受约束表校验与重映射拒绝）；
 *  - 知识页的合法写入走后继发布服务（issue 05/06）。
 *
 * 不承诺操作系统级防写：外部进程仍可能改磁盘，
 * 发布前由受控入口检测文件哈希变化。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §2
 */

import { realpath } from 'node:fs/promises';
import { kbRegistry } from './registry';
import { isManagedWikiPath } from '@shared/kb-wiki-guard';

export class ManagedWikiReadOnlyError extends Error {
  constructor(kbPath: string, filePath: string) {
    super(
      `受管 Wiki 页面只读，禁止直接写入: ${filePath}\n`
      + `（挂载的知识库 ${kbPath}）知识页由审阅/发布流程写入；`
      + 'schema.md 与 purpose.md 请在知识库的「写作规则」编辑器中修改。',
    );
    this.name = 'ManagedWikiReadOnlyError';
  }
}

/**
 * 校验 filePath 不落入挂载 wiki 库的受管只读范围；命中则抛
 * ManagedWikiReadOnlyError（未挂载或非 wiki 布局时放行）。
 *
 * 两层判定：
 *  1. 词法前缀（isManagedWikiPath）；
 *  2. realpath 围栏——文件已存在时解析真实路径，确认仍在挂载根的
 *     wiki/（或 schema/purpose）之下，防 junction/symlink 从库外指入
 *     受管范围被前缀匹配漏判。文件不存在（新建）时词法判定即可。
 */
export async function assertNotManagedWikiFile(projectRootPath: string, filePath: string): Promise<void> {
  const kbPath = await kbRegistry.getMountedWikiPath(projectRootPath);
  if (kbPath === null) return;

  if (isManagedWikiPath(kbPath, filePath)) {
    throw new ManagedWikiReadOnlyError(kbPath, filePath);
  }

  let realFile: string;
  try {
    realFile = await realpath(filePath);
  } catch {
    return; // 目标不存在/不可解析：新建文件无法经由已存在的 junction 指入
  }
  if (isManagedWikiPath(kbPath, realFile)) {
    throw new ManagedWikiReadOnlyError(kbPath, filePath);
  }
}
