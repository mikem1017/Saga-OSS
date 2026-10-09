import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, X } from 'lucide-react';
import type { LibraryState } from '../../shared/types.ts';
import { del, get, post } from '../api.ts';
import { Button, Card, ErrorBox, Field, Modal, PageHeader, Segmented, Spinner, inputCls } from '../components/ui.tsx';
import { StateBadge } from '../components/Poster.tsx';
import { useToast } from '../components/toast.tsx';
import { bytes, img, relTime } from '../format.ts';
import { enablePush, pushSupported } from '../push.ts';

interface AdminRequest {
  id: number;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  seasons: number[] | null;
  status: string;
  estBytes: number;
  declineReason: string | null;
  lastError: string | null;
  source: string;
  createdAt: number;
  decidedBy: string | null;
  requesters: { id: number; username: string }[];
  state: LibraryState;
}

interface RequesterSummary {
  guests: { id: number; username: string; total: number; pending: number; approved: number; available: number }[];
  none: number;
}

interface Problem {
  id: number;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  kind: string;
  note: string | null;
  status: string;
  createdAt: number;
  resolutionNote: string | null;
  username: string;
}

const STATUS_CLS: Record<string, string> = {
  pending: 'text-warn',
  approved: 'text-info',
  available: 'text-ok',
  declined: 'text-muted',
  failed: 'text-bad',
};

function PushButton() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['portal-settings'], queryFn: () => get<{ vapidPublicKey: string | null; pushEnabled: boolean }>('/portal-settings') });
  if (!pushSupported() || !data?.pushEnabled || !data.vapidPublicKey) return null;
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          const ok = await enablePush(data.vapidPublicKey!, (sub) => post('/push/subscribe', sub));
          if (ok) {
            await post('/push/test');
            toast('Push is on for this browser', 'ok');
          } else toast('Notifications are blocked in this browser', 'error');
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error');
        }
      }}
    >
      <BellRing className="size-4" /> Notify me
    </Button>
  );
}

