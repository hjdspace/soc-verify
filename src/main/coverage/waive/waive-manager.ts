/**
 * Waive Manager — 自动生成覆盖率 waive 文件的编排器（docs/coverage_auto_waive.md）。
 *
 * 流程（每次生成一个 runId 目录，含全部中间产物便于 debug）：
 *   1. 读取 <sessionId>-detail.json（detail.txt 解析结果，instance/type/file 明细）
 *   2. 按 file 去重读取 RTL 源码（直接读 detail 报告里的绝对路径；不可读记 warning 跳过）
 *   3. 逐 instance 调用 RTL 静态分析（const_assign / input_tie / output_floating）
 *   4. 分配 file_map（file_id → 绝对路径），渲染 .vRefine XML
 *   5. 产物写入 .socverify/coverage/waive/<runId>/：
 *      - <runId>.vRefine     — Cadence 排除文件（最终交付物）
 *      - waive-analysis.json — 全量信号明细 + per-file 统计（中间产物，debug 用）
 *      - waive-log.txt       — 人读分析日志（中间产物，debug 用）
 *   6. 历史记录 unshift 到 .socverify/coverage/waive/history.json（快速重生成入口）
 *
 * 历史目录布局（模式 B：每条记录一个目录）：
 *   .socverify/coverage/waive/
 *     history.json
 *     waive_<yyyyMMdd_HHmmss>/
 *       waive_<yyyyMMdd_HHmmss>.vRefine
 *       waive-analysis.json
 *       waive-log.txt
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import type {
  CoverageDetailData,
  WaiveAnalysisData,
  WaiveFileStat,
  WaiveHistoryEntry,
  WaiveSignal,
  WaiveSignalKind,
} from '@shared/types';
import {
  analyzeModuleInstance,
  mergeIntoPortIndex,
  scanFilePortDirs,
  stripComments,
  type PortIndex,
} from './rtl-analyzer';
import { renderVrefineXml, type VrefineFileMap } from './vrefine-generator';

/** 与 CoverageManager 一致的 .socverify/coverage 根目录约定 */
const SOCVERIFY_DIR = '.socverify';
const COVERAGE_DIR = 'coverage';
const WAIVE_DIR = 'waive';

/** 历史记录条数上限（沿用 sim-history 的上限量级） */
const MAX_HISTORY_ENTRIES = 100;

const KIND_LABELS: Record<WaiveSignalKind, string> = {
  const_assign: 'assign 固定值',
  input_tie: 'input tie 常量',
  output_floating: 'output 悬空',
};

export type WaiveProgressCallback = (event: {
  step: string;
  message: string;
  percent?: number;
  durationMs?: number;
  details?: Record<string, unknown>;
}) => void;

export type GenerateWaiveOptions = {
  sessionId: string;
  /** top 层级实例名（如 tb_top）；缺省取 detail 首个 instance 的第一段 */
  topScope?: string;
  /** RTL 文件路径前缀映射（imc 路径 → 本地路径），可选 */
  pathPrefixMap?: Record<string, string>;
};

export class WaiveManager {
  constructor(private readonly projectRoot: string) {}

