// ─── Session 类型定义 ─────────────────────────────────────
//
// 从 session.ts 拆分出的共享类型。三个 store（session-core / session-messages /
// session-approval）和所有消费者组件都从此文件 import 类型。

import type { ContextBreakdown, ContextUsage } from '@shared/context-management';
import type { AskQuestion } from '@shared/ask-types';
import type { ThinkingLevelSetting } from '@shared/types';
import type { SubagentUsageSummary } from '@shared/agent-events';

export type SessionStatus = 'creating' | 'idle' | 'streaming' | 'tool_executing' | 'error';

export type ApprovalMode = 'always-ask' | 'write' | 'yolo';

export interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  args: unknown;
  timestamp: number;
}

export interface AskRequest {
  requestId: string;
  sessionId: string;
  questions: AskQuestion[];
  timestamp: number;
}

/**
 * 信任请求（issue 04）——独立于审批模式的权限边界：
 * 项目 extension 首次加载（project-extension）与 MCP server 首次启动
 * （mcp-server）必须经用户确认。
 */
export interface TrustRequest {
  requestId: string;
  sessionId: string;
  kind: 'project-extension' | 'mcp-server';
  name: string;
  path?: string;
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  /** Snapshot captured before a file-writing tool starts. */
  toolFileExistedBefore?: boolean;
  toolBeforeContent?: string;
  toolStartTime?: number;
  toolEndTime?: number;
  images?: string[];
  isStreaming?: boolean;
  /** LLM thinking/reasoning content, separated from the main response text. */
  thinking?: string;
  /** Skills attached to a user message — used to render skill chips in the message bubble. */
  skills?: SelectedSkill[];
  /**
   * 挂起中的 LLM 错误文本（message_end 捕获、agent_end 定稿）。
   * 会话级自动重试仍有时不渲染错误卡片；重试预算耗尽后的最终 agent_end
   * 才把它定稿为 `[错误] ...` 内容展示。
   */
  pendingError?: string;
  /** 划选「添加到当前任务」附带的对话引用——气泡内渲染只读引用 chip */
  quotes?: SessionQuote[];
}

/**
 * task 工具派遣的 subagent 实时状态（瞬态，不持久化）。
 * 由 omp 引擎经 runner → 主进程 → session:event 转发的
 * subagent_lifecycle / subagent_progress 帧驱动更新。
 */
export interface SubagentActivity {
  /** subagent registry id */
  id: string;
  index: number;
  /** 角色（agent 定义名，如 coverage-analyzer） */
  agent: string;
  description?: string;
  /** 完整工作指令（progress 帧携带） */
  assignment?: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  /** 关联的 task 工具调用 id — 用于挂载到对应 tool card */
  parentToolCallId?: string;
  currentTool?: string;
  currentToolArgs?: string;
  lastIntent?: string;
  /**
   * 累积输出日志（正序，[length-1] 为最新）。
   * omp 的 progress 帧只携带"当前轮 assistant 流式输出的尾部 8 行"预览窗口
   * （倒序，且每轮 message_start 会被引擎清空），这里经滚动窗口合并成
   * 完整运行日志，避免新一轮开始时旧内容被冲掉。
   */
  recentOutput: string[];
  toolCount: number;
  tokens: number;
  requests: number;
  /** token 增量历史（sparkline 用，保留尾部若干个） */
  tokenHistory: number[];
  startedAt: number;
  endedAt?: number;
  /** 父引擎会话 id（pi 父子归属，issue 05） */
  parentSessionId?: string;
  /** subagent run 生命周期目录（status/events 等 run 产物） */
  runDir?: string;
  /** 能力不足/失败的显式阻断原因 */
  blockedReason?: string;
  /** 终态 Token 用量汇总（父子归属） */
  usage?: SubagentUsageSummary;
}

export interface AvailableModel {
  provider: string;
  id: string;
  name: string;
  description?: string;
}

export interface SessionModel {
  provider: string;
  id: string;
  name: string;
  /** The credential ID used to look up apiKey/baseUrl for this model.
   *  When set, switching to this model also switches the full provider config. */
  providerId?: string;
}

export interface SelectedSkill {
  name: string;
  description: string;
  filePath: string;
  source: 'project' | 'user' | 'builtin';
}

export interface ContextFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

/** 划选「添加到当前任务」产生的对话引用（瞬态，不持久化） */
export type SessionQuote = {
  id: string;
  /** 引用的原文（trim 后非空） */
  text: string;
  /** 来源标注，如「引用自你的回复」/「引用自文件 <path>」 */
  source: string;
  createdAt: number;
};

export type SessionComposer = {
  inputMessage: string;
  selectedSkills: SelectedSkill[];
  contextFiles: ContextFile[];
  /** 待发送的对话引用（发送后随 composer 一起清空） */
  quotes?: SessionQuote[];
};

export interface SessionEntry {
  id: string;
  /** Live backend agent session ID. Empty until the agent process is started. */
  runtimeSessionId?: string;
  /** The original persisted sessionId — used to match against history entries */
  persistedSessionId?: string;
  /**
   * 持久化 cwd 不可访问（issue 07）：会话只能查看 transcript，Agent 不可用。
   * 恢复时由后端 degraded 结果置位；用户经 rebindSessionCwd 选择新 cwd 后清除。
   */
  transcriptOnlyCwd?: string;
  projectId: string;
  /** Project root used when a lazy UI session needs to start/restore its agent. */
  cwd?: string;
  name: string;
  status: SessionStatus;
  messages: ChatMessage[];
  /**
   * 消息未加载标记：restoreSessions 只为当前 tab 加载消息，其余恢复的
   * tab 消息为空数组、此标记为 true；切换到该 tab 时惰性拉取存储消息。
   * 用于避免项目打开时为所有 tab 全量拉取数百 KB 的消息文件（GUI 卡顿）。
   */
  messagesUnloaded?: boolean;
  composer: SessionComposer;
  createdAt: number;
  model?: SessionModel;
  contextUsage?: ContextUsage;
  contextBreakdown?: ContextBreakdown;
  isCompacting?: boolean;
  contextCompacted?: boolean;
  autoCompactionEnabled?: boolean;
  /** TV AI session: the violation ID this session is analyzing. */
  tvViolationId?: number;
  /** 工具审批模式 */
  approvalMode?: ApprovalMode;
  /** 思考强度设置（'default'/缺省 = 跟随 omp 引擎默认） */
  thinkingLevel?: ThinkingLevelSetting;
  /** task 工具派遣的 subagent 实时状态（key = subagent id，瞬态不持久化） */
  subagents?: Record<string, SubagentActivity>;
  /** 建议追问（回合结束后由轻量 LLM 生成，瞬态不持久化，仅最后一条助手消息呈现） */
  followUps?: string[];
  /** 瞬态会话标记：划选查阅型动作（翻译/解释）创建的后台会话，不在 tab 列表中显示，回合结束后自动清理 */
  transient?: boolean;
}

export interface HistorySession {
  sessionId: string;
  engineSessionId?: string;
  name: string;
  projectId: string;
  createdAt: number;
  lastActivityAt: number;
  model?: { provider: string; id: string; name: string };
  isActive: boolean;
  contextUsage?: ContextUsage;
  contextBreakdown?: ContextBreakdown;
}
