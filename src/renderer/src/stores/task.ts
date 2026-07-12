import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';

export type TaskType = 'simulation' | 'ai' | 'regression' | 'coverage';

export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  type: TaskType;
  name: string;
  status: TaskStatus;
  progress: number; // 0-100
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  metadata?: Record<string, unknown>;
}

interface TaskStoreState {
  tasks: Task[];
  addTask: (task: Omit<Task, 'id' | 'createdAt'>) => string;
  updateTask: (taskId: string, updates: Partial<Omit<Task, 'id' | 'createdAt'>>) => void;
  removeTask: (taskId: string) => void;
  clearCompleted: () => void;
  cancelTask: (taskId: string) => Promise<void>;
  getTaskById: (taskId: string) => Task | undefined;
  getTasksByType: (type: TaskType) => Task[];
}

let taskIdCounter = 0;

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  tasks: [],

  addTask: (task) => {
    const id = `task_${Date.now()}_${++taskIdCounter}`;
    const newTask: Task = {
      ...task,
      id,
      createdAt: Date.now(),
    };
    set((s) => ({ tasks: [newTask, ...s.tasks] }));
    return id;
  },

  updateTask: (taskId, updates) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? { ...t, ...updates }
          : t,
      ),
    }));
  },

  removeTask: (taskId) => {
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== taskId),
    }));
  },

  clearCompleted: () => {
    set((s) => ({
      tasks: s.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled'),
    }));
  },

  cancelTask: async (taskId) => {
    const task = get().getTaskById(taskId);
    if (!task) return;

    if (task.type === 'ai') {
      // AI session is managed by session store
      const sessionStore = await import('./session');
      // Find the session associated with this task
      // This is a simplified approach - in real implementation, we'd link task to session
    } else if (task.type === 'simulation') {
      try {
        // simulation.abort requires projectId and runId
        const projectId = task.metadata?.projectId as string | undefined;
        if (projectId) {
          await trpc.simulation.abort.mutate({ projectId, runId: task.id });
        }
        get().updateTask(taskId, { status: 'cancelled', finishedAt: Date.now(), progress: 0 });
      } catch (err) {
        useToastStore.getState().error('取消任务失败', err instanceof Error ? err.message : String(err));
      }
    }
  },

  getTaskById: (taskId) => {
    return get().tasks.find((t) => t.id === taskId);
  },

  getTasksByType: (type) => {
    return get().tasks.filter((t) => t.type === type);
  },
}));