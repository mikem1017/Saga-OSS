import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Trash2 } from 'lucide-react';
import { del, get, patch, post, put } from '../api.ts';
import { Button, Card, Field, Modal, PageHeader, Spinner, Toggle, inputCls } from '../components/ui.tsx';
import { useToast } from '../components/toast.tsx';
import { bytes, relTime } from '../format.ts';

interface Guest {
  id: number;
  username: string;
  email: string | null;
  thumb: string | null;
  role: 'guest' | 'kid';
  enabled: boolean;
  plexId: number | null;
  seerrUserId: number | null;
  limits: { moviesPerWeek: number; seasonsPerWeek: number; gbPerMonth: number; autoApproveGb: number };
  unlimited?: boolean;
  autoApproveAll?: boolean;
  overrides: { moviesPerWeek: number | null; seasonsPerWeek: number | null; gbPerMonth: number | null; autoApproveGb: number | null; ratingCap: string[] | null };
  usage: { moviesWeek: number; seasonsWeek: number; bytesMonth: number };
  requests: number;
  watchlistUrl: string | null;
  watchlistNote: string | null;
  lastSeenAt: number | null;
}

interface Invite {
  id: number;
  code: string;
  email: string | null;
  note: string | null;
  role: string;
  createdAt: number;
  expiresAt: number | null;
  redeemedAt: number | null;
  revokedAt: number | null;
  url: string;
}

interface PortalSettings {
  allowPlexFriends: boolean;
  defaults: { moviesPerWeek: number; seasonsPerWeek: number; gbPerMonth: number; autoApproveGb: number };
  kidRatings: string[];
  watchlistMaxPerRun: number;
  portalUrl: string;
  pushEnabled: boolean;
  emailEnabled: boolean;
}

const num = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.round(Number(v))));

function EditGuest({ g, onClose }: { g: Guest; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    role: g.role,
    unlimited: !!g.unlimited,
    autoApproveAll: !!g.autoApproveAll,
    moviesPerWeek: g.overrides.moviesPerWeek?.toString() ?? '',
    seasonsPerWeek: g.overrides.seasonsPerWeek?.toString() ?? '',
    gbPerMonth: g.overrides.gbPerMonth?.toString() ?? '',
    autoApproveGb: g.overrides.autoApproveGb?.toString() ?? '',
    ratingCap: g.overrides.ratingCap?.join(', ') ?? '',
  });
  const save = useMutation({
    mutationFn: () =>
      patch(`/guests/${g.id}`, {
        role: f.role,
        unlimited: f.unlimited,
        autoApproveAll: f.autoApproveAll,
        moviesPerWeek: num(f.moviesPerWeek),
        seasonsPerWeek: num(f.seasonsPerWeek),
        gbPerMonth: num(f.gbPerMonth),
        autoApproveGb: num(f.autoApproveGb),
        ratingCap: f.ratingCap.trim() ? f.ratingCap.split(',').map((s) => s.trim()).filter(Boolean) : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['guests'] });
      onClose();
    },
  });
  const set = (k: Exclude<keyof typeof f, 'unlimited' | 'autoApproveAll'>) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={`Limits for ${g.username}`}>
      <div className="mb-3 rounded-lg border border-line bg-surface-2 p-3">
        <Toggle checked={f.unlimited} onChange={(v) => setF({ ...f, unlimited: v })} label={<span className="font-medium">Unlimited</span>} />
        <p className="text-xs text-muted mt-1">No weekly or monthly limits, and every request is approved straight away. Your own account is always unlimited.</p>
        {!f.unlimited && (
          <div className="mt-3 pt-3 border-t border-line">
            <Toggle checked={f.autoApproveAll} onChange={(v) => setF({ ...f, autoApproveAll: v })} label={<span className="font-medium">Auto-approve everything</span>} />
            <p className="text-xs text-muted mt-1">Anything they request is approved straight away, with no approval queue. Their limits below still apply.</p>
          </div>
        )}
      </div>
      <p className="text-xs text-muted mb-3">{f.unlimited ? 'The limits below are ignored while Unlimited is on.' : 'Leave a box empty to use the portal default.'}</p>
      <div className={`grid grid-cols-2 gap-3 ${f.unlimited ? 'opacity-50' : ''}`}>
        <Field label="Profile">
          <select className={inputCls} value={f.role} onChange={set('role')}>
            <option value="guest">Guest</option>
            <option value="kid">Kid (rating capped)</option>
          </select>
        </Field>
        <Field label="Films / week">
          <input className={inputCls} inputMode="numeric" value={f.moviesPerWeek} onChange={set('moviesPerWeek')} placeholder={String(g.limits.moviesPerWeek)} />
        </Field>
        <Field label="TV seasons / week">
          <input className={inputCls} inputMode="numeric" value={f.seasonsPerWeek} onChange={set('seasonsPerWeek')} placeholder={String(g.limits.seasonsPerWeek)} />
        </Field>
        <Field label="GB / month">
          <input className={inputCls} inputMode="numeric" value={f.gbPerMonth} onChange={set('gbPerMonth')} placeholder={String(g.limits.gbPerMonth)} />
        </Field>
        <Field label="Auto-approve under (GB)" hint="0 = always ask me">
          <input className={inputCls} inputMode="numeric" value={f.autoApproveGb} onChange={set('autoApproveGb')} placeholder={String(g.limits.autoApproveGb)} />
        </Field>
        <Field label="Allowed ratings (optional)" hint="Empty = no limit on a Guest profile, or the kid list on a Kid profile">
          <input className={inputCls} value={f.ratingCap} onChange={set('ratingCap')} placeholder="No limit" />
        </Field>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
    </Modal>
  );
}

