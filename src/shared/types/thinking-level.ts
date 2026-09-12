/**
 * 思考强度（thinking level）配置。
 *
 * 值域与 pi 引擎的 `ThinkingLevel` / `ConfiguredThinkingLevel` 对齐
 * （@earendil-works/pi-coding-agent 的 thinking 类型）：
 *  - auto    引擎逐轮根据 prompt 自动选择思考强度
 *  - off     关闭推理
 *  - minimal ~1k tokens
 *  - low     ~2k tokens
 *  - medium  ~8k tokens
 *  - high    ~16k tokens
 *  - xhigh   ~32k tokens
 *  - max     模型支持的最大思考量
 *
 * `'default'` 是本项目自己的哨兵值：表示不向引擎下发任何设置，
 * 跟随 omp 引擎自身的默认行为（provider 原生默认）。
 */
export const THINKING_LEVELS = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ThinkingLevelSetting = ThinkingLevel | 'default';

/** 判断未知值是否为合法的思考强度设置。 */
export function isThinkingLevelSetting(value: unknown): value is ThinkingLevelSetting {
  return typeof value === 'string' && (value === 'default' || (THINKING_LEVELS as readonly string[]).includes(value));
}

/** 归一化：非法/缺省值回落到 'default'（不下发设置）。 */
export function normalizeThinkingLevelSetting(value: unknown): ThinkingLevelSetting {
  return isThinkingLevelSetting(value) ? value : 'default';
}

/** UI 下拉选项（value 顺序即展示顺序）。 */
export type ThinkingLevelOption = {
  value: ThinkingLevelSetting;
  label: string;
  description: string;
};

export const THINKING_LEVEL_OPTIONS: ThinkingLevelOption[] = [
  { value: 'default', label: '默认', description: '跟随引擎默认设置' },
  { value: 'auto', label: '自动', description: '按问题复杂度逐轮判断' },
  { value: 'off', label: '关闭', description: '不进行思考' },
  { value: 'minimal', label: '极简', description: '非常简短的推理（~1k tokens）' },
  { value: 'low', label: '低', description: '轻量推理（~2k tokens）' },
  { value: 'medium', label: '中', description: '适中推理（~8k tokens）' },
  { value: 'high', label: '高', description: '深度推理（~16k tokens）' },
  { value: 'xhigh', label: '超高', description: '扩展推理（~32k tokens）' },
  { value: 'max', label: '最大', description: '模型支持的最大思考量' },
];

/** 按值查找 UI 展示标签，未知值回落到 '默认'。 */
export function thinkingLevelLabel(value: ThinkingLevelSetting | undefined): string {
  return THINKING_LEVEL_OPTIONS.find((opt) => opt.value === value)?.label ?? '默认';
}
