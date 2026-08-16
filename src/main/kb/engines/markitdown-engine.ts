/**
 * MarkItDown 兼容引擎 — 纯 TypeScript 实现（无 Python、无原生依赖）。
 *
 * 灵感来自微软开源的 markitdown（github.com/microsoft/markitdown），
 * 按其转换行为用仓库既有纯 JS 依赖重新实现，保证：
 *  - 完全离线可用，跟随应用打包（jszip / xlsx 为 npm 依赖，
 *    pdfjs-dist 打包进 node_modules，无运行时下载）；
 *  - 无重型社区移植依赖（exiftool / ffmpeg / tesseract / 云服务）。
 *
 * 支持格式与转换行为（对齐 markitdown）：
 *  - docx：word/document.xml → 标题/列表/粗斜体/表格 + 内嵌图片抽取
 *  - pptx：ppt/slides/slideN.xml → 逐 Slide 文本 + 备注
 *  - xlsx/xls：SheetJS → 每个 Sheet 一张 Markdown 表格
 *  - csv：RFC4180 解析（引号/换行/逗号）→ Markdown 表格
 *  - pdf：pdfjs-dist 文本层提取（图片型 PDF → unsupported）
 *  - html/htm：标题/列表/表格/文本的基本转换
 *  - txt/md：原样透传；json/xml：代码围栏包裹
 *
 * 不支持（需切换 anydoc 引擎）：.doc/.ppt/.odt/.rtf/.epub
 *
 * @see ADR 0022 — 双转换引擎（anydoc / markitdown）
 */

import { extname } from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import type { ConvertEngine, EngineAsset, EngineResult } from './types';

// ── 通用工具 ─────────────────────────────────────────────────────

/** XML/HTML 实体解码 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // amp 最后解码，避免二次解码
}

/** 字节 → UTF-8 文本（容忍 BOM） */
function decodeUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/** Markdown 表格单元格转义（管道符 / 换行） */
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** 二维字符串数组 → Markdown 表格（首行为表头） */
function rowsToMarkdownTable(rows: string[][]): string {
  const normalized = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (normalized.length === 0) return '';

  const width = Math.max(...normalized.map((r) => r.length));
  const pad = (r: string[]): string[] => {
    const copy = [...r];
    while (copy.length < width) copy.push('');
    return copy;
  };

  const [header, ...body] = normalized.map(pad);
  const lines = [
    `| ${header.map(escapeTableCell).join(' | ')} |`,
    `| ${Array<string>(width).fill('---').join(' | ')} |`,
    ...body.map((r) => `| ${r.map(escapeTableCell).join(' | ')} |`),
  ];
  return lines.join('\n');
}

function unsupported(detail: string): EngineResult {
  return {
    ok: false,
    error: {
      code: 'unsupported',
      message: '不支持的格式或无法转换（可在设置 → 知识库切换转换引擎；扫描版 PDF 无文字层需 OCR，不支持）',
      detail,
    },
  };
}

// ── DOCX ─────────────────────────────────────────────────────────

/** docx 顶层块元素（body 的直接子元素） */
type DocxBlock =
  | { kind: 'p'; xml: string }
  | { kind: 'tbl'; xml: string };

/**
 * 按深度切分 body 的直接子元素。
 * 段落内不会再嵌套段落/表格；表格可嵌套表格，需按 <w:tbl 深度计数。
 */