function Invites({ settings }: { settings?: PortalSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['invites'], queryFn: () => get<Invite[]>('/invites') });
  const [f, setF] = useState({ email: '', note: '', role: 'guest', expiresDays: '30', send: true });
  const create = useMutation({
    mutationFn: () => post<Invite & { sent: boolean }>('/invites', { email: f.email || null, note: f.note || null, role: f.role, expiresDays: Number(f.expiresDays) || null, send: f.send && !!f.email }),
    onSuccess: (inv) => {
      navigator.clipboard?.writeText(inv.url).catch(() => {});
      toast(inv.sent ? `Invite emailed to ${inv.email}; link copied` : 'Invite link copied', 'ok');
      setF({ ...f, email: '', note: '' });
      qc.invalidateQueries({ queryKey: ['invites'] });
    },
  });
  const revoke = useMutation({ mutationFn: (id: number) => del(`/invites/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['invites'] }) });
  const live = (data ?? []).filter((i) => !i.redeemedAt && !i.revokedAt && !(i.expiresAt && i.expiresAt < Date.now()));
  return (
    <Card title="Invites">
      <div className="grid sm:grid-cols-[1fr_1fr_auto_auto_auto] gap-2 items-end mb-3">
        <Field label="Email (optional)">
          <input className={inputCls} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="friend@example.com" />
        </Field>
        <Field label="Note">
          <input className={inputCls} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Neighbours" />
        </Field>
        <Field label="Profile">
          <select className={inputCls} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="guest">Guest</option>
            <option value="kid">Kid</option>
          </select>
        </Field>
        <Field label="Expires (days)">
          <input className={`${inputCls} w-20`} inputMode="numeric" value={f.expiresDays} onChange={(e) => setF({ ...f, expiresDays: e.target.value })} />
        </Field>
        <Button variant="primary" busy={create.isPending} onClick={() => create.mutate()}>
          Create
        </Button>
      </div>
      {settings?.emailEnabled && f.email && <Toggle checked={f.send} onChange={(v) => setF({ ...f, send: v })} label="Email the invite" />}
      <ul className="divide-y divide-line mt-3 text-sm">
        {live.map((i) => (
          <li key={i.id} className="py-2 flex items-center gap-2">
            <code className="text-xs">{i.code}</code>
            <span className="text-muted truncate flex-1">
              {i.email ?? i.note ?? ''} · {i.role} · {i.expiresAt ? `expires ${new Date(i.expiresAt).toLocaleDateString()}` : 'no expiry'}
            </span>
            <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(i.url).then(() => toast('Link copied', 'ok'))} aria-label="Copy link">
              <Copy className="size-3.5" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)} aria-label="Revoke">
              <Trash2 className="size-3.5" />
            </Button>
          </li>
        ))}
        {!live.length && <li className="py-2 text-muted">No open invites.</li>}
      </ul>
    </Card>
  );
}

function SettingsCard({ s }: { s: PortalSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState(s);
  useEffect(() => {
    setF(s);
  }, [s]);
  const save = useMutation({
    mutationFn: () => put('/portal-settings', { allowPlexFriends: f.allowPlexFriends, defaults: f.defaults, kidRatings: f.kidRatings, watchlistMaxPerRun: f.watchlistMaxPerRun }),
    onSuccess: () => {
      toast('Portal settings saved', 'ok');
      qc.invalidateQueries({ queryKey: ['portal-settings'] });
      qc.invalidateQueries({ queryKey: ['guests'] });
    },
  });
  const d = (k: keyof PortalSettings['defaults']) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, defaults: { ...f.defaults, [k]: Number(e.target.value) || 0 } });
  return (
    <Card title="Portal defaults" actions={<a href={s.portalUrl} target="_blank" rel="noreferrer" className="text-xs text-accent">{s.portalUrl}</a>}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Films / week">
          <input className={inputCls} inputMode="numeric" value={f.defaults.moviesPerWeek} onChange={d('moviesPerWeek')} />
        </Field>
        <Field label="Seasons / week">
          <input className={inputCls} inputMode="numeric" value={f.defaults.seasonsPerWeek} onChange={d('seasonsPerWeek')} />
        </Field>
        <Field label="GB / month">
          <input className={inputCls} inputMode="numeric" value={f.defaults.gbPerMonth} onChange={d('gbPerMonth')} />
        </Field>
        <Field label="Auto-approve under GB" hint="0 = always ask">
          <input className={inputCls} inputMode="numeric" value={f.defaults.autoApproveGb} onChange={d('autoApproveGb')} />
        </Field>
        <Field label="Kid profile: allowed ratings" hint="Only for guests set to Kid. Adults (Guest profile) can request anything.">
          <input className={inputCls} value={f.kidRatings.join(', ')} onChange={(e) => setF({ ...f, kidRatings: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
        </Field>
        <Field label="Watchlist adds per run">
          <input className={inputCls} inputMode="numeric" value={f.watchlistMaxPerRun} onChange={(e) => setF({ ...f, watchlistMaxPerRun: Number(e.target.value) || 0 })} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
        <Toggle checked={f.allowPlexFriends} onChange={(v) => setF({ ...f, allowPlexFriends: v })} label="Plex friends can sign in without an invite" />
        <Button variant="primary" size="sm" busy={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
      <p className="text-xs text-muted mt-2">
        Push: {s.pushEnabled ? 'on' : 'off (no VAPID keys)'} · Email: {s.emailEnabled ? 'on (Resend)' : 'off (no Resend key)'}
      </p>
    </Card>
  );
}

function StatusPosts() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['status-posts'], queryFn: () => get<{ id: number; message: string; level: string; createdAt: number; expiresAt: number | null }[]>('/status-posts') });
  const [msg, setMsg] = useState('');
  const [hours, setHours] = useState('24');
  const add = useMutation({
    mutationFn: () => post('/status-posts', { message: msg, level: 'info', hours: Number(hours) || null }),
    onSuccess: () => {
      setMsg('');
      qc.invalidateQueries({ queryKey: ['status-posts'] });
    },
  });
  const rm = useMutation({ mutationFn: (id: number) => del(`/status-posts/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['status-posts'] }) });
  return (
    <Card title="Status page">
      <p className="text-xs text-muted mb-2">Shown to guests on Discover and Coming soon. Saga also adds automatic notes when downloads are paused or slow, or Plex is down.</p>
      <div className="flex gap-2 mb-2">
        <input className={inputCls} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="e.g. Server maintenance Saturday morning" maxLength={500} />
        <input className={`${inputCls} w-20`} inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Hours to show" title="Hours to show" />
        <Button disabled={!msg.trim()} busy={add.isPending} onClick={() => add.mutate()}>
          Post
        </Button>
      </div>
      <ul className="text-sm divide-y divide-line">
        {(data ?? []).filter((p) => !p.expiresAt || p.expiresAt > Date.now()).map((p) => (
          <li key={p.id} className="py-1.5 flex items-center gap-2">
            <span className="flex-1">{p.message}</span>
            <span className="text-xs text-muted">{p.expiresAt ? `until ${new Date(p.expiresAt).toLocaleString()}` : ''}</span>
            <Button size="sm" variant="ghost" onClick={() => rm.mutate(p.id)} aria-label="Remove">
              <Trash2 className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface ImportReport {
  dryRun: boolean;
  users: { total: number; admins: number; new: number; existing: number };
  requests: { total: number; new: number; existing: number; skipped: number; byStatus: Record<string, number> };
  sample: { title: string; status: string; requester: string | null }[];
}

function SeerrImport() {
  const qc = useQueryClient();
  const toast = useToast();
  const [report, setReport] = useState<ImportReport | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => post<ImportReport>('/seerr-import', { dryRun }),
    onSuccess: (r) => {
      setReport(r);
      if (!r.dryRun) {
        toast(`Imported ${r.users.new} guest(s) and ${r.requests.new} request(s)`, 'ok');
        qc.invalidateQueries({ queryKey: ['guests'] });
      }
    },
  });
  return (
    <Card title="Import from Seerr">
      <p className="text-xs text-muted mb-2">
        Copies Seerr's users (as guests, linked to their Plex account on first sign-in) and request history. Safe to run again: it only adds what's new. Seerr keeps running until you retire it.
      </p>
      <div className="flex gap-2">
        <Button busy={run.isPending && run.variables === true} onClick={() => run.mutate(true)}>
          Preview
        </Button>
        <Button variant="primary" disabled={!report} busy={run.isPending && run.variables === false} onClick={() => run.mutate(false)}>
          Import
        </Button>
      </div>
      {report && (
        <div className="mt-3 text-sm space-y-1">
          <div>
            {report.dryRun ? 'Would import' : 'Imported'}: {report.users.new} new guest(s) ({report.users.existing} already here, {report.users.admins} admin skipped), {report.requests.new} new request(s) ({report.requests.existing} already here
            {report.requests.skipped ? `, ${report.requests.skipped} unreadable` : ''}).
          </div>
          <div className="text-muted text-xs">
            By status:{' '}
            {Object.entries(report.requests.byStatus)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ')}
          </div>
          <ul className="text-xs text-muted list-disc pl-5">
            {report.sample.map((s, i) => (
              <li key={i}>
                {s.title} — {s.status}
                {s.requester ? ` (${s.requester})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export default function GuestsPage() {
  const qc = useQueryClient();
  const { data: guests, isLoading } = useQuery({ queryKey: ['guests'], queryFn: () => get<Guest[]>('/guests') });
  const { data: settings } = useQuery({ queryKey: ['portal-settings'], queryFn: () => get<PortalSettings>('/portal-settings') });
  const [editing, setEditing] = useState<Guest | null>(null);
  const toggle = useMutation({ mutationFn: (g: Guest) => patch(`/guests/${g.id}`, { enabled: !g.enabled }), onSuccess: () => qc.invalidateQueries({ queryKey: ['guests'] }) });
  return (
    <div className="space-y-5">
      <PageHeader title="Guests" sub="People who can use the request portal. Invite-only; they sign in with Plex or an emailed link." />
      <Card title={`Guests${guests ? ` (${guests.length})` : ''}`}>
        {isLoading ? (
          <Spinner />
        ) : !guests?.length ? (
          <p className="text-sm text-muted">No guests yet. Create an invite below, or import from Seerr.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted text-left">
                <tr>
                  <th className="py-1.5 pr-3">Guest</th>
                  <th className="pr-3">Films</th>
                  <th className="pr-3">Seasons</th>
                  <th className="pr-3">Month</th>
                  <th className="pr-3">Auto ≤</th>
                  <th className="pr-3">Seen</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {guests.map((g) => (
                  <tr key={g.id} className={g.enabled ? '' : 'opacity-50'}>
                    <td className="py-2 pr-3">
                      <div className="font-medium">
                        {g.username} {g.role === 'kid' && <span className="text-xs text-teal">kid</span>}
                        {g.unlimited && <span className="ml-1 text-[11px] rounded bg-accent/20 text-accent px-1.5">unlimited</span>}
                        {!g.unlimited && g.autoApproveAll && <span className="ml-1 text-[11px] rounded bg-ok/20 text-ok px-1.5">auto-approve</span>}
                      </div>
                      <div className="text-xs text-muted">
                        {g.email ?? 'no email'} · {g.plexId ? 'Plex linked' : 'not signed in yet'}
                        {g.seerrUserId ? ' · from Seerr' : ''} · {g.requests} request(s)
                        {g.watchlistUrl ? ` · watchlist: ${g.watchlistNote ?? 'linked'}` : ''}
                      </div>
                    </td>
                    <td className="pr-3 tabular-nums">
                      {g.usage.moviesWeek}/{g.limits.moviesPerWeek}
                    </td>
                    <td className="pr-3 tabular-nums">
                      {g.usage.seasonsWeek}/{g.limits.seasonsPerWeek}
                    </td>
                    <td className="pr-3 tabular-nums whitespace-nowrap">
                      {bytes(g.usage.bytesMonth, 0)} / {g.limits.gbPerMonth} GB
                    </td>
                    <td className="pr-3 tabular-nums">{g.limits.autoApproveGb ? `${g.limits.autoApproveGb} GB` : '—'}</td>
                    <td className="pr-3 text-xs text-muted whitespace-nowrap">{relTime(g.lastSeenAt)}</td>
                    <td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(g)}>
                        Limits
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => toggle.mutate(g)}>
                        {g.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Invites settings={settings} />
      {settings && <SettingsCard s={settings} />}
      <StatusPosts />
      <SeerrImport />
      {editing && <EditGuest g={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
