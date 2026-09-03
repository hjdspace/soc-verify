// @vitest-environment jsdom
/**
 * 会话 tab 切换性能回归测试（数据驱动）。
 *
 * 数据来源：真实会话文件 session_1788412811468_0uolwv.json（649KB / 58 条消息，
 * 31 条 tool 消息、3 条 write(drawio 227/255/253 行)、read(README.md 309 行)）。
 *
 * 修复前的测量数据（jsdom 基准）：
 *   切到重会话 7782ms —— 两大根因：
 *   1. ToolRunRow/ToolCard 折叠态仍挂载展开体（grid 0fr 收起≠不渲染），
 *      WriteBody/ReadBody 逐行 CodeHighlight 全部执行；
 *   2. CodeHighlight 对无语言单行走 hljs.highlightAuto（全语言探测，
 *      实测 13.3ms/行），3×write + read ≈ 6.3s。
 * 修复后：折叠不挂载 + 单行不做 highlightAuto → 同场景 <1s（机器相关，
 * 断言阈值放宽到 3s，只拦截秒级卡顿回归；工具卡展开体挂载内容不在
 * 初次渲染路径中）。
 *
 * 依赖仓库真实数据文件，数据缺失时跳过而非失败（其他机器 clone 后
 * .socverify 内容不同）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

// jsdom 未实现 scrollIntoView（自动滚动 effect 依赖）
Element.prototype.scrollIntoView = vi.fn();

// visual 组件渲染 canvas 消耗大且与瓶颈无关 —— 用轻量 stub 隔离
vi.mock('@renderer/components/visual', () => ({
  ThinkingOrb: () => createElement('span', { 'data-testid': 'orb' }),
  BorderBeam: ({ children }: { children?: React.ReactNode }) => createElement('div', null, children),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    session: {
      create: { mutate: vi.fn().mockResolvedValue({ sessionId: 's1' }) },
      send: { mutate: vi.fn().mockResolvedValue(undefined) },
      restore: { mutate: vi.fn().mockResolvedValue({ sessionId: 'rt' }) },
      listSkills: { query: vi.fn().mockResolvedValue([]) },
      listHistory: { query: vi.fn().mockResolvedValue([]) },
      getStoredMessages: { query: vi.fn().mockResolvedValue([]) },
      saveStoredMessages: { mutate: vi.fn().mockResolvedValue(undefined) },
      deleteHistorySession: { mutate: vi.fn().mockResolvedValue(undefined) },
      generateFollowUps: { mutate: vi.fn().mockResolvedValue({ followUps: [] }) },
      rename: { mutate: vi.fn().mockResolvedValue(undefined) },
      setModel: { mutate: vi.fn().mockResolvedValue(undefined) },
      destroy: { mutate: vi.fn().mockResolvedValue(undefined) },
      getState: { query: vi.fn().mockResolvedValue({}) },
    },
    project: {
      searchFiles: { query: vi.fn().mockResolvedValue([]) },
      pickFiles: { mutate: vi.fn().mockResolvedValue({ canceled: true }) },
      pickFolder: { mutate: vi.fn().mockResolvedValue({ canceled: true }) },
    },
    system: { openExternal: { mutate: vi.fn() } },
  },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: { getState: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));

import { useSessionCoreStore } from '@renderer/stores/session-core';
import type { ChatMessage, SessionEntry } from '@renderer/stores/session-types';
import { RightPanelContent } from '@renderer/components/layout/RightPanel';

const SESSION_FILE = join(process.cwd(), '.socverify', 'chat-messages', 'session_1788412811468_0uolwv.json');
const HEAVY_ID = 'session_1788412811468_0uolwv';
const LIGHT_ID = 'session_1788413850724_6plemf';

function makeSession(id: string, name: string, msgs: ChatMessage[]): SessionEntry {
  return {
    id,
    persistedSessionId: id,
    projectId: 'proj_bench',
    cwd: 'D:/doc/AI/soc-verify',
    name,
    status: 'idle',
    messages: msgs,
    composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
    createdAt: Date.now(),
  };
}

const heavyMessages = existsSync(SESSION_FILE)
  ? (JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as ChatMessage[])
  : null;

describe.skipIf(!heavyMessages)('会话 tab 切换性能（真实 649KB 会话数据）', () => {
  it('从轻会话切到重会话（649KB/58msg）不出现秒级卡顿', async () => {
    const heavySession = makeSession(HEAVY_ID, '询问身份', heavyMessages!);
    const lightSession = makeSession(LIGHT_ID, '项目技能不符问题', [
      { id: 'u1', role: 'user', content: '项目技能不符问题', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '好的，我来检查。', timestamp: 2 },
    ]);

    useSessionCoreStore.setState({
      sessions: [heavySession, lightSession],
      currentSessionId: LIGHT_ID,
      historySessions: [],
      historyLoading: false,
    });

    // 挂载轻会话（基准对照）
    const { unmount, rerender } = render(createElement(RightPanelContent));

    // 用户卡顿场景：切到重会话
    const t1 = performance.now();
    useSessionCoreStore.getState().switchSession(HEAVY_ID);
    rerender(createElement(RightPanelContent));
    const switchToHeavyMs = performance.now() - t1;

    // 用户真实操作是「来回切换」：第二次访问同一会话时已落定 Markdown
    // 命中内容级元素缓存，切换成本应显著低于首次（冷缓存 parse 全量）
    const t1b = performance.now();
    useSessionCoreStore.getState().switchSession(LIGHT_ID);
    rerender(createElement(RightPanelContent));
    useSessionCoreStore.getState().switchSession(HEAVY_ID);
    rerender(createElement(RightPanelContent));
    const switchBackToHeavyMs = performance.now() - t1b;

    // 无关状态变化（另一会话的 composer 更新）不应重渲染重会话气泡列
    const t2 = performance.now();
    useSessionCoreStore.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === LIGHT_ID
          ? { ...sess, composer: { ...sess.composer, inputMessage: 'x' } }
          : sess,
      ),
    }));
    rerender(createElement(RightPanelContent));
    const irrelevantRerenderMs = performance.now() - t2;

    console.log(
      `[PERF] 切到重会话=${switchToHeavyMs.toFixed(0)}ms 切回重会话=${switchBackToHeavyMs.toFixed(0)}ms 无关重渲染=${irrelevantRerenderMs.toFixed(0)}ms`,
    );

    unmount();

    // 修复前：切到重会话 7782ms。阈值 3s：CI/开发机波动余量，只拦秒级回归。
    expect(switchToHeavyMs).toBeLessThan(3000);
    // 缓存生效：来回切（轻→重）不重复 parse 已落定 Markdown，暖切换应
    // 明显低于冷切换；阈值 0.8× 冷切换，机器波动余量下仍能拦住缓存失效
    expect(switchBackToHeavyMs).toBeLessThan(switchToHeavyMs * 0.8);
    // memo 生效：无关更新远低于整体切换成本
    expect(irrelevantRerenderMs).toBeLessThan(500);
  }, 30000);
});
