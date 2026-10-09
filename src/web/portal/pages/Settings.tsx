import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post } from '../api.ts';
import { useMe } from '../App.tsx';
import { Button, Card, Field, Toggle, inputCls } from '../../components/ui.tsx';
import { useToast } from '../../components/toast.tsx';
import { bytes, relTime } from '../../format.ts';
import { currentSubscription, enablePush, pushSupported } from '../../push.ts';

function Meter({ label, used, limit, unit }: { label: string; used: number; limit: number; unit?: string }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 100;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="text-muted tabular-nums">
          {used.toLocaleString()} / {limit.toLocaleString()}
          {unit}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-3 mt-1 overflow-hidden">
        <div className={`h-full ${pct >= 100 ? 'bg-bad' : pct > 75 ? 'bg-warn' : 'bg-ok'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { me, refresh } = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const [url, setUrl] = useState(me?.watchlist.url ?? '');
  useEffect(() => {
    setUrl(me?.watchlist.url ?? '');
  }, [me?.watchlist.url]);
  const { data: cfg } = useQuery({ queryKey: ['portal-config'], queryFn: () => get<{ vapidPublicKey: string | null }>('/config') });
  const [pushOn, setPushOn] = useState(false);
  useEffect(() => {
    currentSubscription().then((s) => setPushOn(!!s));
  }, []);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch('/me', body),
    onSuccess: () => {
      toast('Saved', 'ok');
      refresh();
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  if (!me) return null;
  const GB = 1024 ** 3;
  return (
    <div className="space-y-5 max-w-xl">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <Card title="Your limits">
        {me.unlimited ? (
          <p className="text-sm">No limits on your account, and your requests are approved straight away.</p>
        ) : (
        <div className="space-y-3">
          <Meter label="Films this week" used={me.usage.moviesWeek} limit={me.limits.moviesPerWeek} />
          <Meter label="TV seasons this week" used={me.usage.seasonsWeek} limit={me.limits.seasonsPerWeek} />
          <Meter label="Download size this month" used={Math.round(me.usage.bytesMonth / GB)} limit={me.limits.gbPerMonth} unit=" GB" />
          <p className="text-xs text-muted">
            Limits roll over: each request stops counting 7 days (or 30 days for size) after you made it. Things someone else already asked for don't count.
            {me.autoApproveAll ? ' Your requests are approved straight away.' : me.limits.autoApproveGb > 0 && ` Requests under ${me.limits.autoApproveGb} GB are approved straight away.`}
          </p>
        </div>
        )}
      </Card>
      <Card title="Notifications">
        <div className="space-y-3">
          {pushSupported() && cfg?.vapidPublicKey ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm">Push notifications on this device</span>
              <Button
                size="sm"
                variant={pushOn ? 'secondary' : 'primary'}
                disabled={pushOn}
                onClick={async () => {
                  try {
                    const ok = await enablePush(cfg.vapidPublicKey!, (sub) => post('/push/subscribe', sub));
                    setPushOn(ok);
                    toast(ok ? 'Notifications on' : 'Notifications were blocked in your browser settings', ok ? 'ok' : 'error');
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), 'error');
                  }
                }}
              >
                {pushOn ? 'On' : 'Turn on'}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted">Push notifications aren't available here. On iPhone, add Saga Requests to your Home Screen (Share → Add to Home Screen) and open it from there.</p>
          )}
          {me.email ? (
            <Toggle checked={me.notifyEmail} onChange={(v) => save.mutate({ notifyEmail: v })} label={`Email me at ${me.email}`} />
          ) : (
            <p className="text-xs text-muted">No email address on your account, so no emails.</p>
          )}
        </div>
      </Card>
      <Card title="Watchlist sync">
        <p className="text-sm text-muted mb-3">
          Link a public Letterboxd, IMDb, MDBList or Trakt watchlist. Saga checks it every few hours and requests what's on it, within your limits.
        </p>
        <Field label="Watchlist link" hint={me.watchlist.syncedAt ? `Last checked ${relTime(me.watchlist.syncedAt)}: ${me.watchlist.note ?? ''}` : undefined}>
          <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://letterboxd.com/you/watchlist/" />
        </Field>
        <div className="flex gap-2 mt-2">
          <Button size="sm" variant="primary" busy={save.isPending} onClick={() => save.mutate({ watchlistUrl: url.trim() || null })}>
            Save
          </Button>
          {me.watchlist.url && (
            <Button size="sm" variant="ghost" onClick={() => save.mutate({ watchlistUrl: null })}>
              Unlink
            </Button>
          )}
        </div>
      </Card>
      <Card title="Account">
        <p className="text-sm mb-3">
          Signed in as <span className="font-medium">{me.username}</span>
          {me.role === 'kid' && ' (kids profile)'}. Used {bytes(me.usage.bytesMonth)} this month.
        </p>
        <Button
          size="sm"
          onClick={async () => {
            await post('/auth/logout');
            window.location.href = '/login';
          }}
        >
          Sign out
        </Button>
      </Card>
    </div>
  );
}