function splitDocxBody(body: string): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  let i = 0;
  while (i < body.length) {
    // 找下一个 <w:p / <w:tbl（注意排除 <w:pPr、<w:tblPr 等相近标签）
    const pIdx = body.indexOf('<w:p', i);
    const tblIdx = body.indexOf('<w:tbl', i);
    const nextP = pIdx >= 0 && /^[ >/]/.test(body.slice(pIdx + 4, pIdx + 5) ?? '') ? pIdx : -1;
    const nextTbl = tblIdx >= 0 && /^[ >]/.test(body.slice(tblIdx + 6, tblIdx + 7) ?? '') ? tblIdx : -1;

    let start = -1;
    let kind: 'p' | 'tbl' = 'p';
    if (nextP >= 0 && (nextTbl < 0 || nextP < nextTbl)) {
      start = nextP;
      kind = 'p';
    } else if (nextTbl >= 0) {
      start = nextTbl;
      kind = 'tbl';
    } else {
      break;
    }

    if (kind === 'p') {
      const end = body.indexOf('</w:p>', start);
      if (end < 0) break;
      blocks.push({ kind: 'p', xml: body.slice(start, end + 6) });
      i = end + 6;
    } else {
      let depth = 0;
      let cursor = start;
      let end = -1;
      while (cursor < body.length) {
        const open = body.indexOf('<w:tbl', cursor);
        const close = body.indexOf('</w:tbl>', cursor);
        if (close < 0) break;
        if (open >= 0 && open < close && /^[ >]/.test(body.slice(open + 6, open + 7) ?? '')) {
          depth++;
          cursor = open + 6;
        } else {
          depth--;
          cursor = close + 8;
          if (depth === 0) {
            end = close;
            break;
          }
        }
      }
      if (end < 0) break;
      blocks.push({ kind: 'tbl', xml: body.slice(start, end + 8) });
      i = end + 8;
    }
  }
  return blocks;
}

/** 解析 rels：rId → media 目标路径（相对 word/） */
function parseDocxRels(relsXml: string): Map<string, string> {
  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    const id = tag.match(/ Id="([^"]+)"/);
    const target = tag.match(/ Target="([^"]+)"/);
    if (id && target) rels.set(id[1], target[1].replace(/^\.\//, ''));
  }
  return rels;
}

/** 段落文本段（run 级别，携带粗斜体标记） */
type RunSegment = { text: string; bold: boolean; italic: boolean };

/** run 标记解析：w:b / w:i（w:val="0"/"false" 视为关闭） */
function isToggleOn(runXml: string, tag: string): boolean {
  const m = runXml.match(new RegExp(`<${tag}\\b(?:\\s[^>]*)?\\s*/?>`));
  if (!m) return false;
  const val = m[0].match(/ w:val="([^"]*)"/);
  return !val || !['0', 'false', 'off'].includes(val[1].toLowerCase());
}

/** 提取段落内所有 run 的文本段 */
function extractRunSegments(pXml: string): RunSegment[] {
  const segments: RunSegment[] = [];
  const runs = [...pXml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)];
  if (runs.length > 0) {
    for (const run of runs) {
      const runXml = run[1];
      const bold = isToggleOn(runXml, 'w:b');
      const italic = isToggleOn(runXml, 'w:i');
      let text = '';
      for (const t of runXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
        text += decodeEntities(t[1]);
      }
      // tab/br 是 run 级别元素（不在 w:t 内），按出现次数补齐
      text += '\t'.repeat((runXml.match(/<w:tab\b[^>]*\/>/g) ?? []).length);
      text += '\n'.repeat((runXml.match(/<w:br\b[^>]*\/>/g) ?? []).length);
      if (text) segments.push({ text, bold, italic });
    }
    return segments;
  }
  // 无 run 结构（如 hyperlink 直含 w:t）的兜底
  let fallback = '';
  for (const t of pXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
    fallback += decodeEntities(t[1]);
  }
  return fallback ? [{ text: fallback, bold: false, italic: false }] : [];
}

/** 合并相邻同格式段并应用 Markdown 粗斜体 */
function renderRunSegments(segments: RunSegment[]): string {
  const merged: RunSegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && last.bold === seg.bold && last.italic === seg.italic) {
      last.text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged
    .map((seg) => {
      const text = seg.text.trim();
      if (!text) return '';
      let out = text;
      if (seg.bold) out = `**${out}**`;
      if (seg.italic) out = `*${out}*`;
      return out;
    })
    .join('');
}

