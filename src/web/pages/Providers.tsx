import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, Import, Pencil, Server, ShieldCheck } from 'lucide-react';
import { downloadPost, get, patch, post } from '../api.ts';
import { bytes } from '../format.ts';
import { Button, Card, ErrorBox, Field, inputCls, Modal, PageHeader, ProgressBar, Spinner, Toggle } from '../components/ui.tsx';
import { useToast } from '../components/toast.tsx';
import { AddRecordButton, PushButton, SnapshotsCard } from '../components/PushControls.tsx';

interface Drift {
  field: string;
  saga: unknown;
  live: unknown;
}

interface Provider {
  id: number;
  sabName?: string;
  displayName: string;
  host: string;
  port: number;
  ssl: boolean;
  connections: number;
  priority: number;
  retentionDays: number | null;
  enabled: boolean;
  optional?: boolean;
  username: string | null;
  hasPassword: boolean;
  planType: 'unlimited' | 'block';
  renewalDate: string | null;
  renewInDays: number | null;
  price: number | null;
  billingPeriod: 'month' | 'year' | 'once' | null;
  blockSizeBytes: number | null;
  blockUsedBytes: number | null;
  blockLeftBytes: number | null;
  dataCapBytes: number | null;
  notes: string | null;
  usage: { day: number; week: number; month: number; total: number } | null;
  drift: Drift[];
  warnings: string[];
}

interface Indexer {
  id: number;
  prowlarrId: number | null;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  priority: number;
  apiLimitDay: number | null;
  grabLimitDay: number | null;
  vipExpiry: string | null;
  vipInDays: number | null;
  renewalPrice: number | null;
  notes: string | null;
  today: { queries: number | null; grabs: number | null };
  drift: Drift[];
  warnings: string[];
}

const GB = 1024 ** 3;
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-1 mb-3">
      {items.map((w) => (
        <li key={w} className="flex items-start gap-2 rounded-lg bg-warn/10 border border-warn/40 text-warn px-2.5 py-1.5 text-xs">
          <AlertTriangle className="size-3.5 shrink-0 mt-0.5" /> {w}
        </li>
      ))}
    </ul>
  );
}

