import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpToLine, ChevronDown, Pause, Play, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import type { DownloadsSnapshot, QueueJob } from '../../shared/types.ts';
import { get, post, qs } from '../api.ts';
import { bytes, duration, rate } from '../format.ts';
import { Button, Card, ErrorBox, inputCls, Modal, PageHeader, ProgressBar, Spinner, Stat, Toggle } from '../components/ui.tsx';
import { useToast } from '../components/toast.tsx';
import { Problems } from '../components/Problems.tsx';

const PAGE = 50;
const PAUSE_OPTIONS = [
  { minutes: 15, label: '15 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 180, label: '3 hours' },
  { minutes: 480, label: '8 hours' },
];

function PauseMenu({ disabled, onPause, busy }: { disabled?: boolean; onPause: (minutes: number) => void; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <Button onClick={() => setOpen(!open)} disabled={disabled} busy={busy} aria-haspopup="menu" aria-expanded={open}>
        <Pause className="size-4" /> Pause <ChevronDown className="size-3.5" />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-44 rounded-xl border border-line bg-surface shadow-xl p-1">
          {PAUSE_OPTIONS.map((o) => (
            <button
              key={o.minutes}
              role="menuitem"
              className="w-full text-left text-sm rounded-lg px-3 py-2 hover:bg-surface-2"
              onClick={() => {
                setOpen(false);
                onPause(o.minutes);
              }}
            >
              Pause for {o.label}
            </button>
          ))}
          <p className="text-[11px] text-muted px-3 py-1.5">Always timed, so nothing is left paused by accident.</p>
        </div>
      )}
    </div>
  );
}