/** 段落内嵌图片引用（DrawingML a:blip 与 VML v:imagedata 两种） */
function extractImageRIds(pXml: string): string[] {
  const ids: string[] = [];
  for (const m of pXml.matchAll(/<a:blip\b[^>]*\br:embed="([^"]+)"/g)) ids.push(m[1]);
  for (const m of pXml.matchAll(/<v:imagedata\b[^>]*\br:id="([^"]+)"/g)) ids.push(m[1]);
  return ids;
}

/** 渲染单个段落为 Markdown 行（图片占位按引用顺序登记到 assets） */
function renderDocxParagraph(
  pXml: string,
  rels: Map<string, string>,
  media: Map<string, EngineAsset>,
  assets: EngineAsset[],
): string {
  // 图片优先于文本（图片 run 通常不含文本）
  let imageMarkdown = '';
  for (const rId of extractImageRIds(pXml)) {
    const target = rels.get(rId);
    if (!target) continue;
    const asset = media.get(`word/${target}`);
    if (!asset) continue;
    assets.push(asset);
    imageMarkdown += `![](image${assets.length})`;
  }

  const segments = extractRunSegments(pXml);
  const text = renderRunSegments(segments);

  // 标题样式（Word 内置 Heading1..6 / 部分中文文档使用数字 styleId）
  const styleMatch = pXml.match(/<w:pStyle w:val="([^"]+)"/);
  const styleVal = styleMatch?.[1] ?? '';
  const heading = styleVal.match(/^(?:heading[ _-]?([1-6])|[1-6])$/i);

  // 列表（numPr 存在即视为列表项；ilvl 控制缩进层级）
  const isListItem = /<w:numPr\b/.test(pXml);
  const ilvl = Number(pXml.match(/<w:ilvl w:val="(\d+)"/)?.[1] ?? '0');

  if (heading) {
    return `${'#'.repeat(Number(heading[1]))} ${text}`.trim();
  }
  if (isListItem) {
    return `${'  '.repeat(ilvl)}- ${text}`.trimEnd();
  }
  if (imageMarkdown) {
    return imageMarkdown + (text ? ` ${text}` : '');
  }
  return text;
}

/** 按深度切分表格的行（w:tr 可含嵌套表格的行） */
function splitDocxTableRows(tblXml: string): string[] {
  const rows: string[] = [];
  let cursor = 0;
  while (cursor < tblXml.length) {
    const open = tblXml.indexOf('<w:tr', cursor);
    const close = tblXml.indexOf('</w:tr>', cursor);
    if (open < 0 || close < 0) break;
    if (/^[ >]/.test(tblXml.slice(open + 5, open + 6) ?? '')) {
      rows.push(tblXml.slice(open, close + 7));
    }
    cursor = close + 7;
  }
  return rows;
}

/** 渲染表格为 Markdown（单元格取全部 w:t 文本） */
function renderDocxTable(tblXml: string): string {
  const rows = splitDocxTableRows(tblXml).map((rowXml) => {
    const cells: string[] = [];
    let cursor = 0;
    while (cursor < rowXml.length) {
      const open = rowXml.indexOf('<w:tc', cursor);
      const close = rowXml.indexOf('</w:tc>', cursor);
      if (open < 0 || close < 0) break;
      if (/^[ >]/.test(rowXml.slice(open + 5, open + 6) ?? '')) {
        let cell = '';
        for (const t of rowXml.slice(open, close).matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
          cell += decodeEntities(t[1]);
        }
        cells.push(cell);
      }
      cursor = close + 7;
    }
    return cells;
  });
  return rowsToMarkdownTable(rows);
}

