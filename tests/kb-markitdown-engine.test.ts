/**
 * markitdown 引擎测试 — 纯 TS 实现的格式转换。
 *
 * fixture 全部在测试内构造（jszip 造 OOXML、SheetJS 造 xlsx、
 * 手工字节拼最小 PDF），验证 Markdown 产物与图片抽取。
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { markitdownEngine } from '../src/main/kb/engines/markitdown-engine';

/** 构造最小 PDF（单页 + 一行文本） */
function makeMinimalPdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objs) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${offsets.length} 0 obj\n${obj}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'binary'));
}

const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
]);

/** 构造最小 docx（标题 + 粗体段落 + 表格 + 内嵌图片） */
async function makeDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>'
    + '</Relationships>',
  );
  const documentXml = [
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<w:body>',
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>验证计划</w:t></w:r></w:p>',
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>关键</w:t></w:r><w:r><w:t>检查点覆盖</w:t></w:r></w:p>',
    '<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId8"/></w:drawing></w:r></w:p>',
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>模块</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>状态</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>AXI</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>PASS</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    '</w:body></w:document>',
  ].join('');
  zip.file('word/document.xml', documentXml);
  zip.file('word/media/image1.png', TINY_PNG);
  return new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }));
}

/** 构造最小 pptx（两页 slide，第二页带备注） */
async function makePptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  const slide = (texts: string[]) =>
    '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<p:cSld><p:spTree><p:sp><p:txBody>'
    + texts.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')
    + '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
  zip.file('ppt/slides/slide1.xml', slide(['UVM 环境搭建', 'Agent 与 Driver']));
  zip.file('ppt/slides/slide2.xml', slide(['断言覆盖率']));
  zip.file(
    'ppt/notesSlides/notesSlide2.xml',
    slide(['备注：关注 FIFO 深度']),
  );
  return new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }));
}

function makeXlsx(): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['模块', '通过'], ['寄存器', 12]]);
  XLSX.utils.book_append_sheet(wb, ws, '回归结果');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

describe('markitdown-engine', () => {
  it('docx：标题/粗体/表格 + 内嵌图片抽取（assets 按引用顺序）', async () => {
    const result = await markitdownEngine.convert(await makeDocx(), '验证计划.docx');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');

    expect(result.output.markdown).toContain('# 验证计划');
    expect(result.output.markdown).toContain('**关键**检查点覆盖');
    expect(result.output.markdown).toContain('| 模块 | 状态 |');
    expect(result.output.markdown).toContain('| AXI | PASS |');
    // 图片占位（converter 层负责替换为 assets/ 相对路径）
    expect(result.output.markdown).toContain('![](image1)');

    expect(result.output.assets).toHaveLength(1);
    expect(result.output.assets[0].ext).toBe('png');
    expect(Array.from(result.output.assets[0].data.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('pptx：逐 Slide 文本 + Notes', async () => {
    const result = await markitdownEngine.convert(await makePptx(), '培训.pptx');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');

    expect(result.output.markdown).toContain('<!-- Slide number: 1 -->');
    expect(result.output.markdown).toContain('UVM 环境搭建');
    expect(result.output.markdown).toContain('Agent 与 Driver');
    expect(result.output.markdown).toContain('<!-- Slide number: 2 -->');
    expect(result.output.markdown).toContain('### Notes:');
    expect(result.output.markdown).toContain('备注：关注 FIFO 深度');
  });

  it('xlsx：Sheet 名注释 + Markdown 表格', async () => {
    const result = await markitdownEngine.convert(makeXlsx(), '结果.xlsx');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');

    expect(result.output.markdown).toContain('<!-- Sheet name: 回归结果 -->');
    expect(result.output.markdown).toContain('| 模块 | 通过 |');
    expect(result.output.markdown).toContain('| 寄存器 | 12 |');
  });

  it('csv：引号/逗号转义解析 + Markdown 表格', async () => {
    const csv = '名称,描述\n"含,逗号",正常\n"含""引号",第二行\n';
    const result = await markitdownEngine.convert(new TextEncoder().encode(csv), '表.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');

    expect(result.output.markdown).toContain('| 名称 | 描述 |');
    expect(result.output.markdown).toContain('| 含,逗号 | 正常 |');
    expect(result.output.markdown).toContain('| 含"引号 | 第二行 |');
  });

  it('csv：单元格内管道符转义', async () => {
    const csv = 'a,b\nx|y,z\n';
    const result = await markitdownEngine.convert(new TextEncoder().encode(csv), '表.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.output.markdown).toContain('x\\|y');
  });

  it('pdf：文字层提取', async () => {
    const result = await markitdownEngine.convert(makeMinimalPdf('Hello SoC Verify'), '手册.pdf');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.output.markdown).toContain('Hello SoC Verify');
  });

  it('pdf：损坏文件报 malformed', async () => {
    const result = await markitdownEngine.convert(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x21, 0x00]), '坏.pdf');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('malformed');
  });

  it('html：标题/列表/表格基本转换', async () => {
    const html = [
      '<html><body>',
      '<h1>回归报告</h1>',
      '<p>总体 <b>通过</b></p>',
      '<ul><li>用例 120</li><li>失败 0</li></ul>',
      '<table><tr><th>块</th><th>覆盖</th></tr><tr><td>ALU</td><td>95%</td></tr></table>',
      '</body></html>',
    ].join('');
    const result = await markitdownEngine.convert(new TextEncoder().encode(html), '报告.html');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');

    expect(result.output.markdown).toContain('# 回归报告');
    expect(result.output.markdown).toContain('- 用例 120');
    expect(result.output.markdown).toContain('| 块 | 覆盖 |');
    expect(result.output.markdown).toContain('| ALU | 95% |');
  });

  it('json：代码围栏包裹', async () => {
    const result = await markitdownEngine.convert(new TextEncoder().encode('{"a": 1}'), '配置.json');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.output.markdown).toContain('```json');
  });

  it('非 zip 字节的 docx 报 malformed', async () => {
    const result = await markitdownEngine.convert(new TextEncoder().encode('plain text, not a zip'), 'x.docx');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('malformed');
  });

  it('docx 缺少 document.xml 报 missingPart', async () => {
    const zip = new JSZip();
    zip.file('别的.txt', 'x');
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }));
    const result = await markitdownEngine.convert(bytes, 'x.docx');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('missingPart');
  });

  it('引擎不支持的扩展名（.doc）报 unsupported 并提示切换引擎', async () => {
    const result = await markitdownEngine.convert(new Uint8Array(8), '旧格式.doc');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('unsupported');
    expect(result.error.detail).toContain('anydoc');
  });

  it('支持列表覆盖声称的扩展名', () => {
    for (const ext of ['.docx', '.pptx', '.xlsx', '.xls', '.csv', '.pdf', '.html', '.htm', '.txt', '.md', '.json', '.xml']) {
      expect(markitdownEngine.supportedExtensions).toContain(ext);
    }
  });
});
