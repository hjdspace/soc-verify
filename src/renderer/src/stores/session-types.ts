// ─── Session 类型定义 ─────────────────────────────────────
//
// 从 session.ts 拆分出的共享类型。三个 store（session-core / session-messages /
// session-approval）和所有消费者组件都从此文件 import 类型。

import type { ContextBreakdown, ContextUsage } from '@shared/context-management';
import type { AskQuestion } from '@shared/ask-types';
import type { ThinkingLevelSetting } from '@shared/types';

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

export type SessionComposer = {
  inputMessage: string;
  selectedSkills: SelectedSkill[];
  contextFiles: ContextFile[];
};

export interface SessionEntry {
  id: string;
  /** Live backend agent session ID. Empty until the agent process is started. */
  runtimeSessionId?: string;
  /** The original persisted sessionId — used to match against history entries */
  persistedSessionId?: string;
  projectId: string;
  /** Project root used when a lazy UI session needs to start/restore its agent. */
  cwd?: string;
  name: string;
  status: SessionStatus;
  messages: ChatMessage[];
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
}

export interface HistorySession {
  sessionId: string;
  ompSessionId?: string;
  name: string;
  projectId: string;
  createdAt: number;
  lastActivityAt: number;
  model?: { provider: string; id: string; name: string };
  isActive: boolean;
  contextUsage?: ContextUsage;
  contextBreakdown?: ContextBreakdown;
}
