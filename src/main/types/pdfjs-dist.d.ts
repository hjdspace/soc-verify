/**
 * pdfjs-dist legacy 构建的类型声明。
 *
 * 主进程通过动态 import('pdfjs-dist/legacy/build/pdf.mjs') 在 Node 环境
 * 做 PDF 文本提取（markitdown 引擎）。该子路径无独立类型入口，
 * 类型与主入口完全一致，re-export 即可。
 */

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}
