/**
 * 在 D:\doc\AI\test\dv 生成性能压测数据（一次性脚本）。
 *
 * 目标规模（对齐真实场景：十几个子系统、1 万+ 用例）：
 * - 12 个 {subsys}/bin/case_cfg/ 子系统 + top → 每个含 3 个 cfg，
 *   每个 cfg 内 200 根用例 + �400 子用例
 * - udtb/{subsys}/{env}/bin/ 若干环境 → 每个含 1-2 个 cfg
 * - udtb/usvp/bin/case_cfg/ 顶层配置
 *
 * 运行：node scripts/gen-perf-dv-data.mjs
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DV_ROOT = 'D:/doc/AI/test/dv';

/** cfg 头部模板：公共字段让文件更接近真实体量 */
function rootCaseBlock(subsys, fileTag, i) {
  return [
    `[case ${subsys}_${fileTag}_${String(i).padStart(4, '0')}_test]`,
    `    compile = `,
    `    simulation = `,
    `    priority = ${i % 5}`,
    `    seed = ${1000 + i}`,
  ].join('\n');
}

function childCaseBlock(subsys, fileTag, i, parentIdx) {
  return [
    `[case ${subsys}_${fileTag}_${String(i).padStart(4, '0')}_cfg${parentIdx} : ${subsys}_${fileTag}_${String(parentIdx).padStart(4, '0')}_test]`,
    `    pattern = basic_test`,
    `    mem_size = 256K`,
    `    runtime = ${1 + (i % 12)}h`,
  ].join('\n');
}

function writeCfg(path, subsys, fileTag, rootCount, childPerRootRatio) {
  const parts = [`# Generated perf-test cfg for ${subsys}`];
  for (let i = 0; i < rootCount; i++) {
    parts.push(rootCaseBlock(subsys, fileTag, i));
  }
  const childCount = Math.floor(rootCount * childPerRootRatio);
  for (let i = 0; i < childCount; i++) {
    const parentIdx = i % rootCount;
    parts.push(childCaseBlock(subsys, fileTag, rootCount + i, parentIdx));
  }
  writeFileSync(path, parts.join('\n\n') + '\n', 'utf-8');
  return rootCount + childCount;
}

if (!existsSync(DV_ROOT)) {
  console.error(`DV root not found: ${DV_ROOT}`);
  process.exit(1);
}

let totalCases = 0;
let totalFiles = 0;

// 12 个子系统，命名对齐真实 uboot 风格
const SUBSYSTEMS = [
  'apcpu_sys', 'aon_sys', 'ap_sys', 'ch_sys', 'sp_sys', 'spch_sys',
  'ps_cp_sys', 'phy_cp_sys', 'gnss_sys', 'bt_sys', 'wcn_sys', 'pmu_sys',
];

for (const subsys of SUBSYSTEMS) {
  // 每个 subsys 3 个 cfg：bus / dvfs / func
  const tags = ['bus', 'dvfs', 'func'];
  for (const tag of tags) {
    const dir = join(DV_ROOT, subsys, 'bin', 'case_cfg');
    mkdirSync(dir, { recursive: true });
    // 每文件 150 根 + 300 子 = 450 → 3 文件 1350 / subsys
    const n = writeCfg(
      join(dir, `${subsys}_${tag}_case.cfg`),
      subsys, tag, 150, 2,
    );
    totalCases += n;
    totalFiles++;
  }
}

// top：顶层配置（名字固定 top）
{
  const dir = join(DV_ROOT, 'top', 'bin', 'case_cfg');
  mkdirSync(dir, { recursive: true });
  const n = writeCfg(join(dir, 'top_bus_case.cfg'), 'top', 'bus', 100, 2);
  totalCases += n;
  totalFiles++;
}

// udtb 环境：每个前 6 个 subsystems 各 2 个子环境
for (const subsys of SUBSYSTEMS.slice(0, 6)) {
  for (const env of ['clk', 'dvfs']) {
    const dir = join(DV_ROOT, 'udtb', subsys, `${subsys}_${env}`, 'bin');
    mkdirSync(dir, { recursive: true });
    const n = writeCfg(join(dir, `${subsys}_${env}.cfg`), subsys, `udtb_${env}`, 80, 2);
    totalCases += n;
    totalFiles++;
  }
}

// udtb/usvp：顶层平台配置（base 推断走 USVP_CFG_PATTERNS / 通用规则）
{
  const dir = join(DV_ROOT, 'udtb', 'usvp', 'bin', 'case_cfg');
  mkdirSync(dir, { recursive: true });
  const known = ['apcpu', 'ch', 'sp', 'aon', 'spch', 'pscp', 'phycp'];
  for (const sys of known) {
    const n = writeCfg(join(dir, `${sys}_subsys_case.cfg`), sys, 'usvp', 60, 2);
    totalCases += n;
    totalFiles++;
  }
}

console.log(`Generated ${totalFiles} cfg files, ${totalCases} cases under ${DV_ROOT}`);
