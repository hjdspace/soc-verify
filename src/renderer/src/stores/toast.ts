import { create } from 'zustand';

export type ToastType = 'error' | 'info' | 'success';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  detail?: string;
  timestamp: number;
}

interface ToastState {
  toasts: ToastItem[];
  addToast: (type: ToastType, message: string, detail?: string) => void;
  removeToast: (id: string) => void;
  error: (message: string, detail?: string) => void;
  info: (message: string, detail?: string) => void;
  success: (message: string, detail?: string) => void;
}

let toastIdCounter = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (type, message, detail) => {
    const id = `toast_${++toastIdCounter}`;
    const toast: ToastItem = { id, type, message, detail, timestamp: Date.now() };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    // Auto-remove after 6 seconds for non-error, 10 seconds for error
    const timeout = type === 'error' ? 10000 : 6000;
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, timeout);
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  error: (message, detail) => {
    console.error(`[Toast Error] ${message}`, detail);
    set((s) => {
      const id = `toast_${++toastIdCounter}`;
      const toast: ToastItem = { id, type: 'error', message, detail, timestamp: Date.now() };
      setTimeout(() => {
        set((s2) => ({ toasts: s2.toasts.filter((t) => t.id !== id) }));
      }, 10000);
      return { toasts: [...s.toasts, toast] };
    });
  },
  info: (message, detail) => {
    set((s) => {
      const id = `toast_${++toastIdCounter}`;
      const toast: ToastItem = { id, type: 'info', message, detail, timestamp: Date.now() };
      setTimeout(() => {
        set((s2) => ({ toasts: s2.toasts.filter((t) => t.id !== id) }));
      }, 6000);
      return { toasts: [...s.toasts, toast] };
    });
  },
  success: (message, detail) => {
    set((s) => {
      const id = `toast_${++toastIdCounter}`;
      const toast: ToastItem = { id, type: 'success', message, detail, timestamp: Date.now() };
      setTimeout(() => {
        set((s2) => ({ toasts: s2.toasts.filter((t) => t.id !== id) }));
      }, 6000);
      return { toasts: [...s.toasts, toast] };
    });
  },
}));