async function convertDocx(bytes: Uint8Array): Promise<EngineResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (e) {
    return {
      ok: false,
      error: { code: 'malformed', message: '文档结构损坏，无法提取有效内容', detail: (e as Error).message },
    };
  }

  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    return {
      ok: false,
      error: { code: 'missingPart', message: '文档缺少部件，无法完整转换', detail: 'docx 缺少 word/document.xml' },
    };
  }

  const xml = await docFile.async('string');
  const relsXml = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '';
  const rels = parseDocxRels(relsXml);

  // 预加载全部内嵌图片字节
  const media = new Map<string, EngineAsset>();
  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith('word/media/')) continue;
    const ext = (extname(path).slice(1) || 'bin').toLowerCase();
    media.set(path, { ext, data: new Uint8Array(await zip.files[path].async('arraybuffer')) });
  }

  const bodyMatch = xml.match(/<w:body>([\s\S]*)<\/w:body>/);
  const body = bodyMatch ? bodyMatch[1] : xml;

  const assets: EngineAsset[] = [];
  const output: string[] = [];
  for (const block of splitDocxBody(body)) {
    if (block.kind === 'tbl') {
      const table = renderDocxTable(block.xml);
      if (table) output.push(table);
    } else {
      const line = renderDocxParagraph(block.xml, rels, media, assets);
      if (line.trim()) output.push(line);
    }
  }

  return { ok: true, output: { markdown: output.join('\n\n'), assets } };
}

// ── PPTX ─────────────────────────────────────────────────────────

/** 提取一页 slide/notes XML 中的全部文本（按 a:p 分行） */
function extractPptxText(xml: string): string {
  const paragraphs = xml.split(/<\/a:p>/).map((p) => {
    let text = '';
    for (const t of p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) {
      text += decodeEntities(t[1]);
    }
    return text;
  });
  return paragraphs.filter((t) => t.trim() !== '').join('\n');
}

async function convertPptx(bytes: Uint8Array): Promise<EngineResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (e) {
    return {
      ok: false,
      error: { code: 'malformed', message: '文档结构损坏，无法提取有效内容', detail: (e as Error).message },
    };
  }

  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? '0');
      const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? '0');
      return na - nb;
    });
  if (slidePaths.length === 0) {
    return {
      ok: false,
      error: { code: 'missingPart', message: '文档缺少部件，无法完整转换', detail: 'pptx 缺少 ppt/slides/slideN.xml' },
    };
  }

  const output: string[] = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const slideXml = await zip.file(slidePaths[i])!.async('string');
    const text = extractPptxText(slideXml);
    output.push(`<!-- Slide number: ${i + 1} -->`);
    if (text) output.push(text);

    const notesPath = `ppt/notesSlides/notesSlide${i + 1}.xml`;
    const notesFile = zip.file(notesPath);
    if (notesFile) {
      const notes = extractPptxText(await notesFile.async('string'));
      if (notes) {
        output.push('### Notes:');
        output.push(notes);
      }
    }
  }

  return { ok: true, output: { markdown: output.join('\n\n'), assets: [] } };
}

// ── XLSX / XLS / CSV ─────────────────────────────────────────────

function convertSpreadsheet(bytes: Uint8Array): EngineResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(Buffer.from(bytes), { type: 'buffer' });
  } catch (e) {
    return {
      ok: false,
      error: { code: 'malformed', message: '文档结构损坏，无法提取有效内容', detail: (e as Error).message },
    };
  }

  const output: string[] = [];
  for (const name of workbook.SheetNames) {
    output.push(`<!-- Sheet name: ${name} -->`);
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
    const table = rowsToMarkdownTable(rows.map((r) => r.map((c) => String(c))));
    output.push(table || '*（空工作表）*');
  }

  return { ok: true, output: { markdown: output.join('\n\n'), assets: [] } };
}

