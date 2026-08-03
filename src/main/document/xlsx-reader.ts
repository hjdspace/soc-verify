/**
 * xlsx 文件读取工具——处理 officecli 生成的 xlsx 文件命名空间问题。
 *
 * officecli 创建的 xlsx 使用带前缀的命名空间（如 `<x:workbook xmlns:x="...">`），
 * 而 exceljs 的 SAX 解析器期望无前缀的元素名（如 `<workbook xmlns="...">`）。
 * 直接用 exceljs 读取会抛出 `Cannot read properties of undefined (reading 'sheets')`。
 *
 * 本模块先用 exceljs 直接读取；若失败则用 jszip 解压，修正特定文件的命名空间前缀，
 * 再用 exceljs 读取修正后的 Buffer。
 *
 * 修正规则（仅修正 exceljs 期望无前缀的文件）：
 *   - `xl/workbook.xml`、`xl/worksheets/*.xml`：去除 `x:` 前缀
 *   - `docProps/app.xml`：去除 `ap:` 前缀
 *   - `docProps/core.xml`：不修正（CoreXform 期望带 `dc:`/`cp:` 前缀的子元素）
 *   - 其他文件：不修正
 */

import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

/**
 * 从 XML 文本中去除指定前缀的命名空间。
 *
 * 将 `<prefix:tag>` → `<tag>`，`</prefix:tag>` → `</tag>`，
 * `xmlns:prefix=` → `xmlns=`。
 *
 * 只处理元素名和命名空间声明，不影响带前缀的属性（如 `r:id`）。
 */
function stripNamespace(xml: string, prefix: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return xml
    .replace(new RegExp(`xmlns:${escaped}=`, 'g'), 'xmlns=')
    .replace(new RegExp(`<${escaped}:`, 'g'), '<')
    .replace(new RegExp(`</${escaped}:`, 'g'), '</');
}

/**
 * 根据 zip 内文件路径判断需要去除的命名空间前缀。
 *
 * @returns 需要去除的前缀数组；空数组表示不修正
 */
function getPrefixesToStrip(entryName: string): string[] {
  // xl/workbook.xml 和 xl/worksheets/*.xml — 去除 x: 前缀
  if (entryName === 'xl/workbook.xml' || entryName.startsWith('xl/worksheets/')) {
    return ['x'];
  }
  // docProps/app.xml — 去除 ap: 前缀
  if (entryName === 'docProps/app.xml') {
    return ['ap'];
  }
  return [];
}

/**
 * 读取 xlsx 文件并返回 exceljs Workbook。
 *
 * 先尝试直接用 exceljs 读取（大多数 xlsx 文件无需修正）。
 * 若失败（officecli 生成的文件使用命名空间前缀），则用 jszip 解压、
 * 修正命名空间后重新加载。
 *
 * @param filePath xlsx 文件绝对路径
 * @returns exceljs Workbook 实例
 */
export async function readXlsxWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
    return workbook;
  } catch (err) {
    // 检查是否为已知的命名空间问题
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("reading 'sheets'") && !msg.includes("reading 'company'")) {
      throw err;
    }
  }

  // 命名空间修正：用 jszip 读取，修正特定 XML 条目的命名空间前缀
  const fileData = await readFile(filePath);
  const zip = await JSZip.loadAsync(fileData);

  const xmlEntries = Object.keys(zip.files).filter(
    (name) => name.endsWith('.xml') || name.endsWith('.rels'),
  );

  for (const entryName of xmlEntries) {
    const entry = zip.file(entryName);
    if (!entry) continue;
    const prefixes = getPrefixesToStrip(entryName);
    if (prefixes.length === 0) continue;

    let content = await entry.async('string');
    let modified = false;
    for (const prefix of prefixes) {
      const stripped = stripNamespace(content, prefix);
      if (stripped !== content) {
        content = stripped;
        modified = true;
      }
    }
    if (modified) {
      zip.file(entryName, content);
    }
  }

  const fixedBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  const fixedWorkbook = new ExcelJS.Workbook();
  // exceljs 自带的 index.d.ts 第 1 行声明了 `declare interface Buffer extends ArrayBuffer {}`，
  // 该全局声明会与 @types/node@26 的 `Buffer<TArray extends ArrayBufferLike = ArrayBufferLike>`
  // 泛型类发生声明合并，导致 load(buffer: Buffer) 期望的合并类型要求具备 ArrayBuffer 的实例属性
  // （maxByteLength / resizable / resize / detached 等），而 JSZip 返回的 Buffer<ArrayBufferLike>
  // 在类型层面无法满足。运行时 exceljs 完全兼容 Node Buffer，使用 @ts-expect-error 抑制该类型冲突。
  const arrayBuffer = fixedBuffer.buffer.slice(
    fixedBuffer.byteOffset,
    fixedBuffer.byteOffset + fixedBuffer.byteLength,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await fixedWorkbook.xlsx.load(arrayBuffer as any);
  return fixedWorkbook;
}
