/**
 * 从 build/icon.svg 生成:
 *   build/icon.ico          — Windows 图标 (256/128/64/48/32/16)
 *   build/icons/16x16.png   — 系统托盘等小尺寸
 *   build/icons/32x32.png
 *   build/icons/64x64.png
 *   build/icons/128x128.png
 *   build/icons/256x256.png
 */
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const svgPath = join(root, 'build', 'icon.svg');
const iconsDir = join(root, 'build', 'icons');

const sizes = [16, 32, 48, 64, 128, 256];

async function main() {
  await mkdir(iconsDir, { recursive: true });

  const svgBuffer = await sharp(svgPath).png().toBuffer();

  // 生成各尺寸 PNG
  const pngBuffers = [];
  for (const size of sizes) {
    const png = await sharp(svgBuffer).resize(size, size).png().toBuffer();
    const outPath = join(iconsDir, `${size}x${size}.png`);
    await writeFile(outPath, png);
    pngBuffers.push(png);
    console.log(`[icon] ${size}x${size}.png`);
  }

  // 生成 ICO (包含所有尺寸)
  const ico = await pngToIco(pngBuffers);
  await writeFile(join(root, 'build', 'icon.ico'), ico);
  console.log('[icon] icon.ico');

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
