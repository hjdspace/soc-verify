/**
 * Knowledge Base Scanner — 挂载后自动扫描入库的域行为。
 *
 * KB Mount 成功后自动扫描入库是领域行为（CONTEXT.md 有明确语义）：
 * sources/ 中未转换的 + 库根目录散落的文档自动触发上传流水线。
 * 此前这段逻辑内联在 kb-router.ts 的 adapter 层（~65 行），
 * 现抽出为独立模块，router.mount 只剩「挂载 → 触发扫描 → 返回」三行编排。
 *
 * 文档发现逻辑由 layout 模块单一拥有。
 * 支持的扩展名跟随当前生效的转换引擎。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { readdir, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { kbLayout, docNameFromFileName } from './layout';
import { getActiveConvertEngine } from './engines';
import { uploadDocument, type StatusNotifier } from './pipeline';
import { resolveKbLlmConfig, type LlmConfig } from './llm-config';

/**
 * 扫描知识库目录下的文档文件，自动触发上传流水线。
 *
 * 策略：
 *  1. 扫描 sources/ 目录中已有的文档文件（已上传但可能未转换）
 *  2. 扫描库根目录下（非 sources/、docs/）的文档文件
 *
 * 对于 sources/ 中已有但 docs/ 中无对应 .md 的文件，自动触发上传流水线。
 * 对于库根目录下的文档文件，复制到 sources/ 后触发上传流水线。
 *
 * 异步执行上传，不阻塞 scan 调用方。
 *
 * @param kbPath 知识库根目录
 * @param notify 状态变化通知回调
 * @returns 待上传文档数量
 */
export async function autoScanDocuments(
  kbPath: string,
  notify: StatusNotifier,
): Promise<{ scanned: number }> {
  const layout = kbLayout(kbPath);
  const supportedExtensions = (await getActiveConvertEngine()).supportedExtensions;
  const toUpload: string[] = [];

  // 1. 扫描 sources/ 中已有文档
  const sourceFiles = await layout.listSourceFiles();
  for (const fileName of sourceFiles) {
    const ext = fileName.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
    if (!supportedExtensions.includes(ext)) continue;

    const docName = docNameFromFileName(fileName);
    // 检查 docs/ 中是否已有对应的 .md（使用 layout 的文档发现操作）
    const foundMd = await layout.findMarkdown(docName);
    if (foundMd) continue;

    toUpload.push(layout.sourcePath(fileName));
  }

  // 2. 扫描库根目录下的文档文件（非 sources/、docs/）
  try {
    const entries = await readdir(kbPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // 知识库自身的索引文件不可作为文档自吞（markitdown 引擎支持 .md）
      if (entry.name.toLowerCase() === 'index.md') continue;
      const ext = entry.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
      if (!supportedExtensions.includes(ext)) continue;

      const srcPath = join(kbPath, entry.name);
      // 复制到 sources/ 后上传
      if (!existsSync(layout.sourcesDir)) {
        await mkdir(layout.sourcesDir, { recursive: true });
      }
      const destPath = layout.sourcePath(entry.name);
      if (!existsSync(destPath)) {
        await copyFile(srcPath, destPath);
      }
      toUpload.push(destPath);
    }
  } catch {
    // ignore
  }

  // 3. 异步上传所有待处理文档
  if (toUpload.length > 0) {
    const llmConfig: LlmConfig | null = await resolveKbLlmConfig();
    // 异步执行，不等待
    void (async () => {
      for (const filePath of toUpload) {
        try {
          await uploadDocument(filePath, kbPath, llmConfig, notify);
        } catch {
          // 单个文件失败不阻塞其他文件
        }
      }
    })();
  }

  return { scanned: toUpload.length };
}
