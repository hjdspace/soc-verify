/**
 * design-service.ts 单元测试（issue 08 补齐）。
 *
 * 测试缝：loadBundleRuleDoc / mergeRuleDocs 公共 API 边界。
 * 不测 refresh/detectTops（那在 rtl-router.test.ts 的 mock spawn 模式覆盖）。
 *
 * 覆盖：
 *   - loadBundleRuleDoc：自定义规则文件存在时合并，缺失/损坏时回退内置
 *   - mergeRuleDocs：同 id 覆盖、新 id 扩展、priority 排序去重
 *   - isConfigured：配置完备判定
 *   - loadDesignConfig / saveDesignConfig 配置持久化往返
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadBundleRuleDoc,
  loadDesignConfig,
  saveDesignConfig,
  isConfigured,
  getBundleRulesPath,
  getDesignConfigPath,
} from '../../src/main/rtl/design-service';
import { BUILTIN_AMBA_RULES } from '../../src/main/rtl/bundle-rules';
import type { BundleRuleDoc } from '../../src/main/rtl/types';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'sv-design-service-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ─── loadBundleRuleDoc ───────────────────────────────────────

describe('loadBundleRuleDoc', () => {
  it('无自定义文件时返回纯内置规则', () => {
    const doc = loadBundleRuleDoc(projectDir);
    expect(doc.priority).toEqual(BUILTIN_AMBA_RULES.priority);
    expect(doc.rules).toHaveLength(BUILTIN_AMBA_RULES.rules.length);
  });

  it('自定义文件存在时合并：同 id 覆盖、新 id 扩展、priority 去重排序', () => {
    const rulesDir = join(projectDir, '.socverify/design');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      getBundleRulesPath(projectDir),
      JSON.stringify({
        priority: ['myahb', 'ahb'],
        rules: [
          {
            id: 'myahb',
            protocol: 'MyAHB',
            signals: ['htrans', 'haddr'],
            requiresAllOf: ['htrans'],
            minSignals: 1,
          },
          {
            id: 'ahb',
            protocol: 'CustomAHB',
            signals: ['htrans', 'haddr', 'hwrite', 'hsel'],
            requiresAllOf: ['htrans', 'haddr'],
            minSignals: 2,
          },
        ],
      } satisfies BundleRuleDoc),
      'utf-8',
    );

    const doc = loadBundleRuleDoc(projectDir);

    // custom priority 在前（myahb 先于 ahb）
    expect(doc.priority[0]).toBe('myahb');
    expect(doc.priority[1]).toBe('ahb');

    // ahb 被覆盖为 CustomAHB
    const ahb = doc.rules.find((r) => r.id === 'ahb');
    expect(ahb?.protocol).toBe('CustomAHB');

    // myahb 是新规则
    expect(doc.rules.some((r) => r.id === 'myahb')).toBe(true);

    // 内置其他规则仍存在
    expect(doc.rules.some((r) => r.id === 'axi4')).toBe(true);
    expect(doc.rules.some((r) => r.id === 'clk')).toBe(true);

    // priority 无重复
    expect(new Set(doc.priority).size).toBe(doc.priority.length);
  });

  it('损坏的 JSON 回退内置规则', () => {
    const rulesDir = join(projectDir, '.socverify/design');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(getBundleRulesPath(projectDir), '{ broken json !!', 'utf-8');

    const doc = loadBundleRuleDoc(projectDir);
    expect(doc.priority).toEqual(BUILTIN_AMBA_RULES.priority);
  });

  it('非数组 rules/priority 回退内置规则', () => {
    const rulesDir = join(projectDir, '.socverify/design');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(getBundleRulesPath(projectDir), JSON.stringify({ priority: 'not-array', rules: 'not-array' }), 'utf-8');

    const doc = loadBundleRuleDoc(projectDir);
    expect(doc.priority).toEqual(BUILTIN_AMBA_RULES.priority);
  });

  it('自定义文件 priority 不含内置 id 时内置仍被追加', () => {
    const rulesDir = join(projectDir, '.socverify/design');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      getBundleRulesPath(projectDir),
      JSON.stringify({
        priority: ['mybus'],
        rules: [
          {
            id: 'mybus',
            protocol: 'MyBus',
            signals: ['mreq', 'mgrant'],
            requiresAllOf: ['mreq'],
            minSignals: 1,
          },
        ],
      } satisfies BundleRuleDoc),
      'utf-8',
    );

    const doc = loadBundleRuleDoc(projectDir);
    // mybus 在前，内置全部在后
    expect(doc.priority[0]).toBe('mybus');
    expect(doc.priority.slice(1)).toEqual(BUILTIN_AMBA_RULES.rules.map((r) => r.id));
  });
});

// ─── isConfigured ────────────────────────────────────────────

describe('isConfigured', () => {
  it('filelists 非空 + top 非空 → true', () => {
    expect(isConfigured({ filelists: ['spike.f'], top: 'spike_top' })).toBe(true);
  });

  it('filelists 空 → false', () => {
    expect(isConfigured({ filelists: [], top: 'spike_top' })).toBe(false);
  });

  it('top null → false', () => {
    expect(isConfigured({ filelists: ['spike.f'], top: null })).toBe(false);
  });
});

// ─── loadDesignConfig / saveDesignConfig ────────────────────

describe('loadDesignConfig / saveDesignConfig', () => {
  it('配置持久化往返一致', () => {
    saveDesignConfig(projectDir, { filelists: ['a.f', 'b.f'], top: 'my_top' });
    const loaded = loadDesignConfig(projectDir);
    expect(loaded.filelists).toEqual(['a.f', 'b.f']);
    expect(loaded.top).toBe('my_top');
  });

  it('空 filelist + null top 归一化', () => {
    saveDesignConfig(projectDir, { filelists: [], top: null });
    const loaded = loadDesignConfig(projectDir);
    expect(loaded.filelists).toEqual([]);
    expect(loaded.top).toBeNull();
  });

  it('空字符串 top 归一化为 null', () => {
    saveDesignConfig(projectDir, { filelists: ['a.f'], top: '' });
    const loaded = loadDesignConfig(projectDir);
    expect(loaded.top).toBeNull();
  });

  it('无配置文件时返回空配置', () => {
    const loaded = loadDesignConfig(projectDir);
    expect(loaded.filelists).toEqual([]);
    expect(loaded.top).toBeNull();
  });

  it('损坏的 config.json 回退空配置', () => {
    const configDir = join(projectDir, '.socverify/design');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(getDesignConfigPath(projectDir), '{ broken', 'utf-8');
    const loaded = loadDesignConfig(projectDir);
    expect(loaded.filelists).toEqual([]);
    expect(loaded.top).toBeNull();
  });

  it('config.json 中 filelists 含非字符串项时过滤', () => {
    const configDir = join(projectDir, '.socverify/design');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      getDesignConfigPath(projectDir),
      JSON.stringify({ filelists: ['a.f', 123, null, 'b.f'], top: 'top' }),
      'utf-8',
    );
    const loaded = loadDesignConfig(projectDir);
    expect(loaded.filelists).toEqual(['a.f', 'b.f']);
  });

  it('旧配置目录扫描排除规则自动补齐新增的默认排除项', () => {
    const configDir = join(projectDir, '.socverify/design');
    mkdirSync(configDir, { recursive: true });
    // 模拟 v0.4.6 之前的旧配置：只有 4 条基础排除规则
    writeFileSync(
      getDesignConfigPath(projectDir),
      JSON.stringify({
        source: 'directory',
        filelists: [],
        directory: {
          root: 'hw',
          excludes: ['**/dv/**', '**/test/**', '**/tests/**', '**/vendor/**'],
          incdirs: [],
          defines: [],
        },
        top: 'top',
      }),
      'utf-8',
    );
    const loaded = loadDesignConfig(projectDir);
    expect(loaded.directory?.excludes).toContain('**/generic_dv/**');
    expect(loaded.directory?.excludes).toContain('**/autogen/**');
    expect(loaded.directory?.excludes).toContain('**/dv_sv/**');
    expect(loaded.directory?.excludes).toContain('**/tb/**');
    expect(loaded.directory?.excludes).toContain('**/verilator/**');
    // 用户原有的排除规则保留
    expect(loaded.directory?.excludes).toContain('**/dv/**');
    expect(loaded.directory?.excludes).toContain('**/vendor/**');
  });

  it('用户自定义排除规则不被覆盖', () => {
    const configDir = join(projectDir, '.socverify/design');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      getDesignConfigPath(projectDir),
      JSON.stringify({
        source: 'directory',
        filelists: [],
        directory: {
          root: 'hw',
          excludes: ['**/my_custom/**', '**/dv/**'],
          incdirs: [],
          defines: [],
        },
        top: 'top',
      }),
      'utf-8',
    );
    const loaded = loadDesignConfig(projectDir);
    expect(loaded.directory?.excludes).toContain('**/my_custom/**');
    expect(loaded.directory?.excludes).toContain('**/generic_dv/**');
  });
});