function JobActions({ job, onDone }: { job: QueueJob; onDone: () => void }) {
  const toast = useToast();
  const [moveOpen, setMoveOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [pos, setPos] = useState(String(job.index + 1));
  const [blocklist, setBlocklist] = useState(false);
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) => post(`/downloads/job/${encodeURIComponent(job.nzoId)}/${action}`, body),
    onSuccess: (_d, v) => {
      toast(
        v.action === 'bump' ? 'Bumped to the top of the High band' : v.action === 'cancel' ? 'Cancelled' : v.action === 'move' ? 'Moved' : 'Done',
        'ok',
      );
      onDone();
    },
  });
  return (
    <div className="flex items-center gap-1 justify-end">
      <Button size="sm" variant="ghost" title="Bump to top: moves to the top of the High band. Saga never uses Force (it would ignore the guard's pause)." aria-label="Bump to top" busy={act.isPending && act.variables?.action === 'bump'} onClick={() => act.mutate({ action: 'bump' })}>
        <ArrowUpToLine className="size-4" />
      </Button>
      <select
        aria-label="Priority"
        className="rounded-md bg-surface-2 border border-line text-xs px-1 py-1"
        value={['Low', 'Normal', 'High'].includes(job.priority) ? job.priority : ''}
        onChange={(e) => e.target.value && act.mutate({ action: 'priority', body: { priority: e.target.value } })}
      >
        {!['Low', 'Normal', 'High'].includes(job.priority) && <option value="">{job.priority}</option>}
        <option value="Low">Low</option>
        <option value="Normal">Normal</option>
        <option value="High">High</option>
      </select>
      <Button size="sm" variant="ghost" onClick={() => setMoveOpen(true)} aria-label="Move to position">
        #
      </Button>
      {job.status === 'Paused' ? (
        <Button size="sm" variant="ghost" aria-label="Resume job" onClick={() => act.mutate({ action: 'resume' })}>
          <Play className="size-4" />
        </Button>
      ) : (
        <Button size="sm" variant="ghost" aria-label="Pause job" onClick={() => act.mutate({ action: 'pause' })}>
          <Pause className="size-4" />
        </Button>
      )}
      <Button size="sm" variant="ghost" aria-label="Cancel job" onClick={() => setCancelOpen(true)}>
        <Trash2 className="size-4 text-bad" />
      </Button>
      <Modal open={moveOpen} onClose={() => setMoveOpen(false)} title="Move to position">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(pos);
            if (n >= 1) act.mutate({ action: 'move', body: { index: n - 1 } }, { onSuccess: () => setMoveOpen(false) });
          }}
        >
          <p className="text-sm text-muted truncate">{job.name}</p>
          <input className={inputCls} type="number" min={1} value={pos} onChange={(e) => setPos(e.target.value)} aria-label="New position" />
          <p className="text-xs text-muted">SAB keeps priority bands in order, so a job can't move above higher-priority jobs.</p>
          <div className="flex justify-end">
            <Button variant="primary" type="submit" busy={act.isPending}>
              Move
            </Button>
          </div>
        </form>
      </Modal>
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel download">
        <div className="space-y-3">
          <p className="text-sm break-all">{job.name}</p>
          <p className="text-sm text-muted">
            {job.arr ? `Cancelled through ${job.arr.app === 'radarr' ? 'Radarr' : 'Sonarr'} so it isn't treated as a failure.` : 'Not tracked by an *arr; it will be deleted from SAB.'}
          </p>
          {job.arr && <Toggle checked={blocklist} onChange={setBlocklist} label="Blocklist this release and search again" />}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>
              Keep
            </Button>
            <Button variant="danger" busy={act.isPending} onClick={() => act.mutate({ action: 'cancel', body: { blocklist } }, { onSuccess: () => setCancelOpen(false) })}>
              Cancel download
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default function DownloadsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const key = ['downloads', offset, debounced, category];
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<DownloadsSnapshot>(`/downloads${qs({ offset, limit: PAGE, search: debounced, category })}`),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['downloads'] });
  const pause = useMutation({ mutationFn: (minutes: number) => post('/downloads/pause', { minutes }), onSuccess: (_d, m) => (toast(`Paused for ${duration(m * 60)}`, 'ok'), refresh()) });
  const resume = useMutation({ mutationFn: () => post('/downloads/resume'), onSuccess: () => (toast('Resumed', 'ok'), refresh()) });
  const repoll = useMutation({ mutationFn: () => post('/downloads/refresh'), onSuccess: refresh });

  if (q.isLoading) return <Spinner />;
  if (q.error && !q.data) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const g = d.guard;
  const timed = d.pauseReason?.startsWith('Timed pause');

  return (
    <div>
      <PageHeader
        title="Downloads"
        sub={d.updatedAt ? `SAB queue as of ${new Date(d.updatedAt).toLocaleTimeString()}` : 'Waiting for the first SAB poll'}
        actions={
          <>
            <Button variant="ghost" onClick={() => repoll.mutate()} busy={repoll.isPending} aria-label="Refresh now">
              <RefreshCw className="size-4" />
            </Button>
            {d.sabPaused ? (
              <Button variant="primary" onClick={() => resume.mutate()} busy={resume.isPending} disabled={g.paused} title={g.paused ? 'The PP guard made this pause; it resumes on its own.' : undefined}>
                <Play className="size-4" /> Resume
              </Button>
            ) : null}
            <PauseMenu onPause={(m) => pause.mutate(m)} busy={pause.isPending} disabled={d.sabPaused && !timed && g.paused} />
          </>
        }
      />

      {g.available && !g.fresh && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-bad/50 bg-bad/10 px-4 py-3 text-sm text-bad">
          <ShieldAlert className="size-5 shrink-0" />
          <div>
            The PP guard's heartbeat is {g.heartbeatAgeSec !== null ? duration(g.heartbeatAgeSec) : 'missing'} old. Its cron may have stopped, so nothing is protecting SAB from a
            post-processing backlog.
          </div>
        </div>
      )}
      {g.paused && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-violet/50 bg-violet/10 px-4 py-3 text-sm">
          <ShieldAlert className="size-5 shrink-0 text-violet" />
          <div>
            <div className="font-medium">The PP guard paused downloads because post-processing is backed up; it resumes on its own.</div>
            <div className="text-muted mt-0.5">
              Paused since {g.pausedSince ? new Date(g.pausedSince * 1000).toLocaleTimeString() : '—'}. Saga won't resume a pause the guard made.
            </div>
          </div>
        </div>
      )}
      {d.sabPaused && !g.paused && d.pauseReason && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-warn/50 bg-warn/10 px-4 py-3 text-sm">
          <AlertTriangle className="size-5 shrink-0 text-warn" />
          <div>
            <span className="font-medium">SAB is paused:</span> {d.pauseReason}
          </div>
        </div>
      )}
      {!g.available && <p className="mb-4 text-xs text-muted">PP guard state unavailable (download host status feed not configured or not reachable).</p>}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
        <Stat label="Speed now" value={d.sabPaused ? 'Paused' : rate(d.speedBps)} sub={d.speedLimitBps ? `limit ${rate(d.speedLimitBps)}` : undefined} tone={d.sabPaused ? 'warn' : undefined} />
        <Stat label="Effective rate" value={rate(d.rateBps)} sub={d.rateWindowMin ? `over ${d.rateWindowMin >= 60 ? `${d.rateWindowMin / 60} h` : `${d.rateWindowMin} min`}, pauses included` : 'live speed (no history yet)'} />
        <Stat label="Jobs queued" value={d.totalJobs.toLocaleString()} />
        <Stat label="Left to download" value={bytes(d.totalLeftBytes)} />
        <Stat label="Backlog ETA" value={`~${duration(d.backlogEtaSec)}`} sub="at the effective rate" />
        <Stat label="Waiting for post-processing" value={d.postProcessing.length} tone={d.postProcessing.length >= 3 ? 'warn' : undefined} />
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        <button onClick={() => (setCategory(''), setOffset(0))} className={`rounded-full px-3 py-1 text-xs border ${category === '' ? 'border-accent bg-accent/15' : 'border-line bg-surface'}`}>
          All
        </button>
        {d.categories.map((c) => (
          <button
            key={c.category}
            onClick={() => (setCategory(c.category), setOffset(0))}
            className={`rounded-full px-3 py-1 text-xs border ${category === c.category ? 'border-accent bg-accent/15' : 'border-line bg-surface'}`}
          >
            {c.category} · {c.jobs.toLocaleString()} · {bytes(c.leftBytes, 1)}
          </button>
        ))}
      </div>

      {d.postProcessing.length > 0 && (
        <Card title="Post-processing" className="mb-4">
          <ul className="text-sm divide-y divide-line">
            {d.postProcessing.map((p) => (
              <li key={p.nzoId} className="py-1.5 flex items-center gap-3">
                <span className="rounded bg-violet/20 text-violet text-[11px] px-1.5 py-0.5 font-medium shrink-0">{p.status}</span>
                <span className="truncate flex-1" title={p.name}>
                  {p.name}
                </span>
                {p.actionLine && <span className="text-xs text-muted truncate max-w-[40%]">{p.actionLine}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Problems />

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input className={`${inputCls} max-w-sm`} placeholder="Filter by name or title" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Filter jobs" />
        <span className="text-xs text-muted">
          {d.jobsTotalMatched.toLocaleString()} job{d.jobsTotalMatched === 1 ? '' : 's'}
        </span>
        <span className="text-xs text-muted ml-auto hidden lg:block">Bump moves a job to the top of the High band. Saga never uses Force (it would ignore the guard's pause).</span>
      </div>

      <div className="rounded-xl border border-line bg-surface overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted text-left">
            <tr className="border-b border-line">
              <th className="px-3 py-2 w-14">#</th>
              <th className="px-3 py-2">Job</th>
              <th className="px-3 py-2 hidden md:table-cell">Cat.</th>
              <th className="px-3 py-2 hidden md:table-cell">Priority</th>
              <th className="px-3 py-2 w-40">Progress</th>
              <th className="px-3 py-2 hidden sm:table-cell">Left</th>
              <th className="px-3 py-2">ETA</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {d.jobs.map((j) => (
              <tr key={j.nzoId} className="border-b border-line last:border-0 hover:bg-surface-2/50 align-top">
                <td className="px-3 py-2 tabular-nums text-muted">{j.index + 1}</td>
                <td className="px-3 py-2 min-w-[14rem] max-w-[28rem]">
                  {j.arr ? (
                    <>
                      {j.arr.tmdbId ? (
                        <Link to={`/${j.arr.mediaType}/${j.arr.tmdbId}`} className="font-medium hover:text-accent">
                          {j.arr.title}
                        </Link>
                      ) : (
                        <span className="font-medium">{j.arr.title}</span>
                      )}
                      {j.arr.episode && <span className="text-muted"> · {j.arr.episode}</span>}
                      <div className="text-xs text-muted truncate" title={j.name}>
                        {j.name}
                      </div>
                    </>
                  ) : (
                    <div className="truncate" title={j.name}>
                      {j.name}
                    </div>
                  )}
                  <div className="text-[11px] text-muted md:hidden">
                    {j.category} · {j.priority} · {j.status}
                  </div>
                </td>
                <td className="px-3 py-2 hidden md:table-cell text-muted">{j.category}</td>
                <td className="px-3 py-2 hidden md:table-cell">
                  <span className={j.priority === 'High' ? 'text-accent' : j.priority === 'Force' ? 'text-bad' : 'text-muted'}>{j.priority}</span>
                </td>
                <td className="px-3 py-2">
                  <ProgressBar value={j.percent} tone={j.status === 'Paused' ? 'warn' : 'info'} />
                  <div className="text-[11px] text-muted mt-1">
                    {j.percent}% · {j.status}
                  </div>
                </td>
                <td className="px-3 py-2 hidden sm:table-cell tabular-nums whitespace-nowrap">
                  {bytes(j.leftBytes)}
                  <span className="text-muted"> / {bytes(j.sizeBytes)}</span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                  <div>~{duration(j.etaSec)}</div>
                  {j.startsInSec !== null && j.startsInSec > 60 && <div className="text-[11px] text-muted">starts in ~{duration(j.startsInSec)}</div>}
                </td>
                <td className="px-3 py-2">
                  <JobActions job={j} onDone={refresh} />
                </td>
              </tr>
            ))}
            {d.jobs.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted">
                  {d.totalJobs ? 'No jobs match.' : 'The queue is empty.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {d.jobsTotalMatched > PAGE && (
        <div className="flex items-center justify-center gap-3 mt-4 text-sm">
          <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Previous
          </Button>
          <span className="text-muted tabular-nums">
            {offset + 1}–{Math.min(offset + PAGE, d.jobsTotalMatched)} of {d.jobsTotalMatched.toLocaleString()}
          </span>
          <Button size="sm" disabled={offset + PAGE >= d.jobsTotalMatched} onClick={() => setOffset(offset + PAGE)}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
