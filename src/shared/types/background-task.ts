export type TaskType = 'simulation' | 'ai_session' | 'regression';
export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface BackgroundTask {
  id: string;
  name: string;
  type: TaskType;
  status: TaskStatus;
  progress: number;
  startedAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}
