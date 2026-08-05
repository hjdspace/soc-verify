/**
 * vio_summary.log 日志解析器
 *
 * 参考 Python parser.py 中 VioLogParser.parse_log_file。
 *
 * 日志格式：
 * ```
 * ------------------------------------------------------------
 * NUM    : 1
 * Hier   : tb_top.xxx.xxx
 * Time   : 1523423 FS
 * Check  : setup( posedge xxx, xxx )
 * ------------------------------------------------------------
 * ```
 *
 * 规则：
 * - 分隔线 `----` 标记一条违例的结束
 * - Key-Value 格式：`KEY : VALUE`（注意 ` : ` 两侧有空格）
 * - Check 字段可能跨多行（后续行无 ` : ` 分隔符时追加到 Check 值）
 * - 必须包含 NUM、Hier、Time、Check 四个字段才算有效违例
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { convertTimeToFs } from './time-utils';
import { parseCaseInfoFromPath } from './case-info-parser';
import type { ParsedViolation, ParseOptions } from '../types';

export type { ParseOptions };

/** 解析结果 */
export type ParseResult = {
  violations: ParsedViolation[];
  errors: string[];
};

/** 违例中间状态（解析中的 key-value map） */
type ViolationFields = Record<string, string>;

/**
 * 验证违例条目完整性（必须包含 NUM / Hier / Time / Check 四个字段且非空）。
 */
function validateViolation(v: ViolationFields): boolean {
  const required = ['NUM', 'Hier', 'Time', 'Check'];
  return required.every((key) => key in v && v[key].length > 0);
}

/**
 * 将原始字段 map 转换为 ParsedViolation。
 */
function processViolation(
  fields: ViolationFields,
  filePath: string,
  options: ParseOptions,
): ParsedViolation {
  const timeStr = fields['Time'];
  const timeFs = convertTimeToFs(timeStr);
  const num = parseInt(fields['NUM'], 10);
  const caseInfo = parseCaseInfoFromPath(filePath, options);

  return {
    caseName: caseInfo.caseName,
    corner: caseInfo.corner,
    seed: caseInfo.seed,
    subsys: caseInfo.subsys,
    num: Number.isFinite(num) ? num : 0,
    hier: fields['Hier'],
    timeFs,
    timeDisplay: timeStr,
    checkInfo: fields['Check'],
    filePath,
  };
}

/**
 * 流式解析 vio_summary.log 文件。
 *
 * 使用 readline + createReadStream 天然支持背压，不阻塞事件循环。
 * 每解析到一条完整违例就通过 onViolation 回调返回，适合 Worker Thread 分批发送。
 *
 * @param filePath 日志文件路径
 * @param options  解析选项（caseName/corner 覆盖）
 * @param onViolation 每解析到一条违例时的回调
 * @param onProgress   进度回调（已处理行数）
 */
export async function parseLogStream(
  filePath: string,
  options: ParseOptions,
  onViolation: (v: ParsedViolation) => void,
  onProgress?: (lineCount: number) => void,
): Promise<ParseResult> {
  const errors: string[] = [];
  let _violationCount = 0;
  let lineCount = 0;

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let current: ViolationFields = {};

  for await (const rawLine of rl) {
    lineCount++;
    const line = rawLine.trim();

    // 进度回调（每 5000 行通知一次）
    if (onProgress && lineCount % 5000 === 0) {
      onProgress(lineCount);
    }

    // 空行跳过
    if (line.length === 0) continue;

    // 分隔线标记一条违例的结束
    if (line.startsWith('----')) {
      if (Object.keys(current).length > 0) {
        if (validateViolation(current)) {
          try {
            onViolation(processViolation(current, filePath, options));
            _violationCount++;
          } catch (err) {
            errors.push(`Failed to process violation at line ${lineCount}: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          // 无效条目跳过（不报错，与 Python 行为一致）
        }
        current = {};
      }
      continue;
    }

    // 解析 Key-Value 对
    const colonPos = line.indexOf(' : ');
    if (colonPos !== -1) {
      const key = line.slice(0, colonPos).trim();
      const value = line.slice(colonPos + 3).trim();
      current[key] = value;
    } else {
      // 多行 Check 追加
      if ('Check' in current) {
        current['Check'] += ' ' + line;
      }
    }
  }

  // 处理文件末尾最后一条违例（无分隔线结尾的情况）
  if (Object.keys(current).length > 0) {
    if (validateViolation(current)) {
      try {
        onViolation(processViolation(current, filePath, options));
        _violationCount++;
      } catch (err) {
        errors.push(`Failed to process final violation: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { violations: [], errors };
}

/**
 * 一次性解析整个日志文件并返回所有违例。
 *
 * 对于大文件（>50MB），建议使用 parseLogStream + 分批回调以减少内存峰值。
 */
export async function parseLogFile(
  filePath: string,
  options?: ParseOptions,
): Promise<ParseResult> {
  const violations: ParsedViolation[] = [];
  const result = await parseLogStream(
    filePath,
    options ?? {},
    (v) => violations.push(v),
  );
  return { violations, errors: result.errors };
}
