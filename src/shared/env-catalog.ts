/**
 * Static catalog of known SoC / EDA environment variables.
 *
 * Shared between main process and renderer so the UI can display all
 * categories immediately without an async tRPC round-trip.
 */

import type { EnvVarCategory, EnvVarDefinition, EnvVarGroup } from './types/env';

/** Catalog of all known env var definitions. */
export const ENV_VAR_CATALOG: EnvVarDefinition[] = [
  // ── SOC 项目环境 ──────────────────────────────────
  { name: 'PROJ_DIR', category: 'soc', description: '项目根目录 (view)', isPath: true },
  { name: 'PROJ_ENV', category: 'soc', description: '验证环境目录 (dv)', isPath: true },
  { name: 'PROJ_RTL', category: 'soc', description: '设计源码目录 (de)', isPath: true },
  { name: 'PROJ_WORK', category: 'soc', description: '仿真工作目录 (work)', isPath: true },
  { name: 'SPRD_TOOL_DIR', category: 'soc', description: '工具目录', isPath: true },

  // ── Synopsys 工具 ────────────────────────────────
  { name: 'VERDI_HOME', category: 'synopsys', description: 'Verdi 安装路径', isPath: true },
  { name: 'NOVAS_HOME', category: 'synopsys', description: 'Novas 安装路径', isPath: true },
  { name: 'VCS_HOME', category: 'synopsys', description: 'VCS 安装路径', isPath: true },
  { name: 'SNPSLMD_LICENSE_FILE', category: 'synopsys', description: 'Synopsys License 文件' },

  // ── Cadence 工具 ─────────────────────────────────
  { name: 'XCELIUM_HOME', category: 'cadence', description: 'Xcelium 安装路径（标准变量名）', isPath: true },
  { name: 'XLM_ROOT', category: 'cadence', description: 'Xcelium 安装路径（TraceWeave 使用，回退到 XCELIUM_HOME）', isPath: true },
  { name: 'CDS_INST_DIR', category: 'cadence', description: 'Cadence 安装路径', isPath: true },
  { name: 'CDS_LICENSE_FILE', category: 'cadence', description: 'Cadence License 文件' },

  // ── License 通用 ─────────────────────────────────
  { name: 'LM_LICENSE_FILE', category: 'license', description: 'FlexLM License 文件' },
  { name: 'CDS_LIC_FILE', category: 'license', description: 'Cadence License 文件 (别名)' },
  { name: 'MGLS_LICENSE_FILE', category: 'license', description: 'Mentor Graphics License 文件' },
  { name: 'LICENSE_FILE', category: 'license', description: '通用 License 文件' },

  // ── 系统环境 ─────────────────────────────────────
  { name: 'LD_LIBRARY_PATH', category: 'system', description: '动态链接库搜索路径' },
  { name: 'PATH', category: 'system', description: '可执行文件搜索路径' },
];

/** Display labels and descriptions for each category. */
const CATEGORY_META: Record<EnvVarCategory, { label: string; description: string }> = {
  soc: { label: 'SOC 项目环境', description: '项目结构与仿真工作目录' },
  synopsys: { label: 'Synopsys 工具', description: 'VCS / Verdi / Novas 等工具环境' },
  cadence: { label: 'Cadence 工具', description: 'Xcelium / Cadence 工具环境' },
  license: { label: 'License 配置', description: 'EDA 工具许可证配置' },
  system: { label: '系统环境', description: '系统路径与库搜索路径' },
};

/** Category display order. */
const CATEGORY_ORDER: EnvVarCategory[] = ['soc', 'synopsys', 'cadence', 'license', 'system'];

/** Flat list of known env var names (derived from catalog). */
export const KNOWN_ENV_VAR_NAMES: string[] = ENV_VAR_CATALOG.map((v) => v.name);

/**
 * Get the env var catalog grouped by category, in display order.
 */
export function getEnvVarCatalog(): EnvVarGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_META[category].label,
    description: CATEGORY_META[category].description,
    vars: ENV_VAR_CATALOG.filter((v) => v.category === category),
  }));
}
