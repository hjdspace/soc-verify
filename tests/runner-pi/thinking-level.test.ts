/**
 * runner-pi/thinking-level.ts —— host 思考强度设置 → pi 引擎值映射。
 *
 * pi 0.85.1 的 ThinkingLevel 值域为 off|minimal|low|medium|high|xhigh|max，
 * 不含 omp 的 'auto'（按问题复杂度逐轮判断）。'auto' 与 'default' 哨兵一样
 * 交还引擎默认行为（pi 默认从设置读取，缺省 'medium'）。
 */
import { describe, expect, it } from 'vitest';
import { toPiThinkingLevel } from '../../runner-pi/thinking-level';

describe('toPiThinkingLevel', () => {
  it("'default' 哨兵映射为 undefined（交还引擎默认）", () => {
    expect(toPiThinkingLevel('default')).toBeUndefined();
    expect(toPiThinkingLevel(undefined)).toBeUndefined();
  });

  it("'auto' 映射为 undefined（pi 不支持 auto，交还引擎默认）", () => {
    expect(toPiThinkingLevel('auto')).toBeUndefined();
  });

  it('具体强度原样透传', () => {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(toPiThinkingLevel(level)).toBe(level);
    }
  });
});
