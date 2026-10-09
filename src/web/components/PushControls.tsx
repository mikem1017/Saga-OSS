import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Plus, Upload } from 'lucide-react';
import { get, post } from '../api.ts';
import { dateTime } from '../format.ts';
import { Button, Card, ErrorBox, Field, inputCls, Modal, Spinner, Toggle } from './ui.tsx';
import { useToast } from './toast.tsx';

interface Drift {
  field: string;
  saga: unknown;
  live: unknown;
}
interface Plan {
  id: number;
  name: string;
  creates: boolean;
  changes: Drift[];
  willSetPassword?: boolean;
  willSetApiKey?: boolean;
}
interface PushResult {
  ok: boolean;
  applied: string[];
  remaining: Drift[];
}

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));

/**
 * Push Saga's record of one provider (to SAB) or indexer (to Prowlarr): preview the exact changes, then apply.
 * The server snapshots the app's current config first and re-reads it afterwards.
 */
export function PushButton({ kind, id, name, hasDrift }: { kind: 'provider' | 'indexer'; id: number; name: string; hasDrift: boolean }) {
  const [open, setOpen] = useState(false);
  const target = kind === 'provider' ? 'SAB' : 'Prowlarr';
  const base = `/control/${kind === 'provider' ? 'providers' : 'indexers'}/${id}`;
  const qc = useQueryClient();
  const toast = useToast();
  const plan = useQuery({ queryKey: ['push-plan', kind, id], queryFn: () => get<Plan>(`${base}/plan`), enabled: open, staleTime: 0 });
  const push = useMutation({
    mutationFn: () => post<PushResult>(`${base}/push`),
    onSuccess: (r) => {
      toast(r.ok ? `${name}: ${target} updated` : `${name}: pushed, but ${r.remaining.length} field(s) still differ`, r.ok ? 'ok' : 'error');
      void qc.invalidateQueries({ queryKey: ['control-providers'] });
      void qc.invalidateQueries({ queryKey: ['control-indexers'] });
      void qc.invalidateQueries({ queryKey: ['control-snapshots'] });
    },
  });
  const p = plan.data;
  const secret = p && (p.willSetPassword || p.willSetApiKey);
  const nothing = p && !p.creates && !p.changes.length && !secret;
  return (
    <>
      <Button size="sm" variant={hasDrift ? 'primary' : 'ghost'} onClick={() => setOpen(true)} title={`Push Saga's record to ${target}`}>
        <Upload className="size-4" /> {hasDrift ? `Push to ${target}` : 'Push'}
      </Button>
      {open && (
        <Modal
          open={open}
          onClose={() => {
            setOpen(false);
            push.reset();
          }}
          title={`Push ${name} to ${target}`}
        >
          {plan.isLoading && <Spinner label={`Comparing with ${target}`} />}
          {plan.error && <ErrorBox error={plan.error} />}
          {p && !push.data && (
            <div className="space-y-4 text-sm">
              {p.creates ? (
                <p>
                  <span className="font-medium">{name}</span> isn't in {target} yet. Pushing will <span className="font-medium">create</span> it from Saga's record.
                </p>
              ) : nothing ? (
                <p className="text-muted">{target} already matches Saga's record. Nothing to push.</p>
              ) : (
                <>
                  <p>These {target} settings will change:</p>
                  <table className="w-full text-xs">
                    <thead className="text-muted text-left">
                      <tr>
                        <th className="py-1 font-medium">Field</th>
                        <th className="py-1 font-medium">{target} now</th>
                        <th className="py-1 font-medium">After push</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.changes.map((d) => (
                        <tr key={d.field} className="border-t border-line">
                          <td className="py-1 font-mono">{d.field}</td>
                          <td className="py-1 text-muted">{show(d.live)}</td>
                          <td className="py-1 font-medium">{show(d.saga)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              {secret && <p className="text-xs text-muted">Saga's stored {kind === 'provider' ? 'password' : 'API key'} will also be sent (it's never shown).</p>}
              <p className="text-xs text-muted">{target}'s current config is snapshotted (encrypted) first. Every push is in the Activity log.</p>
              {push.error && <ErrorBox error={push.error} />}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button variant="primary" busy={push.isPending} disabled={!!nothing} onClick={() => push.mutate()}>
                  {p.creates ? `Create in ${target}` : `Apply to ${target}`}
                </Button>
              </div>
            </div>
          )}
          {push.data && (
            <div className="space-y-3 text-sm">
              <p className={push.data.ok ? 'text-ok' : 'text-warn'}>
                {push.data.applied.length ? `Applied: ${push.data.applied.join(', ')}.` : 'Nothing needed changing.'}{' '}
                {push.data.ok ? `${target} now matches Saga.` : `Still different: ${push.data.remaining.map((d) => d.field).join(', ')}.`}
              </p>
              <div className="flex justify-end">
                <Button variant="primary" onClick={() => setOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

/** New provider or indexer: saved to Saga's record, then pushed from its card (with a preview). */
export function AddRecordButton({ kind }: { kind: 'provider' | 'indexer' }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState<Record<string, any>>({});
  const set = (k: string, val: unknown) => setV((s) => ({ ...s, [k]: val }));
  const save = useMutation({
    mutationFn: () =>
      kind === 'provider'
        ? post('/control/providers', {
            displayName: v.displayName,
            host: v.host,
            port: Number(v.port ?? 563),
            ssl: v.ssl ?? true,
            connections: Number(v.connections ?? 20),
            priority: Number(v.priority ?? 1),
            username: v.username || null,
            password: v.password || undefined,
          })
        : post('/control/indexers', {
            name: v.name,
            baseUrl: v.baseUrl,
            apiKey: v.apiKey,
            priority: v.priority ? Number(v.priority) : undefined,
            apiLimitDay: v.apiLimitDay ? Number(v.apiLimitDay) : null,
            grabLimitDay: v.grabLimitDay ? Number(v.grabLimitDay) : null,
          }),
    onSuccess: () => {
      toast(`Saved to Saga. Use "Push" on its card to add it to ${kind === 'provider' ? 'SAB' : 'Prowlarr'}.`, 'ok');
      setOpen(false);
      setV({});
      void qc.invalidateQueries({ queryKey: [kind === 'provider' ? 'control-providers' : 'control-indexers'] });
    },
  });
  const text = (k: string, label: string, props: Record<string, unknown> = {}) => (
    <Field label={label}>
      <input className={inputCls} value={v[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...props} />
    </Field>
  );
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Add {kind}
      </Button>
      {open && (
        <Modal open={open} onClose={() => setOpen(false)} title={kind === 'provider' ? 'New Usenet provider' : 'New indexer (Newznab)'}>
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            {kind === 'provider' ? (
              <>
                {text('displayName', 'Name', { required: true })}
                {text('host', 'Host', { required: true, placeholder: 'news.example.com' })}
                {text('port', 'Port', { inputMode: 'numeric', placeholder: '563' })}
                {text('connections', 'Connections', { inputMode: 'numeric', placeholder: '20' })}
                {text('priority', 'Priority (0 = first)', { inputMode: 'numeric', placeholder: '1' })}
                <div className="flex items-end pb-2">
                  <Toggle checked={v.ssl ?? true} onChange={(b) => set('ssl', b)} label="SSL" />
                </div>
                {text('username', 'Username', { autoComplete: 'off' })}
                {text('password', 'Password', { type: 'password', autoComplete: 'new-password' })}
              </>
            ) : (
              <>
                {text('name', 'Name', { required: true })}
                {text('baseUrl', 'API URL', { required: true, placeholder: 'https://api.example.com' })}
                {text('apiKey', 'API key', { required: true, type: 'password', autoComplete: 'off' })}
                {text('priority', 'Priority (1–50)', { inputMode: 'numeric', placeholder: '25' })}
                {text('apiLimitDay', 'API hits / day', { inputMode: 'numeric' })}
                {text('grabLimitDay', 'Grabs / day', { inputMode: 'numeric' })}
              </>
            )}
            <div className="sm:col-span-2 space-y-2">
              {save.error && <ErrorBox error={save.error} />}
              <p className="text-xs text-muted">Saved to Saga only. Push it from its card to {kind === 'provider' ? 'create the server in SAB' : 'add it to Prowlarr, which syncs it to the *arrs'}.</p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" busy={save.isPending}>
                  Save
                </Button>
              </div>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function SnapshotsCard() {
  const snaps = useQuery({
    queryKey: ['control-snapshots'],
    queryFn: () => get<{ id: number; ts: number; app: string; target: string; reason: string; actor: string }[]>('/control/snapshots'),
  });
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <History className="size-4" /> Config snapshots
        </span>
      }
    >
      <p className="text-xs text-muted mb-2">Taken automatically before every push, encrypted in Saga's database.</p>
      {snaps.error && <ErrorBox error={snaps.error} />}
      {snaps.data && snaps.data.length === 0 && <p className="text-sm text-muted">No pushes yet.</p>}
      <ul className="text-sm divide-y divide-line">
        {snaps.data?.map((s) => (
          <li key={s.id} className="py-1.5 flex flex-wrap gap-x-3">
            <span className="tabular-nums text-muted">{dateTime(s.ts)}</span>
            <span className="font-medium">{s.app}</span>
            <span className="font-mono text-xs self-center">{s.target}</span>
            <span className="text-muted">{s.reason}</span>
            <span className="text-muted ml-auto">{s.actor}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
