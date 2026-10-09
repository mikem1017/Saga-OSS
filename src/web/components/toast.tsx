import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

type Tone = 'info' | 'ok' | 'error';
interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

const Ctx = createContext<(text: string, tone?: Tone) => void>(() => {});

export function useToast() {
  return useContext(Ctx);
}

let nextId = 1;

export function ToastProvider({ children, register }: { children: ReactNode; register?: (fn: (t: string, tone?: Tone) => void) => void }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Tone = 'info') => {
    const id = nextId++;
    setToasts((t) => [...t.filter((x) => x.text !== text).slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);
  register?.(push);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed z-50 bottom-20 md:bottom-4 right-4 left-4 md:left-auto flex flex-col gap-2 items-end pointer-events-none" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto max-w-md w-full md:w-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg bg-surface ${
              t.tone === 'error' ? 'border-bad/60 text-bad' : t.tone === 'ok' ? 'border-ok/50 text-ok' : 'border-line text-fg'
            }`}
            role={t.tone === 'error' ? 'alert' : 'status'}
          >
            <span className="flex-1">{t.text}</span>
            <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss" className="text-muted hover:text-fg">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
