import { describe, expect, it } from 'vitest';
import { buildSkillLoaderOptions } from '../../runner-pi/skills';
import type { InitConfig } from '../../runner-pi/protocol';

/**
 * issue 09 验收：skill 装载列表由 host 单一来源下发（与 UI 发现一致），
 * runner 不自行发现。顺序即同名解析优先级：
 *   project canonical > project legacy > builtin > user canonical > user legacy
 */

describe('buildSkillLoaderOptions — host 下发 skillPaths 的装载装配（issue 09）', () => {
  it('skillPaths 非空 → noSkills + additionalSkillPaths，顺序原样透传', () => {
    const skillPaths = [
      'C:/proj/.pi/skills',
      'C:/proj/.omp/skills',
      'C:/app/resources/built-in-extension/skills',
      'C:/Users/u/.pi/agent/skills',
      'C:/Users/u/.omp/agent/skills',
    ];
    const opts = buildSkillLoaderOptions({ skillPaths } as InitConfig);

    expect(opts.noSkills).toBe(true);
    expect(opts.additionalSkillPaths).toEqual(skillPaths);
    // first-wins 去重依赖顺序：canonical 必须先于 legacy 出现
    expect(opts.additionalSkillPaths!.indexOf('C:/proj/.pi/skills')).toBeLessThan(
      opts.additionalSkillPaths!.indexOf('C:/proj/.omp/skills'),
    );
    expect(opts.additionalSkillPaths!.indexOf('C:/Users/u/.pi/agent/skills')).toBeLessThan(
      opts.additionalSkillPaths!.indexOf('C:/Users/u/.omp/agent/skills'),
    );
  });

  it('skillPaths 为空数组 → 空配置（保持 pi 默认发现，避免静默清空技能面）', () => {
    expect(buildSkillLoaderOptions({ skillPaths: [] } as InitConfig)).toEqual({});
  });

  it('skillPaths 未下发（旧 host）→ 空配置（保持 pi 默认发现）', () => {
    expect(buildSkillLoaderOptions({} as InitConfig)).toEqual({});
  });

  it('不修改调用方传入的数组（防御性拷贝）', () => {
    const skillPaths = ['C:/proj/.pi/skills'];
    buildSkillLoaderOptions({ skillPaths } as InitConfig);
    expect(skillPaths).toEqual(['C:/proj/.pi/skills']);
  });
});
