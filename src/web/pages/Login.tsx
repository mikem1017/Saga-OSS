import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import type { Me } from '../../shared/types.ts';
import { api, ApiError, setCsrf } from '../api.ts';
import { useAuth } from '../App.tsx';
import { Button, inputCls } from '../components/ui.tsx';

export default function LoginPage() {
  const { me, setMe } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get('next') && params.get('next')!.startsWith('/') && !params.get('next')!.startsWith('//') ? params.get('next')! : '/';
  if (me) return <Navigate to={next} replace />;

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <form
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const res = await api<Me>('/auth/login', { method: 'POST', body: { username, password }, quiet: true });
            setCsrf(res.csrf);
            setMe(res);
            navigate(next, { replace: true });
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Sign-in failed');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex items-center gap-3 mb-2">
          <img src="/icon.svg" alt="" className="size-10" />
          <div>
            <h1 className="text-xl font-bold">Saga</h1>
            <p className="text-xs text-muted">Media stack control plane</p>
          </div>
        </div>
        <label className="block text-sm">
          <span className="text-muted text-xs">Username</span>
          <input className={`${inputCls} mt-1`} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </label>
        <label className="block text-sm">
          <span className="text-muted text-xs">Password</span>
          <input className={`${inputCls} mt-1`} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <p className="text-sm text-bad" role="alert">
            {error}
          </p>
        )}
        <Button variant="primary" className="w-full" busy={busy} type="submit">
          Sign in
        </Button>
      </form>
    </div>
  );
}
