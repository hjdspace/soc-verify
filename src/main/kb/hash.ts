/**
 * 内容寻址 hash 工具 —— sha256 hex（issue 11 审查去重）。
 *
 * 来源修订（source-identity）、PDF 资产命名（pdf-assets/pdf-asset-store）
 * 都以「字节 → sha256 hex」为身份；单一实现避免漂移。
 */

import { createHash } from 'node:crypto';

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
}
