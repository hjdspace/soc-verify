'use strict';

const { readdirSync, existsSync, readFileSync } = require('node:fs');
const { join, relative, basename, sep } = require('node:path');

/*
 * Unisoc Case Parser Plugin
 *
 * 解析 PROJ_ENV 环境变量指向的 DV 环境目录下的 .cfg 配置文件，
 * 提取仿真用例并生成用例树结构。
 *
 * 用例配置文件格式（.cfg）：
 *   [case case_name]            -> 独立用例（根节点）
 *   [case child_name:base_name] -> 子用例（继承自 base_name）
 *
 * 配置文件查找路径（基于 PROJ_ENV）：
 *   1. PROJ_ENV/{subsys}/bin/case_cfg/ .cfg           — 子系统直接配置
 *   2. PROJ_ENV/udtb/{subsys}/{subenv}/bin/ .cfg      — UDTB 子环境配置
 *   3. PROJ_ENV/udtb/usvp/bin/case_cfg/ .cfg           — USVP 顶层配置（特定子系统）
 *
 * Base/Block 参数解析规则（从文件路径推断）：
 *   1. {subsys}/bin/case_cfg/xxx.cfg           -> base="", block="{subsys}"
 *   2. udtb/{subsys}/{subenv}/bin/xxx.cfg      -> base="{subsys}", block="udtb/{subsys}/{subenv}"
 *   3. udtb/usvp/bin/case_cfg/<sys>_subsys_case.cfg -> base="<sys>_sys", block="udtb/usvp"
 *   4. udtb/usvp/bin/case_cfg/<sys>_top_case.cfg    -> base="top", block="udtb/usvp"
 *   5. udtb/usvp/bin/case_cfg/xxx.cfg          -> base="top", block="udtb/usvp" (默认)
 */

const MANIFEST = {
  id: 'unisoc-case-parser',
  name: 'Unisoc Case Parser',
  version: '1.0.0',
  kind: 'case-parser',
  description:
    'Unisoc 仿真用例解析插件：解析 $PROJ_ENV 下的 .cfg 配置文件，生成用例树。',
};

const SOCVERIFY_DIR = '.socverify';
const ENV_CONFIG_FILE = 'env.json';

// 用例匹配正则：[case case_name] 或 [case child_name:base_name]
const CASE_PATTERN = /\[case\s+([\w_]+)(?:\s*:\s*([\w_]+))?.*/;

// 已知系统名称列表（用于 USVP 配置文件的 base 参数推断）
const KNOWN_SYSTEMS = ['apcpu', 'ch', 'sp', 'aon', 'spch', 'ps_cp', 'phy_cp'];

// USVP 配置文件模式：特定子系统需要解析的 USVP 配置文件
const USVP_CFG_PATTERNS = {
  apcpu_sys: ['apcpu_subsys_case.cfg', 'apcpu_top_case.cfg'],
  aon_sys: ['ch_subsys_case.cfg', 'ch_top_case.cfg', 'sp_subsys_case.cfg', 'sp_top_case.cfg'],
  ch_sys: ['ch_subsys_case.cfg', 'ch_top_case.cfg'],
  sp_sys: ['sp_subsys_case.cfg', 'sp_top_case.cfg'],
  phy_cp_sys: ['phycp_subsys_case.cfg', 'phycp_top_case.cfg'],
  ps_cp_sys: ['pscp_subsys_case.cfg', 'pscp_top_case.cfg'],
};

/**
 * 从进程环境变量或项目环境配置中解析 $PROJ_ENV
 * @param {string} projectRoot - 项目根路径
 * @returns {string|null}
 */
function resolveProjEnv(projectRoot) {
  // 1. 进程环境变量优先
  let projEnv = process.env.PROJ_ENV;
  if (projEnv && projEnv.trim()) return projEnv;

  // 2. 项目环境配置 (.socverify/env.json)
  const envConfigPath = join(projectRoot, SOCVERIFY_DIR, ENV_CONFIG_FILE);
  try {
    const envConfig = JSON.parse(readFileSync(envConfigPath, 'utf-8'));
    const configuredProjEnv = envConfig?.envVars?.PROJ_ENV;
    if (typeof configuredProjEnv === 'string' && configuredProjEnv.trim()) {
      return configuredProjEnv;
    }
  } catch {
    // 配置文件不存在或格式无效，继续
  }

  return null;
}

/**
 * 解析单个 .cfg 配置文件，提取用例
 *
 * @param {string} caseFile - 配置文件路径
 * @returns {{ nodes: Map<string, true>, childCases: Array<{case: string, base: string}> }}
 *   - nodes: 独立用例名集合（根节点）
 *   - childCases: 子用例数组，每个元素包含 case（子用例名）和 base（父用例名）
 */
function parseSingleFile(caseFile) {
  const nodes = new Map();
  const childCases = [];

  let content;
  try {
    content = readFileSync(caseFile, 'utf-8');
  } catch {
    return { nodes, childCases };
  }

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(CASE_PATTERN);
    if (match) {
      const [, caseName, baseName] = match;
      if (baseName) {
        childCases.push({ case: caseName, base: baseName });
      } else {
        nodes.set(caseName, true);
      }
    }
  }

  return { nodes, childCases };
}