  private waiveRoot(): string {
    return join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, WAIVE_DIR);
  }

  private historyPath(): string {
    return join(this.waiveRoot(), 'history.json');
  }

  private detailPath(sessionId: string): string {
    return join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, `${sessionId}-detail.json`);
  }

  // ─── 生成主流程 ───────────────────────────────────────────────

  async generate(
    opts: GenerateWaiveOptions,
    onProgress?: WaiveProgressCallback,
  ): Promise<WaiveHistoryEntry> {
    const totalStart = Date.now();
    const { sessionId } = opts;

    // Step 1: 读取 detail 明细（waive 数据基础，fail-closed）
    onProgress?.({
      step: 'load_detail',
      message: '正在读取 detail 解析结果（<sessionId>-detail.json）...',
      percent: 5,
    });
    const detailRaw = await readFile(this.detailPath(sessionId), 'utf-8');
    const detail = JSON.parse(detailRaw) as CoverageDetailData;
    if (!detail || !Array.isArray(detail.instances)) {
      throw new Error(`Invalid detail data for session ${sessionId}`);
    }
    if (detail.instances.length === 0) {
      throw new Error('detail 数据为空——请先运行「解析 detail 覆盖率」');
    }

    const topScope =
      opts.topScope ?? detail.instances[0]?.instance.split('.')[0] ?? '';

    // Step 2: 按 file 去重读取 RTL 源码（缓存 stripped 文本）
    onProgress?.({
      step: 'read_rtl',
      message: `正在读取 RTL 源文件（${new Set(detail.instances.map((i) => i.file)).size} 个）...`,
      percent: 15,
    });
    const rtlScanStart = Date.now();
    const strippedCache = new Map<string, string>();
    const fileStats: WaiveFileStat[] = [];
    const warnings: string[] = [];
    const logLines: string[] = [
      `# waive 生成日志 — ${new Date().toISOString()}`,
      `session: ${sessionId}`,
      `top scope: ${topScope || '(none)'}`,
      `detail instances: ${detail.instances.length}`,
      '',
    ];

    const uniqueFiles = [...new Set(detail.instances.map((i) => i.file))];
    for (const file of uniqueFiles) {
      const localPath = this.mapPath(file, opts.pathPrefixMap);
      try {
        if (!existsSync(localPath)) {
          const msg = `RTL 文件不存在，跳过: ${file}`;
          warnings.push(msg);
          logLines.push(`[WARN] ${msg}`);
          fileStats.push({
            file,
            instanceCount: detail.instances.filter((i) => i.file === file).length,
            signalCount: 0,
            warning: 'file not found',
          });
          continue;
        }
        const raw = await readFile(localPath, 'utf-8');
        const stripped = stripComments(raw);
        strippedCache.set(file, stripped);
      } catch (err) {
        const msg = `RTL 文件读取失败，跳过: ${file}（${err instanceof Error ? err.message : String(err)}）`;
        warnings.push(msg);
        logLines.push(`[WARN] ${msg}`);
      }
    }
    const readableFiles = new Set(strippedCache.keys());
    for (const file of uniqueFiles) {
      if (readableFiles.has(file)) continue;
      if (fileStats.some((s) => s.file === file)) continue; // 已记 not found
      fileStats.push({
        file,
        instanceCount: detail.instances.filter((i) => i.file === file).length,
        signalCount: 0,
        warning: 'read failed',
      });
    }

    // 全局模块端口方向索引（跨文件：module 定义与其例化的子模块端口
    // 声明常在不同文件，先对全部可读文本建索引再逐 instance 分析）
    const portIndex: PortIndex = new Map();
    for (const stripped of strippedCache.values()) {
      mergeIntoPortIndex(portIndex, scanFilePortDirs(stripped));
    }

    // Step 3: 逐 instance 分析（仅针对可读文件）
    onProgress?.({
      step: 'analyze_rtl',
      message: '正在静态分析 RTL（assign 固定值 / input tie / output 悬空）...',
      percent: 30,
    });
    const signals: WaiveSignal[] = [];
    const perFileSignals = new Map<string, number>();
    let processed = 0;
    for (const inst of detail.instances) {
      const stripped = strippedCache.get(inst.file);
      if (!stripped) continue;
      try {
        const result = analyzeModuleInstance(
          stripped,
          inst.type,
          inst.instance,
          inst.file,
          portIndex,
        );
        for (const sig of result.signals) {
          signals.push(sig);
          perFileSignals.set(inst.file, (perFileSignals.get(inst.file) ?? 0) + 1);
        }
        for (const w of result.warnings) {
          if (!warnings.includes(w)) warnings.push(w);
          logLines.push(`[WARN] ${inst.instance}: ${w}`);
        }
      } catch (err) {
        const msg = `分析 ${inst.instance}（${inst.file}）异常: ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(msg);
        logLines.push(`[WARN] ${msg}`);
      }
      processed++;
      if (processed % 500 === 0) {
        onProgress?.({
          step: 'analyze_rtl',
          message: `正在静态分析 RTL...（${processed}/${detail.instances.length} instances）`,
          percent: 30 + Math.round((processed / detail.instances.length) * 30),
        });
      }
    }
    const rtlScanMs = Date.now() - rtlScanStart;
    logLines.push('', `## 识别结果：${signals.length} 个不可覆盖信号`, '');
    for (const sig of signals) {
      logLines.push(
        `[${KIND_LABELS[sig.kind]}] ${sig.hier}.${sig.signal}  (${sig.file}:${sig.line}${sig.tieValue !== undefined ? ` tie=${sig.tieValue}` : ''})`,
      );
    }
    // 可读文件的统计行
    for (const file of uniqueFiles) {
      const stat = fileStats.find((s) => s.file === file);
      const count = perFileSignals.get(file) ?? 0;
      if (stat) {
        stat.signalCount = count;
      } else if (count > 0 || readableFiles.has(file)) {
        fileStats.push({
          file,
          instanceCount: detail.instances.filter((i) => i.file === file).length,
          signalCount: count,
        });
      }
    }

    // Step 4: 分配 file_map + 渲染 XML
    onProgress?.({
      step: 'render_xml',
      message: `正在渲染 .vRefine XML（${signals.length} 个信号）...`,
      percent: 65,
    });
    const xmlRenderStart = Date.now();
    const fileMap: VrefineFileMap = new Map<number, string>();
    let fileId = 2; // 0/1 被 cache-map 占位约定占用
    for (const file of uniqueFiles) {
      if (!readableFiles.has(file)) continue;
      fileMap.set(fileId++, file);
    }
    const now = new Date();
    const { xml, ruleCount, droppedOutOfRange } = renderVrefineXml(signals, fileMap, {
      topScope,
      creator: currentUserName(),
      now,
      toolVersion: 'Cadence Verisium Manager24.09',
    });
    const xmlRenderMs = Date.now() - xmlRenderStart;
    if (droppedOutOfRange > 0) {
      logLines.push(``, `[INFO] ${droppedOutOfRange} 个信号因不属于 top scope "${topScope}" 被丢弃`);
    }

    // Step 5: 产物落盘
    onProgress?.({
      step: 'write_output',
      message: '正在写入 .vRefine 与中间产物...',
      percent: 85,
    });
    const runId = `waive_${formatRunId(now)}`;
    const runDir = join(this.waiveRoot(), runId);
    await mkdir(runDir, { recursive: true });
    const outputPath = join(runDir, `${runId}.vRefine`);
    await writeFile(outputPath, xml, 'utf-8');

    const signalCounts: Record<WaiveSignalKind, number> = {
      const_assign: signals.filter((s) => s.kind === 'const_assign').length,
      input_tie: signals.filter((s) => s.kind === 'input_tie').length,
      output_floating: signals.filter((s) => s.kind === 'output_floating').length,
    };

    const totalMs = Date.now() - totalStart;
    const analysis: WaiveAnalysisData = {
      runId,
      sessionId,
      generatedAt: now.getTime(),
      instanceCount: detail.instances.length,
      fileCount: readableFiles.size,
      signals,
      fileStats,
      droppedOutOfRange,
      warnings,
      timings: { rtlScanMs, xmlRenderMs, totalMs },
    };
    await writeFile(join(runDir, 'waive-analysis.json'), JSON.stringify(analysis, null, 2), 'utf-8');
    logLines.push(
      '',
      `## 完成：${ruleCount} 条 rule → ${outputPath}`,
      `耗时 ${totalMs}ms（RTL 扫描 ${rtlScanMs}ms / XML 渲染 ${xmlRenderMs}ms）`,
    );
    await writeFile(join(runDir, 'waive-log.txt'), logLines.join('\n') + '\n', 'utf-8');

    // Step 6: 历史记录（最新在前）
    const entry: WaiveHistoryEntry = {
      runId,
      sessionId,
      generatedAt: now.getTime(),
      ruleCount,
      signalCounts,
      outputPath,
      durationMs: totalMs,
      warnings,
    };
    await this.appendHistory(entry);

    onProgress?.({
      step: 'done',
      message: `waive 文件生成完成（${ruleCount} 条 rule，${signals.length} 个信号）`,
      percent: 100,
      durationMs: totalMs,
      details: { ruleCount, signalCounts, droppedOutOfRange },
    });
    return entry;
  }

  /** imc 路径 → 本地路径（无映射时原样返回；按最长前缀匹配） */
  private mapPath(file: string, map?: Record<string, string>): string {
    if (!map) return file;
    const prefixes = Object.keys(map)
      .filter((p) => file.startsWith(p))
      .sort((a, b) => b.length - a.length);
    if (prefixes.length === 0) return file;
    return map[prefixes[0]] + file.slice(prefixes[0].length);
  }

  // ─── 历史记录 CRUD ─────────────────────────────────────────────

  async listHistory(): Promise<WaiveHistoryEntry[]> {
    try {
      const raw = await readFile(this.historyPath(), 'utf-8');
      const list = JSON.parse(raw) as WaiveHistoryEntry[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** 载入某次生成的中间产物明细（debug 面板用） */
  async loadAnalysis(runId: string): Promise<WaiveAnalysisData | null> {
    try {
      const raw = await readFile(join(this.waiveRoot(), runId, 'waive-analysis.json'), 'utf-8');
      return JSON.parse(raw) as WaiveAnalysisData;
    } catch {
      return null;
    }
  }

  /** 删除一条历史记录及其产物目录（fail-closed：目录名必须以 waive_ 开头） */
  async deleteHistoryEntry(runId: string): Promise<boolean> {
    if (!/^waive_\d{8}_\d{6}_\d{2}$/.test(runId)) {
      throw new Error(`Invalid runId: ${runId}`);
    }
    const list = await this.listHistory();
    const entry = list.find((e) => e.runId === runId);
    if (!entry) return false;
    await rm(join(this.waiveRoot(), runId), { recursive: true, force: true });
    const next = list.filter((e) => e.runId !== runId);
    await this.saveHistory(next);
    return true;
  }

  private async appendHistory(entry: WaiveHistoryEntry): Promise<void> {
    const list = await this.listHistory();
    const next = [entry, ...list].slice(0, MAX_HISTORY_ENTRIES);
    await this.saveHistory(next);
  }

  private async saveHistory(list: WaiveHistoryEntry[]): Promise<void> {
    await mkdir(this.waiveRoot(), { recursive: true });
    await writeFile(this.historyPath(), JSON.stringify(list, null, 2), 'utf-8');
  }

  /** waive 根目录（UI「打开目录」用） */
  waiveDir(): string {
    return this.waiveRoot();
  }

  /** 列出产物目录下的文件名（历史详情面板用，目录不存在返回 []） */
  async listRunFiles(runId: string): Promise<string[]> {
    try {
      return await readdir(join(this.waiveRoot(), runId));
    } catch {
      return [];
    }
  }
}

// ─── 工具函数 ───────────────────────────────────────────────────

function formatRunId(date: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `_${pad(Math.floor(date.getMilliseconds() / 10))}` // 百分之一秒：同一秒内多次生成防撞名
  );
}

/** 当前系统用户名（python getpass.getuser() 的等价物） */
function currentUserName(): string {
  try {
    const info = userInfo();
    if (info && info.username) return info.username;
  } catch {
    // userInfo() 在某些平台可能抛错，回退 homedir
  }
  const home = homedir();
  const idx = home.lastIndexOf('/');
  const idxWin = home.lastIndexOf('\\');
  return home.slice(Math.max(idx, idxWin) + 1) || 'unknown';
}
