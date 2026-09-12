import type { ChatMessage, SubagentActivity } from '@renderer/stores/session-types';
import { argStr, extractResultText, getToolDetails } from '@renderer/components/chat/tool-helpers';
import { SubagentCard } from '@renderer/components/chat/SubagentCard';
import { SubagentManagementBody } from './SubagentManagementBody';
import { GenericBody } from '../shared/GenericBody';

export type PiSubagentMode = 'single' | 'parallel' | 'chain' | 'workflow' | 'management';

export type PiSubagentPresentation = {
  mode: PiSubagentMode;
  activities: SubagentActivity[];
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function modeFrom(message: ChatMessage, details: Record<string, unknown> | null): PiSubagentMode {
  if (argStr(message.toolArgs, 'action')) return 'management';
  const mode = details?.mode;
  if (mode === 'single' || mode === 'parallel' || mode === 'chain' || mode === 'workflow' || mode === 'management') {
    return mode;
  }
  if (argStr(message.toolArgs, 'workflow', 'workflowScript', 'workflowScriptPath')) return 'workflow';
  return 'single';
}

function resultActivity(
  result: Record<string, unknown>,
  resultIndex: number,
  message: ChatMessage,
  runId: string,
): SubagentActivity {
  const progress = record(result.progress);
  const usage = record(result.usage);
  const index = number(result.index) ?? resultIndex;
  const stopped = result.stopped === true || result.interrupted === true;
  const running = result.detached === true;
  const exitCode = number(result.exitCode);
  const failed = string(result.error) !== undefined || (exitCode !== undefined && exitCode !== 0);
  const status: SubagentActivity['status'] = stopped
    ? 'aborted'
    : running
      ? 'running'
      : failed
        ? 'failed'
        : 'completed';
  const input = number(usage?.input) ?? 0;
  const output = number(usage?.output) ?? 0;
  const cacheRead = number(usage?.cacheRead) ?? 0;
  const cacheWrite = number(usage?.cacheWrite) ?? 0;
  const turns = number(usage?.turns) ?? number(progress?.turnCount) ?? 0;
  const toolCount = number(progress?.toolCount)
    ?? (Array.isArray(result.toolCalls) ? result.toolCalls.length : 0);
  const durationMs = number(progress?.durationMs)
    ?? (message.toolStartTime && message.toolEndTime ? message.toolEndTime - message.toolStartTime : 0);
  const endedAt = message.toolEndTime ?? Date.now();
  const recentProgress = Array.isArray(progress?.recentOutput)
    ? progress.recentOutput.filter((line): line is string => typeof line === 'string')
    : [];
  const finalOutput = string(result.finalOutput);
  const recentOutput = (finalOutput ? finalOutput.split('\n') : recentProgress).slice(-500);

  return {
    id: `${runId}:${index}`,
    index,
    agent: string(result.agent) ?? 'subagent',
    description: string(result.sessionName),
    assignment: string(result.task),
    status,
    parentToolCallId: message.toolCallId,
    currentTool: status === 'running' ? string(progress?.currentTool) : undefined,
    recentOutput,
    toolCount,
    tokens: number(progress?.tokens) ?? input + output,
    requests: turns,
    tokenHistory: [],
    startedAt: message.toolStartTime ?? endedAt - durationMs,
    endedAt: status === 'running' ? undefined : endedAt,
    blockedReason: status === 'failed' ? string(result.error) : undefined,
    usage: usage
      ? {
          input,
          output,
          cacheRead,
          cacheWrite,
          costUsd: number(usage.cost) ?? 0,
          turns,
          toolCalls: toolCount,
          durationMs,
        }
      : undefined,
  };
}

export function getPiSubagentPresentation(message: ChatMessage): PiSubagentPresentation {
  const details = getToolDetails(message.toolResult);
  const mode = modeFrom(message, details);
  if (mode === 'management') return { mode, activities: [] };

  const runId = string(details?.runId) ?? string(details?.asyncId) ?? message.toolCallId ?? message.id;
  const results = Array.isArray(details?.results)
    ? details.results.map(record).filter((item): item is Record<string, unknown> => item !== null)
    : [];
  if (results.length > 0) {
    return {
      mode,
      activities: results.map((result, index) => resultActivity(result, index, message, runId)),
    };
  }

  const isExecuting = message.toolResult === undefined;
  const asyncId = string(details?.asyncId);
  if (!isExecuting && !asyncId) return { mode, activities: [] };

  const args = record(message.toolArgs);
  return {
    mode,
    activities: [{
      id: asyncId ?? message.toolCallId ?? message.id,
      index: 0,
      agent: string(args?.agent) ?? string(args?.workflow) ?? (mode === 'workflow' ? 'workflow' : 'subagent'),
      assignment: string(args?.task),
      status: 'running',
      parentToolCallId: message.toolCallId,
      runDir: string(details?.asyncDir),
      recentOutput: [],
      toolCount: 0,
      tokens: 0,
      requests: 0,
      tokenHistory: [],
      startedAt: message.toolStartTime ?? Date.now(),
    }],
  };
}

export function resolvePiSubagentActivities(
  presentation: PiSubagentPresentation,
  liveSubagents: SubagentActivity[],
): SubagentActivity[] {
  if (presentation.mode === 'management') return [];
  if (liveSubagents.length === 0) return presentation.activities;
  if (presentation.activities.length === 0) return liveSubagents;
  if (
    presentation.activities.length === 1
    && presentation.activities[0]?.id === liveSubagents[0]?.parentToolCallId
  ) {
    // 单代理直替换分支：live 全量覆盖运行态，但任务概要只存在于派遣参数快照
    // （args.task，progress/lifecycle 帧的 task 字段被 pi-subagents redact），
    // 必须回填，否则行卡片任务概要随首帧到达后清空
    const snapshot = presentation.activities[0];
    return liveSubagents.map((live) => ({
      ...live,
      // 帧活动的 startedAt 是首帧到达时刻，回填派遣时刻保证时长从 0 计
      startedAt: snapshot.startedAt,
      assignment: live.assignment ?? snapshot.assignment,
      description: live.description ?? snapshot.description,
    }));
  }

  const snapshots = new Map(presentation.activities.map((activity) => [activity.id, activity]));
  const merged = liveSubagents.map((live) => {
    const snapshot = snapshots.get(live.id)
      ?? presentation.activities.find((candidate) => candidate.index === live.index && candidate.agent === live.agent);
    if (!snapshot) return live;
    snapshots.delete(snapshot.id);
    return {
      ...snapshot,
      ...live,
      description: live.description ?? snapshot.description,
      assignment: live.assignment ?? snapshot.assignment,
      recentOutput: live.recentOutput.length > 0 ? live.recentOutput : snapshot.recentOutput,
      usage: live.usage ?? snapshot.usage,
      blockedReason: live.blockedReason ?? snapshot.blockedReason,
    };
  });
  return [...merged, ...snapshots.values()];
}

export function SubagentBody({
  message,
  liveSubagents,
}: {
  message: ChatMessage;
  liveSubagents: SubagentActivity[];
}) {
  const presentation = getPiSubagentPresentation(message);
  // 管理操作（action=list/status/resume/...）：结构化操作卡片，不走 JSON 兜底
  if (presentation.mode === 'management') return <SubagentManagementBody message={message} />;
  const activities = resolvePiSubagentActivities(presentation, liveSubagents);
  if (activities.length > 0) return <SubagentCard agents={activities} />;
  return <GenericBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