/**
 * 从配置文件路径解析 base 和 block 参数
 *
 * 基于 $PROJ_ENV 的相对路径判断，规则参考 Python runsim_r3p0。
 *
 * @param {string} filePath - 配置文件完整路径
 * @param {string} projEnvPath - $PROJ_ENV 指向的路径
 * @returns {{base: string, block: string}|null}
 */
function parseBaseBlockFromPath(filePath, projEnvPath) {
  try {
    // 获取相对于 $PROJ_ENV 的路径
    const relPath = relative(projEnvPath, filePath);
    const parts = relPath.split(sep);
    const filename = basename(filePath);

    // 规则 1: {subsys}/bin/case_cfg/xxx.cfg（无 udtb）
    //   base="", block="{subsys}"
    if (!parts.includes('udtb') && parts.length > 3 && parts[2] === 'case_cfg') {
      const subsys = parts[0];

      // 处理文件名中包含 -sys 的情况，例如 apcpu-sys_bus_case.cfg
      if (filename.includes('-sys')) {
        const nameParts = filename.split('_')[0].split('-');
        if (nameParts.length >= 2 && nameParts[1] === 'sys') {
          return { base: '', block: nameParts[0] };
        }
      }

      return { base: '', block: subsys };
    }

    // 规则 2: udtb/{subsys}/{subenv}/bin/xxx.cfg（非 usvp）
    //   base="{subsys}", block="udtb/{subsys}/{subenv}"
    if (parts.includes('udtb') && parts.includes('bin')) {
      const udtbIndex = parts.indexOf('udtb');
      if (parts.length > udtbIndex + 3 && parts[udtbIndex + 1] !== 'usvp') {
        const subsys = parts[udtbIndex + 1];
        const subenv = parts[udtbIndex + 2];
        return { base: subsys, block: `udtb/${subsys}/${subenv}` };
      }
    }

    // 规则 3/4/5: udtb/usvp/bin/case_cfg/xxx.cfg
    if (parts.includes('udtb') && parts.includes('usvp')) {
      // 处理文件名中包含 -sys 的情况
      if (filename.includes('-sys')) {
        const nameParts = filename.split('_')[0].split('-');
        if (nameParts.length >= 2 && nameParts[1] === 'sys') {
          const sysName = nameParts[0];
          return { base: `${sysName}_sys`, block: 'udtb/usvp' };
        }
      }

      // 规则 3: <sys>_subsys_case.cfg → base="<sys>_sys"
      const subsysMatch = filename.match(/^(\w+)_subsys(?:_case)?\.cfg$/i);
      if (subsysMatch) {
        return { base: `${subsysMatch[1]}_sys`, block: 'udtb/usvp' };
      }

      // 规则 4: <sys>_top_case.cfg → base="top"
      const topMatch = filename.match(/^(\w+)_top(?:_case)?\.cfg$/i);
      if (topMatch) {
        return { base: 'top', block: 'udtb/usvp' };
      }

      // 通用模式匹配：提取文件名中的系统名称
      const generalMatch = filename.match(/^(\w+)(?:_\w+)*(?:_case)?\.cfg$/i);
      if (generalMatch) {
        const sysName = generalMatch[1];
        if (filename.toLowerCase().includes('top')) {
          return { base: 'top', block: 'udtb/usvp' };
        }
        if (KNOWN_SYSTEMS.includes(sysName)) {
          return { base: `${sysName}_sys`, block: 'udtb/usvp' };
        }
        // 规则 5: 默认 → base="top"
        return { base: 'top', block: 'udtb/usvp' };
      }

      // 规则 5: 默认 → base="top"
      return { base: 'top', block: 'udtb/usvp' };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 为指定子系统查找所有相关的 .cfg 配置文件
 *
 * @param {string} projEnvPath - $PROJ_ENV 指向的路径
 * @param {string} subsys - 子系统名称
 * @returns {string[]} 配置文件路径数组
 */
function findCaseConfigFiles(projEnvPath, subsys) {
  const cfgFiles = [];
  const seen = new Set();

  function addCfgFile(filepath) {
    if (!seen.has(filepath)) {
      seen.add(filepath);
      cfgFiles.push(filepath);
    }
  }

  // 1. $PROJ_ENV/{subsys}/bin/case_cfg/*.cfg
  const subsysCfgPath = join(projEnvPath, subsys, 'bin', 'case_cfg');
  if (existsSync(subsysCfgPath)) {
    try {
      for (const cfg of readdirSync(subsysCfgPath)) {
        if (cfg.endsWith('.cfg')) {
          addCfgFile(join(subsysCfgPath, cfg));
        }
      }
    } catch {
      // 读取目录失败，跳过
    }
  }

  // 2. $PROJ_ENV/udtb/{subsys}/*/bin/*.cfg
  //    递归扫描 UDTB 子环境目录，查找包含 bin/ 的子目录
  const udtbSubsysPath = join(projEnvPath, 'udtb', subsys);
  if (existsSync(udtbSubsysPath)) {
    function scanForBinDirs(dirPath) {
      let entries;
      try {
        entries = readdirSync(dirPath, { withFileTypes: true });
      } catch {
        return;
      }

      // 如果当前目录包含 bin/ 子目录，收集其中的 .cfg 文件
      const hasBin = entries.some((e) => e.isDirectory() && e.name === 'bin');
      if (hasBin) {
        const binDir = join(dirPath, 'bin');
        try {
          for (const file of readdirSync(binDir)) {
            if (file.endsWith('.cfg')) {
              addCfgFile(join(binDir, file));
            }
          }
        } catch {
          // 读取 bin/ 失败，跳过
        }
      }

      // 递归扫描子目录
      for (const entry of entries) {
        if (entry.isDirectory()) {
          scanForBinDirs(join(dirPath, entry.name));
        }
      }
    }
    scanForBinDirs(udtbSubsysPath);
  }

  // 3. $PROJ_ENV/udtb/usvp/bin/case_cfg/*.cfg（特定子系统）
  if (USVP_CFG_PATTERNS[subsys]) {
    const usvpCfgPath = join(projEnvPath, 'udtb', 'usvp', 'bin', 'case_cfg');
    if (existsSync(usvpCfgPath)) {
      for (const pattern of USVP_CFG_PATTERNS[subsys]) {
        const cfgPath = join(usvpCfgPath, pattern);
        if (existsSync(cfgPath)) {
          addCfgFile(cfgPath);
        }
      }
    }
  }

  return cfgFiles;
}

const plugin = {
  manifest: MANIFEST,

  /**
   * 解析指定子系统下的仿真用例，生成用例列表（含树结构信息）
   *
   * @param {string} projectRoot - 项目根路径
   * @param {string} subsys - 子系统名称
   * @returns {Promise<Array<{
   *   id: string,
   *   name: string,
   *   path: string,
   *   baseCase?: string,
   *   filePath?: string,
   *   base?: string,
   *   block?: string
   * }>>}
   */
  async parse(projectRoot, subsys) {
    const projEnv = resolveProjEnv(projectRoot);
    if (!projEnv || !subsys) return [];

    const cfgFiles = findCaseConfigFiles(projEnv, subsys);
    if (cfgFiles.length === 0) return [];

    const results = [];

    for (const cfgFile of cfgFiles) {
      const { nodes, childCases } = parseSingleFile(cfgFile);
      const baseBlock = parseBaseBlockFromPath(cfgFile, projEnv);
      const fileName = basename(cfgFile);

      // 添加独立用例（根节点）
      for (const caseName of nodes.keys()) {
        results.push({
          id: `${fileName}:${caseName}`,
          name: caseName,
          path: cfgFile,
          filePath: cfgFile,
          base: baseBlock ? baseBlock.base : undefined,
          block: baseBlock ? baseBlock.block : undefined,
        });
      }

      // 添加子用例（子节点，继承自 baseCase）
      for (const { case: childCase, base: baseCaseName } of childCases) {
        results.push({
          id: `${fileName}:${childCase}`,
          name: childCase,
          path: cfgFile,
          baseCase: baseCaseName,
          filePath: cfgFile,
          base: baseBlock ? baseBlock.base : undefined,
          block: baseBlock ? baseBlock.block : undefined,
        });
      }
    }

    return results;
  },
};

// 导出内部函数用于测试
module.exports = plugin;
module.exports.default = plugin;
module.exports.parseBaseBlockFromPath = parseBaseBlockFromPath;
module.exports.parseSingleFile = parseSingleFile;
module.exports.findCaseConfigFiles = findCaseConfigFiles;
module.exports.resolveProjEnv = resolveProjEnv;
