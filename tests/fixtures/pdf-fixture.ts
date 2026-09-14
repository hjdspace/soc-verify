/**
 * 测试用 PDF fixture 生成器（issue 11 — 混合 PDF）。
 *
 * 手工构造合法 PDF（精确 xref 偏移），不引入任何 PDF 生成依赖，
 * 覆盖 spec §3 / A03 要求的输入面：
 *   - 文字页（有文本层）
 *   - 位图对象（DeviceRGB XObject，可被引用多次）
 *   - 矢量时序图（折线 + 方块，无位图对象）
 *   - 无文字层页（纯图像，模拟扫描版）
 *
 * 生成物是真实可被 pdfjs 解析的 PDF（xref 精确、流长度精确），
 * 不是"看起来像 PDF"的占位文本。
 */

// ── 规格 ────────────────────────────────────────────────────────

export type PdfImageSpec = {
  /** 每像素 RGB 字节的宽度/高度（原始 DeviceRGB、8bit） */
  width: number;
  height: number;
  rgb: [number, number, number];
  /** 页面用户空间中的放置位置（PDF 坐标，y 向上） */
  x: number;
  y: number;
  /** 绘制尺寸（用户空间单位） */
  w: number;
  h: number;
};

export type PdfPageSpec = {
  /** 文本行（有内容即认为存在文本层） */
  text?: string[];
  /** 矢量时序图：时钟折线 + 两个方块 */
  vector?: boolean;
  images?: PdfImageSpec[];
  /** 页面尺寸（默认 200×200） */
  size?: [number, number];
};

// ── 内容流 ──────────────────────────────────────────────────────

function pageContent(spec: PdfPageSpec, imageNames: string[]): string {
  const lines: string[] = [];
  for (let i = 0; i < (spec.text ?? []).length; i++) {
    const t = (spec.text ?? [])[i]!;
    lines.push(`BT /F1 12 Tf 20 ${170 - i * 16} Td (${t}) Tj ET`);
  }
  if (spec.vector) {
    lines.push('0 0 1 RG 1.5 w');
    lines.push('20 60 m 40 60 l 40 90 l 60 90 l 60 60 l 80 60 l 80 90 l 100 90 l 100 60 l 120 60 l S');
    lines.push('1 0 0 RG 1 w');
    lines.push('20 20 30 20 re S');
    lines.push('70 20 30 20 re S');
  }
  for (let i = 0; i < imageNames.length; i++) {
    const img = spec.images![i]!;
    lines.push(`q ${img.w} 0 0 ${img.h} ${img.x} ${img.y} cm /${imageNames[i]} Do Q`);
  }
  return lines.join('\n');
}

// ── PDF 组装 ────────────────────────────────────────────────────

/** 构造多页 PDF。返回完整字节（Buffer）。 */
export function buildPdf(pages: PdfPageSpec[]): Buffer {
  const objects: string[] = [];
  const total = pages.length;

  // 对象号分配：1 catalog, 2 pages, 3..(2+total) page, 后面 font / 各 XObject / content
  const pageObjNums = pages.map((_, i) => 3 + i);
  const fontObjNum = 3 + total;
  const contentObjNums = pages.map((_, i) => fontObjNum + 1 + i);
  let nextObjNum = fontObjNum + 1 + total;

  // XObject 按内容 hash 去重：同字节同对象，多次放置复用
  const imageKey = (img: PdfImageSpec): string => `${img.width}x${img.height}:${img.rgb.join(',')}`;
  const imageObjByKey = new Map<string, { objNum: number; img: PdfImageSpec }>();
  const pageImageNames: string[][] = [];

  for (const spec of pages) {
    const names: string[] = [];
    for (const img of spec.images ?? []) {
      const key = imageKey(img);
      let entry = imageObjByKey.get(key);
      if (!entry) {
        entry = { objNum: nextObjNum++, img };
        imageObjByKey.set(key, entry);
      }
      names.push(`Im${entry.objNum}`);
    }
    pageImageNames.push(names);
  }

  // 内容流
  pages.forEach((spec, i) => {
    const content = pageContent(spec, pageImageNames[i]!);
    objects[contentObjNums[i]!] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  // 页对象
  pages.forEach((spec, i) => {
    const [w, h] = spec.size ?? [200, 200];
    const names = pageImageNames[i]!;
    const xobj =
      names.length > 0
        ? ` /XObject << ${names.map((n, k) => `/${n} ${imageObjByKey.get(imageKey(spec.images![k]!))!.objNum} 0 R`).join(' ')} >>`
        : '';
    objects[pageObjNums[i]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      `/Resources << /Font << /F1 ${fontObjNum} 0 R >>${xobj} >> /Contents ${contentObjNums[i]!} 0 R >>`;
  });

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${total} >>`;
  objects[fontObjNum] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  for (const { objNum, img } of imageObjByKey.values()) {
    const bytes = Buffer.alloc(img.width * img.height * 3);
    for (let p = 0; p < img.width * img.height; p++) {
      bytes[p * 3] = img.rgb[0];
      bytes[p * 3 + 1] = img.rgb[1];
      bytes[p * 3 + 2] = img.rgb[2];
    }
    objects[objNum] =
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`;
  }

  return serialize(objects);
}

function serialize(objects: string[]): Buffer {
  let pdf = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  const maxObj = objects.length - 1;
  for (let i = 1; i <= maxObj; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objects[i] ?? '<< >>'}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  const count = maxObj + 1;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObj; i++) {
    pdf += `${String(offsets[i]!).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ── 标准 fixture ────────────────────────────────────────────────

export const IMAGE_A: PdfImageSpec = { width: 2, height: 2, rgb: [255, 0, 0], x: 120, y: 110, w: 40, h: 40 };
export const IMAGE_B: PdfImageSpec = { width: 4, height: 2, rgb: [0, 128, 255], x: 20, y: 100, w: 30, h: 15 };

/**
 * 混合 PDF（spec §3 / A03 的验收输入）：
 *  1 页：文字 + 位图 A（同一图片放置两次）+ 矢量时序图
 *  2 页：仅矢量时序图（无位图对象 → 需要整页渲染兜底）
 *  3 页：无文字层，仅位图 B（模拟扫描版：原图可预览，但没有机械全文）
 */
export function mixedPdfFixture(): Buffer {
  return buildPdf([
    {
      text: ['AXI outstanding limit 8'],
      vector: true,
      images: [IMAGE_A, { ...IMAGE_A, x: 20, y: 150, w: 20, h: 20 }],
    },
    { vector: true },
    { images: [IMAGE_B] },
  ]);
}

/** 无位图、仅矢量的多页 PDF（分批渲染用） */
export function vectorOnlyPdfFixture(pageCount: number): Buffer {
  return buildPdf(Array.from({ length: pageCount }, () => ({ vector: true }) as PdfPageSpec));
}

/** 损坏字节（非 PDF） */
export function corruptPdfFixture(): Buffer {
  return Buffer.from('this is definitely not a pdf', 'utf-8');
}
