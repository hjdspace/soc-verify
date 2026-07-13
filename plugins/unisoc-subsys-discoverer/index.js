'use strict';

const { readdirSync, statSync, existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

/**
 * Unisoc Subsys Discovery Plugin
 *
 * 通过解析 $PROJ_RTL 目录下的所有文件夹来发现子系统：
 * - 文件夹名以 `_sys` 结尾 → 子系统 (subsys)
 * - 文件夹名为 `top` → 顶层模块 (top)
 *
 * 如果 $PROJ_RTL 环境变量未定义，则读取项目 `.socverify/subsys-config.json`
 * 配置文件中用户手动配置的子系统列表。
 */

const MANIFEST = {
  id: 'unisoc-subsys-discoverer',
  name: 'Unisoc Subsys Discoverer',
  version: '1.0.0',
  kind: 'subsys-discoverer',
  description:
    'Unisoc 子系统发现插件：解析 $PROJ_RTL 目录下以 _sys 结尾的文件夹和 top 文件夹。无 $PROJ_RTL 时支持手动配置。',
};

const MANUAL_CONFIG_FILE = 'subsys-config.json';
const ENV_CONFIG_FILE = 'env.json';
const SOCVERIFY_DIR = '.socverify';

/**
 * 从 $PROJ_RTL 环境变量指向的目录中扫描子系统
 * @param {string} projRtlPath - $PROJ_RTL 指向的路径
 * @returns {Array<{id: string, name: string, path: string, kind: 'subsys'|'top'}>}
 */
function discoverFromProjRtl(projRtlPath) {
  const results = [];

  if (!existsSync(projRtlPath)) {
    return results;
  }

  let entries;
  try {
    entries = readdirSync(projRtlPath);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(projRtlPath, entry);

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;

    // 以 _sys 结尾的文件夹为子系统
    if (entry.endsWith('_sys')) {
      results.push({
        id: entry,
        name: entry,
        path: fullPath,
        kind: 'subsys',
      });
    }

    // 名为 top 的文件夹为顶层模块
    if (entry === 'top') {
      results.push({
        id: entry,
        name: entry,
        path: fullPath,
        kind: 'top',
      });
    }
  }

  // top 排在最后，subsys 按字母排序
  results.sort((a, b) => {
    if (a.kind === 'top' && b.kind !== 'top') return 1;
    if (a.kind !== 'top' && b.kind === 'top') return -1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * 从手动配置文件中读取子系统列表
 * @param {string} projectRoot - 项目根路径
 * @returns {Array<{id: string, name: string, path: string, kind: 'subsys'|'top'}>}
 */
function discoverFromManualConfig(projectRoot) {
  const configPath = join(projectRoot, SOCVERIFY_DIR, MANUAL_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return [];
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    if (!config.subsystems || !Array.isArray(config.subsystems)) {
      return [];
    }

    return config.subsystems.map(
      /** @param {Record<string, string>} s */ (s) => ({
        id: s.name,
        name: s.name,
        path: s.path ? resolve(projectRoot, s.path) : join(projectRoot, s.name),
        kind: s.kind === 'top' ? 'top' : 'subsys',
      }),
    );
  } catch {
    return [];
  }
}

const plugin = {
  manifest: MANIFEST,

  /**
   * 发现项目中的子系统
   * @param {string} projectRoot - 项目根路径
   * @returns {Promise<Array<{id: string, name: string, path: string, kind: 'subsys'|'top'}>>}
   */
  async discover(projectRoot) {
    // 启动进程环境优先，其次使用项目环境配置。
    let projRtl = process.env.PROJ_RTL;
    if (!projRtl) {
      const envConfigPath = join(projectRoot, SOCVERIFY_DIR, ENV_CONFIG_FILE);
      try {
        const envConfig = JSON.parse(readFileSync(envConfigPath, 'utf-8'));
        const configuredProjRtl = envConfig?.envVars?.PROJ_RTL;
        if (typeof configuredProjRtl === 'string' && configuredProjRtl.trim()) {
          projRtl = configuredProjRtl;
        }
      } catch {
        // Missing or invalid project environment config falls through to manual config.
      }
    }

    if (projRtl) {
      const results = discoverFromProjRtl(projRtl);
      if (results.length > 0) {
        return results;
      }
    }

    // $PROJ_RTL 未定义或扫描结果为空时，尝试从手动配置文件读取
    return discoverFromManualConfig(projectRoot);
  },
};

module.exports = plugin;
module.exports.default = plugin;
