import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X, Loader2 } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  const v: Record<Variant, string> = {
    primary: 'bg-accent text-accent-fg hover:brightness-110 font-semibold',
    secondary: 'bg-surface-2 text-fg hover:bg-surface-3 border border-line',
    ghost: 'text-muted hover:text-fg hover:bg-surface-2',
    danger: 'bg-bad/90 text-white hover:bg-bad font-semibold',
  };
  const s = size === 'sm' ? 'px-2.5 py-1 text-xs gap-1 min-h-10 min-w-10 sm:min-h-0 sm:min-w-0' : 'px-3.5 py-2 text-sm gap-1.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0';
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center justify-center rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed ${v[variant]} ${s} ${className}`}
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-muted text-sm py-6 justify-center" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="rounded-lg border border-bad/40 bg-bad/10 text-bad px-3 py-2 text-sm">{msg}</div>;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-surface p-4 ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 mb-3">
          {title && <h2 className="font-semibold text-sm tracking-wide uppercase text-muted">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-fg';
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 min-w-0">
      <div className="text-xs text-muted truncate">{label}</div>
      <div className={`text-xl font-semibold tabular-nums mt-0.5 truncate ${color}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={`backdrop:bg-black/70 bg-surface text-fg border border-line rounded-2xl p-0 max-h-[90vh] m-auto`}
      style={{ width: `min(calc(100vw - 1rem), ${wide ? '56rem' : '36rem'})` }}
    >
      {open && (
        <div className="flex flex-col max-h-[90vh]">
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-line">
            <h2 className="font-semibold text-lg truncate">{title}</h2>
            <button className="p-1.5 rounded-lg hover:bg-surface-2 text-muted" onClick={onClose} aria-label="Close">
              <X className="size-5" />
            </button>
          </div>
          <div className="overflow-y-auto p-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="block text-muted text-xs mb-1">{label}</span>
      {children}
      {hint && <span className="block text-muted text-xs mt-1">{hint}</span>}
    </label>
  );
}

export const inputCls = 'w-full rounded-lg bg-surface-2 border border-line px-3 py-2 text-base sm:text-sm focus:border-accent outline-none';

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface p-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 text-sm rounded-md transition ${value === o.value ? 'bg-surface-3 text-fg font-medium' : 'text-muted hover:text-fg'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ProgressBar({ value, tone = 'info' }: { value: number; tone?: 'info' | 'ok' | 'warn' | 'bad' }) {
  const c = { info: 'bg-info', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad' }[tone];
  return (
    <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${c} transition-all`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function StatusDot({ status }: { status: 'ok' | 'warn' | 'error' | 'unknown' }) {
  const c = { ok: 'bg-ok', warn: 'bg-warn', error: 'bg-bad', unknown: 'bg-muted' }[status];
  return <span className={`inline-block size-2.5 rounded-full ${c} shrink-0`} aria-label={status} />;
}

export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {sub && <p className="text-muted text-sm mt-1">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
