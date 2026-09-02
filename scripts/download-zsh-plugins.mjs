#!/usr/bin/env node
/**
 * Download zsh-autosuggestions plugin to resources/terminal/zsh/plugins/.
 *
 * Usage:
 *   node scripts/download-zsh-plugins.mjs           # 下载（已存在则跳过）
 *   node scripts/download-zsh-plugins.mjs --force   # 强制重新下载
 *
 * zsh-autosuggestions 是一个 zsh 插件，通过 git clone 获取。
 * 参照 scripts/download-officecli.mjs 模式：已存在则跳过，支持 --force。
 *
 * 不放入 postinstall —— postinstall 已有 setup-agent.mjs + patch-native-modules.mjs，
 * 再加 clone 步骤增加复杂度且依赖网络/git，CI 离线环境可能失败。
 * download:zsh-plugins 作为独立 npm script，在 package/package:win/package:linux 构建流程中调用。
 *
 * 下载失败不阻断构建，只打印警告（运行时降级——无 zsh-autosuggestions 则不启用命令预测）。
 */

import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = join(__dirname, '..', 'resources', 'terminal', 'zsh', 'plugins', 'zsh-autosuggestions');
const REPO_URL = 'https://github.com/zsh-users/zsh-autosuggestions';
const PLUGIN_FILE = 'zsh-autosuggestions.zsh';

/**
 * 检查插件是否已正确安装（目录存在且包含核心 .zsh 文件）。
 */
function isPluginInstalled() {
  return existsSync(TARGET_DIR) && existsSync(join(TARGET_DIR, PLUGIN_FILE));
}

/**
 * 使用 git clone 下载 zsh-autosuggestions。
 */
function gitClonePlugin() {
  // 确保父目录存在
  const parentDir = dirname(TARGET_DIR);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // 如果目标目录已存在（--force 场景），先删除
  if (existsSync(TARGET_DIR)) {
    console.log(`[zsh-plugins] Removing existing directory: ${TARGET_DIR}`);
    rmSync(TARGET_DIR, { recursive: true, force: true });
  }

  console.log(`[zsh-plugins] Cloning zsh-autosuggestions from ${REPO_URL}...`);
  const result = spawnSync('git', ['clone', '--depth=1', REPO_URL, TARGET_DIR], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'unknown error';
    throw new Error(`git clone failed: ${stderr}`);
  }

  console.log(`[zsh-plugins] Clone complete.`);
}

/**
 * 验证插件文件存在。
 */
function verifyPlugin() {
  if (!isPluginInstalled()) {
    throw new Error(`Plugin file not found after clone: ${join(TARGET_DIR, PLUGIN_FILE)}`);
  }

  const stats = statSync(join(TARGET_DIR, PLUGIN_FILE));
  console.log(`[zsh-plugins] Verification OK. ${PLUGIN_FILE} exists (${stats.size} bytes).`);

  // 打印目录内容摘要
  const entries = readdirSync(TARGET_DIR).slice(0, 10);
  console.log(`[zsh-plugins] Plugin directory contents: ${entries.join(', ')}${readdirSync(TARGET_DIR).length > 10 ? ' ...' : ''}`);
}

// ===== Main =====

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');

  // 已存在则跳过（除非 --force）
  if (isPluginInstalled() && !force) {
    console.log(`[zsh-plugins] Plugin already installed: ${TARGET_DIR}`);
    console.log(`[zsh-plugins] Use --force to re-download.`);
    return;
  }

  // 检查 git 是否可用
  const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf-8' });
  if (gitCheck.status !== 0) {
    console.error(`[zsh-plugins] git is not available: ${gitCheck.stderr?.trim() || 'unknown error'}`);
    console.warn(`[zsh-plugins] Build will continue without the plugin. Command autosuggestions will be disabled at runtime.`);
    return;
  }

  // 下载
  try {
    gitClonePlugin();
    verifyPlugin();
  } catch (err) {
    console.error(`[zsh-plugins] Download failed: ${err.message}`);
    console.warn(`[zsh-plugins] Build will continue without the plugin. Command autosuggestions will be disabled at runtime.`);
    // 清理可能残留的部分下载
    if (existsSync(TARGET_DIR)) {
      try {
        rmSync(TARGET_DIR, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

main();