export default function RequestsPage() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as 'pending' | 'all' | 'problems') ?? 'pending';
  const by = sp.get('by') ?? '';
  // Change one URL param and keep the rest, so a filtered view stays bookmarkable.
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else next.delete(key);
    setSp(next);
  };
  const qc = useQueryClient();
  const toast = useToast();
  const [declining, setDeclining] = useState<AdminRequest | null>(null);
  const [reason, setReason] = useState('');
  const [resolving, setResolving] = useState<Problem | null>(null);
  const [note, setNote] = useState('');
  const reqs = useQuery({
    queryKey: ['admin-requests', tab, by],
    queryFn: () => {
      const q = new URLSearchParams();
      if (tab === 'pending') q.set('status', 'pending');
      if (by) q.set('by', by);
      return get<AdminRequest[]>(`/requests${q.size ? `?${q}` : ''}`);
    },
    enabled: tab !== 'problems',
    refetchInterval: 30_000,
  });
  const requesters = useQuery({
    queryKey: ['admin-requests', 'requesters'],
    queryFn: () => get<RequesterSummary>('/requests/requesters'),
    enabled: tab !== 'problems',
  });
  const byName = by === 'none' ? 'no guest requester' : requesters.data?.guests.find((g) => String(g.id) === by)?.username;
  const problems = useQuery({ queryKey: ['admin-problems'], queryFn: () => get<Problem[]>('/problems'), enabled: tab === 'problems' });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-requests'] });
    qc.invalidateQueries({ queryKey: ['admin-problems'] });
    qc.invalidateQueries({ queryKey: ['request-counts'] });
  };
  const approve = useMutation({ mutationFn: (id: number) => post(`/requests/${id}/approve`), onSuccess: () => (toast('Approved and added', 'ok'), refresh()) });
  const decline = useMutation({
    mutationFn: () => post(`/requests/${declining!.id}/decline`, { reason: reason || null }),
    onSuccess: () => {
      setDeclining(null);
      setReason('');
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`/requests/${id}`), onSuccess: refresh });
  const resolve = useMutation({
    mutationFn: () => post(`/problems/${resolving!.id}/resolve`, { note: note || null }),
    onSuccess: () => {
      setResolving(null);
      setNote('');
      refresh();
    },
  });

  return (
    <div>
      <PageHeader
        title="Requests"
        sub="From the request portal. Approving adds the title with your normal add rules."
        actions={
          <>
            <PushButton />
            {tab !== 'problems' && (
              <select
                className={`${inputCls} sm:w-56`}
                value={by}
                onChange={(e) => setParam('by', e.target.value || null)}
                aria-label="Requested by"
              >
                <option value="">Requested by: everyone</option>
                {requesters.data?.guests.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.username} — {g.total}
                    {g.pending ? `, ${g.pending} pending` : ''}
                    {g.approved ? `, ${g.approved} on the way` : ''}
                    {g.available ? `, ${g.available} available` : ''}
                  </option>
                ))}
                {!!requesters.data?.none && <option value="none">No guest requester — {requesters.data.none}</option>}
              </select>
            )}
            <Segmented
              value={tab}
              onChange={(v) => setParam('tab', v)}
              options={[
                { value: 'pending', label: 'Pending' },
                { value: 'all', label: 'All' },
                { value: 'problems', label: 'Problems' },
              ]}
            />
          </>
        }
      />
      {tab !== 'problems' &&
        (reqs.isLoading ? (
          <Spinner />
        ) : reqs.error ? (
          <ErrorBox error={reqs.error} />
        ) : !reqs.data?.length ? (
          <p className="text-muted text-sm">
            {by
              ? `No ${tab === 'pending' ? 'pending ' : ''}requests from ${byName ?? 'this requester'}.`
              : tab === 'pending'
                ? 'Nothing waiting for approval.'
                : 'No requests yet.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {reqs.data.map((r) => (
              <li key={r.id} className="flex gap-3 rounded-xl border border-line bg-surface p-3">
                <Link to={`/${r.mediaType}/${r.tmdbId}`} className="shrink-0">
                  <img src={img(r.posterPath, 'w92')} alt="" className="w-12 aspect-[2/3] rounded-md object-cover bg-surface-2" />
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link to={`/${r.mediaType}/${r.tmdbId}`} className="font-medium hover:text-accent">
                      {r.title} {r.year && <span className="text-muted font-normal">({r.year})</span>}
                    </Link>
                    {r.seasons && <span className="text-xs text-muted">S{r.seasons.join(', S')}</span>}
                    <StateBadge state={r.state} />
                    <span className={`text-xs font-medium ${STATUS_CLS[r.status] ?? ''}`}>{r.status}</span>
                  </div>
                  <div className="text-xs text-muted mt-0.5">
                    {r.requesters.length
                      ? r.requesters.map((g, i) => (
                          <span key={g.id}>
                            {i > 0 && ', '}
                            <button type="button" className="hover:text-accent underline-offset-2 hover:underline" title={`Show only ${g.username}'s requests`} onClick={() => setParam('by', String(g.id))}>
                              {g.username}
                            </button>
                          </span>
                        ))
                      : 'no guest requester'}{' '}
                    · {relTime(r.createdAt)} · {r.source}
                    {r.estBytes > 0 && ` · ~${bytes(r.estBytes)}`}
                    {r.decidedBy && ` · decided by ${r.decidedBy}`}
                  </div>
                  {r.lastError && <div className="text-xs text-bad mt-1">{r.lastError}</div>}
                  {r.declineReason && <div className="text-xs text-muted mt-1">Declined: {r.declineReason}</div>}
                </div>
                <div className="flex flex-col sm:flex-row items-end sm:items-start gap-1.5 shrink-0">
                  {(r.status === 'pending' || r.status === 'failed') && (
                    <>
                      <Button size="sm" variant="primary" busy={approve.isPending && approve.variables === r.id} onClick={() => approve.mutate(r.id)}>
                        <Check className="size-3.5" /> {r.status === 'failed' ? 'Retry' : 'Approve'}
                      </Button>
                      <Button size="sm" onClick={() => setDeclining(r)}>
                        <X className="size-3.5" /> Decline
                      </Button>
                    </>
                  )}
                  {r.status !== 'pending' && tab === 'all' && (
                    <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.id)} title="Remove this request record (doesn't touch Radarr/Sonarr)">
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ))}
      {tab === 'problems' &&
        (problems.isLoading ? (
          <Spinner />
        ) : !problems.data?.length ? (
          <p className="text-muted text-sm">No problems reported.</p>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {problems.data.map((p) => (
                <li key={p.id} className="py-2 flex items-start gap-3">
                  <div className="min-w-0 flex-1 text-sm">
                    <Link to={`/${p.mediaType}/${p.tmdbId}`} className="font-medium hover:text-accent">
                      {p.title}
                    </Link>{' '}
                    · {p.kind.replace('_', ' ')} · {p.username} · {relTime(p.createdAt)}
                    {p.note && <div className="text-muted">{p.note}</div>}
                    {p.resolutionNote && <div className="text-ok text-xs">Resolved: {p.resolutionNote}</div>}
                  </div>
                  {p.status === 'open' ? (
                    <Button size="sm" onClick={() => setResolving(p)}>
                      Mark fixed
                    </Button>
                  ) : (
                    <span className="text-xs text-ok">fixed</span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      <Modal open={!!declining} onClose={() => setDeclining(null)} title={`Decline ${declining?.title ?? ''}`}>
        <Field label="Reason (sent to the requester)">
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Not available in good quality yet" maxLength={500} />
        </Field>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => setDeclining(null)}>
            Cancel
          </Button>
          <Button variant="danger" busy={decline.isPending} onClick={() => decline.mutate()}>
            Decline
          </Button>
        </div>
      </Modal>
      <Modal open={!!resolving} onClose={() => setResolving(null)} title={`Fixed: ${resolving?.title ?? ''}`}>
        <Field label="Note to the guest (optional)">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Replaced with a better copy" maxLength={1000} />
        </Field>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => setResolving(null)}>
            Cancel
          </Button>
          <Button variant="primary" busy={resolve.isPending} onClick={() => resolve.mutate()}>
            Mark fixed and notify
          </Button>
        </div>
      </Modal>
    </div>
  );
}