/** RFC4180 CSV 解析（引号转义 / 字段内换行） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // CRLF 由 \n 统一处理
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function convertCsv(text: string): EngineResult {
  const table = rowsToMarkdownTable(parseCsv(text));
  if (!table) {
    return unsupported('CSV 无有效数据行');
  }
  return { ok: true, output: { markdown: table, assets: [] } };
}

// ── PDF ──────────────────────────────────────────────────────────

async function convertPdf(bytes: Uint8Array): Promise<EngineResult> {
  // pdfjs-dist legacy 构建支持 Node；外置依赖（electron-vite external），
  // 动态导入避免主进程打包时内联 ESM 产物。
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  try {
    const doc = await pdfjs.getDocument({
      // pdfjs 会 transfer/detach 传入的缓冲区，拷贝一份避免影响调用方
      data: bytes.slice(),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;

    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      pages.push(text);
      page.cleanup();
    }
    await doc.destroy();

    const markdown = pages.join('\n\n').trim();
    if (!markdown) {
      return unsupported('PDF 无文字层（图片型/扫描版需 OCR，不支持）');
    }
    return { ok: true, output: { markdown, assets: [] } };
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'PasswordException') {
      return {
        ok: false,
        error: { code: 'encrypted', message: '文档已加密或受密码保护', detail: String((e as Error).message ?? e) },
      };
    }
    return {
      ok: false,
      error: { code: 'malformed', message: '文档结构损坏，无法提取有效内容', detail: String((e as Error).message ?? e) },
    };
  }
}

// ── HTML / TXT / JSON / XML ──────────────────────────────────────

/** 去标签后的行内文本（保留粗体/斜体标记可选，这里仅取文本） */
function htmlInlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function convertHtml(html: string): EngineResult {
  let s = html;
  // 注释与不可见区块
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|head|nav|footer|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // 表格 → Markdown 表格（在行级替换前处理）
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, inner: string) => {
    const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((rowMatch) =>
      [...rowMatch[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => htmlInlineText(cell[1])),
    );
    return `\n\n${rowsToMarkdownTable(rows)}\n\n`;
  });

  // 标题
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, txt: string) =>
    `\n\n${'#'.repeat(Number(lvl))} ${htmlInlineText(txt)}\n\n`);

  // 列表项
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, txt: string) => `\n- ${htmlInlineText(txt)}`);

  // 换行
  s = s.replace(/<br\s*\/?>/gi, '\n');

  // 块级标签边界 → 空行
  s = s.replace(/<\/(p|div|section|article|header|main|ul|ol|table|blockquote|pre|h[1-6])>/gi, '\n\n');

  // 剩余标签全部去除
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);

  // 压缩空白
  const markdown = s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  if (!markdown) {
    return unsupported('HTML 无可提取文本');
  }
  return { ok: true, output: { markdown, assets: [] } };
}

// ── 引擎实现 ─────────────────────────────────────────────────────

export const markitdownEngine: ConvertEngine = {
  id: 'markitdown',
  label: 'MarkItDown 兼容（纯 JS）',
  description: '内置 MarkItDown 兼容实现：docx/pptx/xlsx/csv/pdf/html，纯本地转换、完全离线；不支持 doc/ppt/odt/rtf/epub 旧格式。',
  supportedExtensions: [
    '.docx', '.pptx', '.xlsx', '.xls', '.csv',
    '.pdf', '.html', '.htm', '.txt', '.md', '.json', '.xml',
  ],

  async convert(bytes: Uint8Array, sourcePath: string): Promise<EngineResult> {
    const ext = extname(sourcePath).toLowerCase();

    try {
      switch (ext) {
        case '.docx':
          return await convertDocx(bytes);
        case '.pptx':
          return await convertPptx(bytes);
        case '.xlsx':
        case '.xls':
          return convertSpreadsheet(bytes);
        case '.csv':
          return convertCsv(decodeUtf8(bytes));
        case '.pdf':
          return await convertPdf(bytes);
        case '.html':
        case '.htm':
          return convertHtml(decodeUtf8(bytes));
        case '.txt':
        case '.md':
          return { ok: true, output: { markdown: decodeUtf8(bytes), assets: [] } };
        case '.json':
          return { ok: true, output: { markdown: `\`\`\`json\n${decodeUtf8(bytes).trim()}\n\`\`\``, assets: [] } };
        case '.xml':
          return { ok: true, output: { markdown: `\`\`\`xml\n${decodeUtf8(bytes).trim()}\n\`\`\``, assets: [] } };
        default:
          return unsupported(`markitdown 引擎不支持：${ext || '无扩展名'}（可在设置中切换 anydoc 引擎）`);
      }
    } catch (e) {
      return {
        ok: false,
        error: { code: 'io', message: '文件读取失败', detail: String((e as Error).message ?? e) },
      };
    }
  },
};
