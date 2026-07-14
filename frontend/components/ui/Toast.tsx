// components/ui/Toast.tsx
'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { generateId } from '@/lib/utils';
import type { ToastMessage, ToastType } from '@/lib/types';

interface ToastContextValue {
  toasts: ToastMessage[];
  addToast: (toast: Omit<ToastMessage, 'id'>) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DURATION_BY_TYPE: Record<ToastType, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 8000,
};

const STYLE_BY_TYPE: Record<ToastType, string> = {
  success: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  info: 'bg-blue-50 border-blue-200 text-blue-900',
  warning: 'bg-amber-50 border-amber-200 text-amber-900',
  error: 'bg-red-50 border-red-200 text-red-900',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (toast: Omit<ToastMessage, 'id'>) => {
      const id = generateId();
      const duration = toast.duration ?? DURATION_BY_TYPE[toast.type];
      setToasts((prev) => [...prev, { ...toast, id, duration }]);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, dismiss }}>
      {children}
      <div className="pointer-events-none fixed top-4 right-4 z-50 flex flex-col gap-2 w-80">
        {toasts.map((t) => (
          <ToastToast key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastToast({ toast, onDismiss }: { toast: ToastMessage; onDismiss: () => void }) {
  const [visible] = useState(false);
  return (
    <div
      className={`pointer-events-auto border rounded-md shadow-md p-3 text-sm transition-opacity ${STYLE_BY_TYPE[toast.type]} ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      role="status"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{toast.title}</p>
          {toast.message && <p className="mt-0.5">{toast.message}</p>}
        </div>
        <button type="button" className="text-xs opacity-60 hover:opacity-100" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}