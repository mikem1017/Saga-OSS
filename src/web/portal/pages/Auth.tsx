import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { get, post, setCsrf } from '../api.ts';
import { Button, ErrorBox, inputCls } from '../../components/ui.tsx';

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6">
        <div className="flex items-center gap-2 mb-5">
          <img src="/icon.svg" alt="" className="size-9" />
          <div>
            <div className="font-bold text-lg leading-tight">Saga Requests</div>
            <div className="text-xs text-muted">Ask for films and shows for the Plex server</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function useFinish() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (res: { csrf: string }, next: string | null) => {
    setCsrf(res.csrf);
    qc.invalidateQueries({ queryKey: ['me'] });
    navigate(next && next.startsWith('/') ? next : '/', { replace: true });
  };
}

function PlexButton({ invite, next }: { invite?: string; next?: string | null }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="primary"
      className="w-full"
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const { authUrl } = await post<{ pinId: number; authUrl: string }>('/auth/plex/pin', { invite, next: next ?? undefined });
          window.location.href = authUrl;
        } catch {
          setBusy(false);
        }
      }}
    >
      Sign in with Plex
    </Button>
  );
}

function EmailLink() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  if (sent) return <p className="text-sm text-muted">If that address has an invite, a sign-in link is on its way. It works once, for 20 minutes.</p>;
  return (
    <form
      className="flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await post('/auth/magic/request', { email });
          setSent(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input type="email" required className={inputCls} placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email address" />
      <Button type="submit" busy={busy} aria-label="Email me a link">
        <Mail className="size-4" />
      </Button>
    </form>
  );
}

/** /login, and the landing page Plex sends people back to (?pin=…). */
export function LoginPage() {
  const [sp] = useSearchParams();
  const pin = sp.get('pin');
  const invite = sp.get('invite') ?? undefined;
  const next = sp.get('next');
  const finish = useFinish();
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(!!pin);
  const started = useRef(false);

  useEffect(() => {
    if (!pin || started.current) return;
    started.current = true;
    let stop = false;
    const deadline = Date.now() + 2 * 60_000;
    (async () => {
      while (!stop && Date.now() < deadline) {
        try {
          const res = await post<{ pending?: boolean; ok?: boolean; csrf?: string }>('/auth/plex/check', { pinId: Number(pin), invite }, true);
          if (res.ok && res.csrf) return finish({ csrf: res.csrf }, next);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setWaiting(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (!stop) {
        setError('Plex sign-in timed out. Try again.');
        setWaiting(false);
      }
    })();
    return () => {
      stop = true;
    };
  }, [pin, invite, next, finish]);

  return (
    <Shell>
      {waiting ? (
        <p className="text-sm text-muted">Finishing your Plex sign-in…</p>
      ) : (
        <div className="space-y-4">
          {error && <ErrorBox error={error} />}
          <PlexButton invite={invite} next={next} />
          <div className="text-xs text-muted text-center">or, if you were invited by email</div>
          <EmailLink />
          <p className="text-xs text-muted">Saga Requests is invite-only. If you don't have access, ask the person who runs this server for an invite link.</p>
        </div>
      )}
    </Shell>
  );
}

export function InvitePage() {
  const { code = '' } = useParams();
  const { data, isLoading } = useQuery({ queryKey: ['invite', code], queryFn: () => get<{ valid: boolean; email: string | null }>(`/auth/invite/${encodeURIComponent(code)}`, true) });
  return (
    <Shell>
      {isLoading ? (
        <p className="text-sm text-muted">Checking your invite…</p>
      ) : data?.valid ? (
        <div className="space-y-4">
          <p className="text-sm">You've been invited. Sign in with your Plex account to start asking for things to watch.</p>
          <PlexButton invite={code} />
          {data.email && (
            <>
              <div className="text-xs text-muted text-center">no Plex account? get a link at {data.email}</div>
              <EmailLink />
            </>
          )}
        </div>
      ) : (
        <ErrorBox error="This invite link has been used, has expired, or was revoked. Ask the person who invited you for a new one." />
      )}
    </Shell>
  );
}

export function MagicPage() {
  const [sp] = useSearchParams();
  const finish = useFinish();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  useEffect(() => {
    const token = sp.get('token');
    if (!token || done.current) return;
    done.current = true;
    post<{ csrf: string }>('/auth/magic/redeem', { token }, true)
      .then((res) => finish(res, '/'))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [sp, finish]);
  return <Shell>{error ? <ErrorBox error={error} /> : <p className="text-sm text-muted">Signing you in…</p>}</Shell>;
}