function DriftTable({ drift, what }: { drift: Drift[]; what: 'SAB' | 'Prowlarr' }) {
  return (
    <details className="mt-3 rounded-lg border border-line bg-surface-2" open={drift.length > 0}>
      <summary className="cursor-pointer px-3 py-2 text-xs">
        {drift.length ? <span className="text-warn">{drift.length} difference(s) from {what}</span> : <span className="text-ok inline-flex items-center gap-1"><ShieldCheck className="size-3.5" /> Matches {what}</span>}
      </summary>
      <div className="px-3 pb-3">
        <p className="text-[11px] text-muted mb-2">
          Saga's record vs what {what} runs. Use Push to apply Saga's values to {what} (with a preview and a snapshot first).
        </p>
        {drift.length > 0 && (
          <table className="w-full text-xs">
            <thead className="text-muted text-left">
              <tr>
                <th className="py-1">Field</th>
                <th className="py-1">Saga</th>
                <th className="py-1">Live</th>
              </tr>
            </thead>
            <tbody>
              {drift.map((d) => (
                <tr key={d.field} className="border-t border-line">
                  <td className="py-1 font-mono">{d.field}</td>
                  <td className="py-1 break-all">{show(d.saga)}</td>
                  <td className="py-1 break-all">{show(d.live)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function ProviderEdit({ p, onClose }: { p: Provider; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    displayName: p.displayName,
    host: p.host,
    port: String(p.port),
    ssl: p.ssl,
    connections: String(p.connections),
    priority: String(p.priority),
    retentionDays: String(p.retentionDays ?? ''),
    enabled: p.enabled,
    username: p.username ?? '',
    password: '',
    planType: p.planType,
    renewalDate: p.renewalDate ?? '',
    price: p.price === null ? '' : String(p.price),
    billingPeriod: p.billingPeriod ?? '',
    dataCapGb: p.dataCapBytes ? String(Math.round(p.dataCapBytes / GB)) : '',
    notes: p.notes ?? '',
  });
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        displayName: f.displayName,
        host: f.host,
        port: Number(f.port),
        ssl: f.ssl,
        connections: Number(f.connections),
        priority: Number(f.priority),
        enabled: f.enabled,
        username: f.username || null,
        planType: f.planType,
        renewalDate: f.renewalDate || null,
        price: numOrNull(f.price),
        billingPeriod: f.billingPeriod || null,
        dataCapBytes: f.dataCapGb ? Math.round(Number(f.dataCapGb) * GB) : null,
        notes: f.notes || null,
      };
      if (f.retentionDays !== '') body.retentionDays = Number(f.retentionDays);
      if (f.password) body.password = f.password;
      return patch(`/control/providers/${p.id}`, body);
    },
    onSuccess: () => {
      toast('Saved to Saga', 'ok');
      void qc.invalidateQueries({ queryKey: ['control-providers'] });
      onClose();
    },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={`Edit ${p.displayName}`} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name">
            <input className={inputCls} value={f.displayName} onChange={set('displayName')} required />
          </Field>
          <Field label="Host">
            <input className={inputCls} value={f.host} onChange={set('host')} required />
          </Field>
          <Field label="Port">
            <input className={inputCls} type="number" value={f.port} onChange={set('port')} required />
          </Field>
          <Field label="Connections">
            <input className={inputCls} type="number" value={f.connections} onChange={set('connections')} />
          </Field>
          <Field label="Priority (0 = first)">
            <input className={inputCls} type="number" value={f.priority} onChange={set('priority')} />
          </Field>
          <Field label="Retention (days)">
            <input className={inputCls} type="number" value={f.retentionDays} onChange={set('retentionDays')} />
          </Field>
          <Field label="Username">
            <input className={inputCls} value={f.username} onChange={set('username')} autoComplete="off" />
          </Field>
          <Field label={`Password (${p.hasPassword ? 'set' : 'not set'})`} hint="Write-only. Leave blank to keep the stored one.">
            <input className={inputCls} type="password" placeholder="Replace…" value={f.password} onChange={set('password')} autoComplete="new-password" />
          </Field>
          <div className="flex flex-col justify-end gap-2 pb-1">
            <Toggle checked={f.ssl} onChange={(v) => setF({ ...f, ssl: v })} label="SSL" />
            <Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Enabled" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Plan">
            <select className={inputCls} value={f.planType} onChange={(e) => setF({ ...f, planType: e.target.value as Provider['planType'] })}>
              <option value="unlimited">Unlimited</option>
              <option value="block">Block</option>
            </select>
          </Field>
          <Field label="Renewal date">
            <input className={inputCls} type="date" value={f.renewalDate} onChange={set('renewalDate')} />
          </Field>
          <Field label="Price ($)">
            <input className={inputCls} type="number" step="0.01" value={f.price} onChange={set('price')} />
          </Field>
          <Field label="Billing period">
            <select className={inputCls} value={f.billingPeriod} onChange={set('billingPeriod')}>
              <option value="">—</option>
              <option value="month">Monthly</option>
              <option value="year">Yearly</option>
              <option value="once">One-off</option>
            </select>
          </Field>
          <Field label="Monthly data cap (GB)">
            <input className={inputCls} type="number" value={f.dataCapGb} onChange={set('dataCapGb')} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea className={inputCls} rows={2} value={f.notes} onChange={set('notes')} />
        </Field>
        <p className="text-xs text-muted">Saves Saga's record. Use Push on the card to apply it to SAB.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" busy={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function BlockRecorder({ p }: { p: Provider }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [gb, setGb] = useState('');
  const rec = useMutation({
    mutationFn: () => patch(`/control/providers/${p.id}`, { blockSizeBytes: Math.round(Number(gb) * GB), resetBlockBaseline: true }),
    onSuccess: () => {
      toast(`Recorded a ${gb} GB block, counting from now`, 'ok');
      setGb('');
      void qc.invalidateQueries({ queryKey: ['control-providers'] });
    },
  });
  return (
    <form
      className="flex items-center gap-2 mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (Number(gb) > 0) rec.mutate();
      }}
    >
      <input className={`${inputCls} w-28`} type="number" min={1} placeholder="GB" value={gb} onChange={(e) => setGb(e.target.value)} aria-label="Block size in GB" />
      <Button size="sm" type="submit" busy={rec.isPending} disabled={!(Number(gb) > 0)}>
        Record block of {gb || 'N'} GB
      </Button>
    </form>
  );
}

function ProviderCard({ p }: { p: Provider }) {
  const [edit, setEdit] = useState(false);
  const blockPct = p.blockSizeBytes && p.blockUsedBytes !== null ? (p.blockUsedBytes / p.blockSizeBytes) * 100 : null;
  return (
    <section className={`rounded-xl border bg-surface p-4 ${p.enabled ? 'border-line' : 'border-line/50 opacity-80'}`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h3 className="font-semibold flex items-center gap-2">
            <Server className="size-4 text-muted" /> {p.displayName}
            {!p.enabled && <span className="text-[11px] rounded bg-surface-3 px-1.5">disabled</span>}
          </h3>
          <p className="text-xs text-muted font-mono truncate">
            {p.host}:{p.port}
            {p.ssl ? ' · SSL' : ''} · {p.connections} conn · priority {p.priority}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <PushButton kind="provider" id={p.id} name={p.displayName} hasDrift={p.drift.length > 0} />
          <Button size="sm" variant="ghost" onClick={() => setEdit(true)} aria-label={`Edit ${p.displayName}`}>
            <Pencil className="size-4" />
          </Button>
        </div>
      </div>
      <Warnings items={p.warnings} />
      <div className="grid grid-cols-3 gap-2 mb-3 text-center">
        {(['day', 'week', 'month'] as const).map((k) => (
          <div key={k} className="rounded-lg bg-surface-2 py-2">
            <div className="text-[11px] text-muted">{k === 'day' ? 'Today' : k === 'week' ? 'This week' : 'This month'}</div>
            <div className="text-sm font-semibold tabular-nums">{p.usage ? bytes(p.usage[k]) : '—'}</div>
          </div>
        ))}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <Row label="Plan">
          {p.planType === 'block' ? 'Block' : 'Unlimited'}
          {p.price !== null && ` · $${p.price}${p.billingPeriod && p.billingPeriod !== 'once' ? `/${p.billingPeriod}` : ''}`}
        </Row>
        <Row label="Renews">
          {p.renewalDate ? (
            <>
              {p.renewalDate}{' '}
              <span className={p.renewInDays !== null && p.renewInDays <= 14 ? 'text-warn' : 'text-muted'}>
                ({p.renewInDays !== null && p.renewInDays < 0 ? `${-p.renewInDays} days ago` : `in ${p.renewInDays} days`})
              </span>
            </>
          ) : (
            <span className="text-muted">not recorded</span>
          )}
        </Row>
        <Row label="Login">
          {p.username ?? '—'} · password {p.hasPassword ? 'set' : <span className="text-warn">not set</span>}
        </Row>
        {p.retentionDays !== null && <Row label="Retention">{p.retentionDays} days</Row>}
        {p.dataCapBytes !== null && <Row label="Data cap">{bytes(p.dataCapBytes)} / month</Row>}
        {p.notes && <Row label="Notes">{p.notes}</Row>}
      </dl>
      {p.planType === 'block' && (
        <div className="mt-3">
          {blockPct !== null ? (
            <>
              <div className="flex justify-between text-xs mb-1">
                <span>
                  {bytes(p.blockUsedBytes)} used of {bytes(p.blockSizeBytes)}
                </span>
                <span className={p.blockLeftBytes !== null && p.blockSizeBytes && p.blockLeftBytes < p.blockSizeBytes * 0.1 ? 'text-warn' : 'text-muted'}>{bytes(p.blockLeftBytes)} left</span>
              </div>
              <ProgressBar value={blockPct} tone={blockPct > 90 ? 'warn' : 'info'} />
            </>
          ) : (
            <p className="text-xs text-muted">Record the block you bought to start counting usage against it.</p>
          )}
          <BlockRecorder p={p} />
        </div>
      )}
      <DriftTable drift={p.drift} what="SAB" />
      {edit && <ProviderEdit p={p} onClose={() => setEdit(false)} />}
    </section>
  );
}

function IndexerEdit({ ix, onClose }: { ix: Indexer; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    name: ix.name,
    baseUrl: ix.baseUrl,
    apiKey: '',
    enabled: ix.enabled,
    priority: String(ix.priority),
    apiLimitDay: ix.apiLimitDay === null ? '' : String(ix.apiLimitDay),
    grabLimitDay: ix.grabLimitDay === null ? '' : String(ix.grabLimitDay),
    vipExpiry: ix.vipExpiry ? ix.vipExpiry.slice(0, 10) : '',
    renewalPrice: ix.renewalPrice === null ? '' : String(ix.renewalPrice),
    notes: ix.notes ?? '',
  });
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: f.name,
        baseUrl: f.baseUrl,
        enabled: f.enabled,
        priority: Number(f.priority),
        apiLimitDay: numOrNull(f.apiLimitDay),
        grabLimitDay: numOrNull(f.grabLimitDay),
        vipExpiry: f.vipExpiry || null,
        renewalPrice: numOrNull(f.renewalPrice),
        notes: f.notes || null,
      };
      if (f.apiKey) body.apiKey = f.apiKey;
      return patch(`/control/indexers/${ix.id}`, body);
    },
    onSuccess: () => {
      toast('Saved to Saga', 'ok');
      void qc.invalidateQueries({ queryKey: ['control-indexers'] });
      onClose();
    },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={`Edit ${ix.name}`}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className={inputCls} value={f.name} onChange={set('name')} required />
          </Field>
          <Field label="Base URL">
            <input className={inputCls} type="url" value={f.baseUrl} onChange={set('baseUrl')} required />
          </Field>
          <Field label={`API key (${ix.hasApiKey ? 'set' : 'not set'})`} hint="Write-only. Leave blank to keep it.">
            <input className={inputCls} type="password" placeholder="Replace…" value={f.apiKey} onChange={set('apiKey')} autoComplete="new-password" />
          </Field>
          <Field label="Priority (1–50)">
            <input className={inputCls} type="number" min={1} max={50} value={f.priority} onChange={set('priority')} />
          </Field>
          <Field label="API hits per day">
            <input className={inputCls} type="number" value={f.apiLimitDay} onChange={set('apiLimitDay')} />
          </Field>
          <Field label="Grabs per day">
            <input className={inputCls} type="number" value={f.grabLimitDay} onChange={set('grabLimitDay')} />
          </Field>
          <Field label="VIP expiry">
            <input className={inputCls} type="date" value={f.vipExpiry} onChange={set('vipExpiry')} />
          </Field>
          <Field label="Renewal price ($)">
            <input className={inputCls} type="number" step="0.01" value={f.renewalPrice} onChange={set('renewalPrice')} />
          </Field>
        </div>
        <Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Enabled" />
        <Field label="Notes">
          <textarea className={inputCls} rows={2} value={f.notes} onChange={set('notes')} />
        </Field>
        <p className="text-xs text-muted">Saves Saga's record. Use Push on the card to apply it to Prowlarr, which syncs it to the *arrs.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" busy={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LimitBar({ label, used, limit }: { label: string; used: number | null; limit: number | null }) {
  return (
    <div className="rounded-lg bg-surface-2 p-2">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted">{label} today</span>
        <span className="tabular-nums">
          {used ?? '—'}
          {limit ? ` / ${limit}` : ''}
        </span>
      </div>
      {limit ? <ProgressBar value={((used ?? 0) / limit) * 100} tone={(used ?? 0) > limit * 0.8 ? 'warn' : 'ok'} /> : <div className="text-[11px] text-muted">no limit recorded</div>}
    </div>
  );
}

function IndexerCard({ ix }: { ix: Indexer }) {
  const [edit, setEdit] = useState(false);
  return (
    <section className={`rounded-xl border bg-surface p-4 ${ix.enabled ? 'border-line' : 'border-line/50 opacity-80'}`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h3 className="font-semibold">
            {ix.name} {!ix.enabled && <span className="text-[11px] rounded bg-surface-3 px-1.5">disabled</span>}
          </h3>
          <p className="text-xs text-muted font-mono truncate">
            {ix.baseUrl} · priority {ix.priority}
            {ix.prowlarrId ? ` · Prowlarr #${ix.prowlarrId}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <PushButton kind="indexer" id={ix.id} name={ix.name} hasDrift={ix.drift.length > 0} />
          <Button size="sm" variant="ghost" onClick={() => setEdit(true)} aria-label={`Edit ${ix.name}`}>
            <Pencil className="size-4" />
          </Button>
        </div>
      </div>
      <Warnings items={ix.warnings} />
      <div className="grid grid-cols-2 gap-2 mb-3">
        <LimitBar label="API hits" used={ix.today.queries} limit={ix.apiLimitDay} />
        <LimitBar label="Grabs" used={ix.today.grabs} limit={ix.grabLimitDay} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <Row label="API key">{ix.hasApiKey ? 'set' : <span className="text-warn">not set</span>}</Row>
        <Row label="VIP">
          {ix.vipExpiry ? (
            <>
              {ix.vipExpiry.slice(0, 10)}{' '}
              <span className={ix.vipInDays !== null && ix.vipInDays <= 30 ? 'text-warn' : 'text-muted'}>
                ({ix.vipInDays !== null && ix.vipInDays < 0 ? 'expired' : `in ${ix.vipInDays} days`})
              </span>
            </>
          ) : (
            <span className="text-muted">not recorded</span>
          )}
        </Row>
        {ix.renewalPrice !== null && <Row label="Renewal">${ix.renewalPrice}</Row>}
        {ix.notes && <Row label="Notes">{ix.notes}</Row>}
      </dl>
      <DriftTable drift={ix.drift} what="Prowlarr" />
      {edit && <IndexerEdit ix={ix} onClose={() => setEdit(false)} />}
    </section>
  );
}

function ExportCard() {
  const toast = useToast();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Encrypted backup">
      <p className="text-sm text-muted mb-3">Download every provider and indexer record, secrets included, sealed with a passphrase you choose. Saga never stores the passphrase.</p>
      <form
        className="flex flex-col sm:flex-row gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await downloadPost('/control/export', { passphrase: pass }, 'saga-control.sagabak');
            toast('Backup downloaded', 'ok');
            setPass('');
          } catch {
            /* toast already shown */
          } finally {
            setBusy(false);
          }
        }}
      >
        <input className={inputCls} type="password" minLength={12} placeholder="Passphrase (12+ characters)" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" aria-label="Backup passphrase" />
        <Button type="submit" busy={busy} disabled={pass.length < 12} className="shrink-0">
          <Download className="size-4" /> Download
        </Button>
      </form>
    </Card>
  );
}

export default function ProvidersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const prov = useQuery({ queryKey: ['control-providers'], queryFn: () => get<{ providers: Provider[]; untrackedInSab: string[]; liveAvailable: boolean }>('/control/providers'), refetchInterval: 120_000 });
  const idx = useQuery({ queryKey: ['control-indexers'], queryFn: () => get<{ indexers: Indexer[]; liveAvailable?: boolean }>('/control/indexers'), refetchInterval: 120_000 });
  const imp = useMutation({
    mutationFn: (overwrite: boolean) => post<{ providers: number; indexers: number }>('/control/import', { overwrite }),
    onSuccess: (r) => {
      toast(`Imported ${r.providers} provider(s) and ${r.indexers} indexer(s)`, 'ok');
      void qc.invalidateQueries({ queryKey: ['control-providers'] });
      void qc.invalidateQueries({ queryKey: ['control-indexers'] });
    },
  });
  const empty = prov.data?.providers.length === 0 && idx.data?.indexers.length === 0;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Providers & indexers"
        sub="Saga is the source of truth for Usenet servers and indexers: renewals, block balances and daily limits, with drift from what SAB and Prowlarr run and a previewed push to fix it."
        actions={
          !empty && (
            <Button
              variant="ghost"
              busy={imp.isPending}
              onClick={() => confirm('Re-import from SAB and Prowlarr? New servers and indexers are added; existing records keep your edits.') && imp.mutate(false)}
            >
              <Import className="size-4" /> Re-import
            </Button>
          )
        }
      />
      {empty && (
        <div className="rounded-2xl border border-accent/50 bg-accent/10 p-6 text-center">
          <h2 className="text-lg font-semibold mb-1">Nothing recorded yet</h2>
          <p className="text-sm text-muted mb-4">Read the current SAB servers and Prowlarr indexers so you never retype anything. Passwords and API keys are encrypted at rest and never sent back to the browser.</p>
          <Button variant="primary" busy={imp.isPending} onClick={() => imp.mutate(false)}>
            <Import className="size-4" /> Import from SAB & Prowlarr
          </Button>
        </div>
      )}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Usenet providers</h2>
          <AddRecordButton kind="provider" />
        </div>
        {prov.isLoading && <Spinner />}
        {prov.error && <ErrorBox error={prov.error} />}
        {prov.data && !prov.data.liveAvailable && <p className="text-xs text-warn mb-2">SAB's live config couldn't be read, so drift isn't shown.</p>}
        {prov.data && prov.data.untrackedInSab.length > 0 && (
          <p className="text-xs text-warn mb-2">
            In SAB but not in Saga: {prov.data.untrackedInSab.join(', ')}. Re-import to add {prov.data.untrackedInSab.length === 1 ? 'it' : 'them'}.
          </p>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {prov.data?.providers.map((p) => (
            <ProviderCard key={p.id} p={p} />
          ))}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Indexers</h2>
          <AddRecordButton kind="indexer" />
        </div>
        {idx.isLoading && <Spinner />}
        {idx.error && <ErrorBox error={idx.error} />}
        {idx.data && idx.data.liveAvailable === false && <p className="text-xs text-warn mb-2">Prowlarr couldn't be read, so drift and today's counts aren't shown.</p>}
        <div className="grid gap-4 lg:grid-cols-2">
          {idx.data?.indexers.map((ix) => (
            <IndexerCard key={ix.id} ix={ix} />
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <SnapshotsCard />
        <ExportCard />
      </div>
    </div>
  );
}
