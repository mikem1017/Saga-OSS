import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, Bot, CheckCircle2, CircleAlert, Loader2, RefreshCw, RotateCcw, Search, Undo2 } from 'lucide-react';
import { get, post } from '../api.ts';
import { relTime } from '../format.ts';
import { Button, Card, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui.tsx';
import { useToast } from '../components/toast.tsx';
import { AgentTaskView } from '../components/AgentTask.tsx';

interface StackService {
  service: string;
  image: string;
  state: string;
  runningVersion: string | null;
  pulledVersion: string | null;
  remoteVersion: string | null;
  remoteError: string | null;
  checkedAt: number;
  updateAvailable: boolean;
  restartNeeded: boolean;
}
interface Preflight {
  ppPending: number | null;
  guardPaused: boolean;
  runActive: boolean;
}
interface RunStep {
  service: string;
  phase: string;
  ok?: boolean;
  message?: string;
  oldImage?: string;
  newImage?: string;
  oldVersion?: string | null;
  newVersion?: string | null;
}
interface StackRun {
  id: string;
  services: string[];
  status: 'queued' | 'running' | 'done' | 'failed';
  started: number;
  finished: number | null;
  steps: RunStep[];
  lostJobs: string[];
  rollback: { at: number; results: { service: string; ok: boolean; message: string }[] } | null;
  log: string[];
}

const short = (v: string | null) => (v ? v.replace(/-ls\d+$/, '') : '?');

export default function StackPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ services: string[]; streamsWarning?: string } | null>(null);
  const versions = useQuery({ queryKey: ['stack-versions'], queryFn: () => get<{ ts: number; services: StackService[]; preflight: Preflight }>('/stack/versions') });
  const agentLinks = useQuery({ queryKey: ['agent-links'], queryFn: () => get<{ links: Record<string, string> }>('/agent/tasks', true), retry: false });
  const runs = useQuery({
    queryKey: ['stack-runs'],
    queryFn: () => get<{ runs: StackRun[]; preflight: Preflight }>('/stack/runs', true),
    refetchInterval: (q) => (q.state.data?.runs.some((r) => r.status === 'running' || r.status === 'queued') ? 4000 : 60_000),
  });
  const refresh = useMutation({
    mutationFn: () => get<{ ts: number; services: StackService[]; preflight: Preflight }>('/stack/versions?refresh=1'),
    onSuccess: (d) => qc.setQueryData(['stack-versions'], d),
  });
  const update = useMutation({
    mutationFn: (b: { services: string[]; allowStreaming: boolean }) => post<{ runId: string; services: string[] }>('/stack/update', b, true),
    onSuccess: (r) => {
      toast(`Updating ${r.services.join(', ')}`, 'ok');
      setConfirm(null);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['stack-runs'] });
    },
    onError: (err, vars) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Plex stream/.test(msg) && !vars.allowStreaming) setConfirm({ services: vars.services, streamsWarning: msg });
      else toast(msg, 'error');
    },
  });
  const services = versions.data?.services ?? [];
  const pending = useMemo(() => services.filter((s) => s.updateAvailable || s.restartNeeded).map((s) => s.service), [services]);
  const pf = runs.data?.preflight ?? versions.data?.preflight;
  const running = runs.data?.runs.find((r) => r.status === 'running' || r.status === 'queued');
  const toggle = (s: string) => setSelected((cur) => {
    const n = new Set(cur);
    n.has(s) ? n.delete(s) : n.add(s);
    return n;
  });

  return (
    <div>
      <PageHeader
        title="Stack"
        sub="Container versions on the download host. Updates run one app at a time, SABnzbd last, and wait while SAB is post-processing."
        actions={
          <>
            <Button size="sm" variant="ghost" busy={refresh.isPending} onClick={() => refresh.mutate()} title="Check the registries again">
              <RefreshCw className="size-4" /> Check now
            </Button>
            <Button size="sm" disabled={!selected.size || !!running} onClick={() => setConfirm({ services: [...selected] })}>
              Update selected ({selected.size})
            </Button>
            <Button size="sm" variant="primary" disabled={!pending.length || !!running} onClick={() => setConfirm({ services: pending })}>
              <ArrowUpCircle className="size-4" /> Update all ({pending.length})
            </Button>
          </>
        }
      />
      {pf && (pf.ppPending || pf.guardPaused) ? (
        <p className="mb-3 text-xs text-warn">
          SABnzbd is post-processing ({pf.ppPending ?? '?'} job{pf.ppPending === 1 ? '' : 's'}){pf.guardPaused ? ' and the PP guard holds a pause' : ''}. Other apps can update now; SABnzbd will
          be refused until it's idle.
        </p>
      ) : null}
      {versions.isLoading ? (
        <Spinner label="Checking registries" />
      ) : versions.error ? (
        <ErrorBox error={versions.error} />
      ) : (
        <Card className="mb-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted text-left">
                <tr>
                  <th className="py-1.5 pr-2 w-6" />
                  <th className="py-1.5 pr-2 font-medium">App</th>
                  <th className="py-1.5 pr-2 font-medium">Running</th>
                  <th className="py-1.5 pr-2 font-medium">Available</th>
                  <th className="py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {services.map((s) => (
                  <tr key={s.service}>
                    <td className="py-2 pr-2">
                      <input type="checkbox" aria-label={`Select ${s.service}`} checked={selected.has(s.service)} onChange={() => toggle(s.service)} />
                    </td>
                    <td className="py-2 pr-2 font-medium">
                      {s.service}
                      {s.state !== 'running' && <span className="ml-1 text-xs text-bad">{s.state}</span>}
                    </td>
                    <td className="py-2 pr-2 font-mono text-xs">{short(s.runningVersion)}</td>
                    <td className="py-2 pr-2 font-mono text-xs">{s.remoteError ? '—' : short(s.remoteVersion)}</td>
                    <td className="py-2 text-xs">
                      {s.remoteError ? (
                        <span className="text-bad" title={s.remoteError}>
                          Can't check: {s.remoteError.includes('not found') ? 'image tag no longer exists' : 'registry error'}
                        </span>
                      ) : s.restartNeeded ? (
                        <span className="text-warn">Pulled, needs a restart</span>
                      ) : s.updateAvailable ? (
                        <span className="text-info">Update available</span>
                      ) : (
                        <span className="text-ok">Up to date</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {versions.data && <p className="mt-2 text-xs text-muted">Checked {relTime(Math.min(...services.map((s) => s.checkedAt || versions.data!.ts)) * 1000)}.</p>}
        </Card>
      )}

      <h2 className="text-sm font-semibold mb-2">Recent update runs</h2>
      {runs.isLoading ? <Spinner /> : !runs.data?.runs.length ? <p className="text-sm text-muted">No update runs yet.</p> : runs.data.runs.map((r) => <RunCard key={r.id} run={r} agentTaskId={agentLinks.data?.links[`run:${r.id}`]} />)}

      <Modal open={!!confirm} onClose={() => setConfirm(null)} title="Update these apps?">
        {confirm && (
          <>
            <p className="text-sm">{confirm.services.join(', ')}</p>
            <ul className="mt-3 text-xs text-muted list-disc pl-5 space-y-1">
              <li>Each app restarts once (a few seconds to a minute). Downloads continue afterwards.</li>
              {confirm.services.includes('sabnzbd') && (
                <li>
                  SABnzbd goes last and only while nothing is post-processing. Jobs it can't reload after a version change are listed afterwards, with a button to
                  re-search them.
                </li>
              )}
              <li>The old images are kept, so each app can be rolled back from the run below until Sunday's image prune.</li>
            </ul>
            {confirm.streamsWarning && <p className="mt-3 text-sm text-warn">{confirm.streamsWarning}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button variant="primary" busy={update.isPending} onClick={() => update.mutate({ services: confirm.services, allowStreaming: !!confirm.streamsWarning })}>
                {confirm.streamsWarning ? 'Update anyway' : 'Update'}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

function RunCard({ run, agentTaskId }: { run: StackRun; agentTaskId?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [showLog, setShowLog] = useState(false);
  const askAgent = useMutation({
    mutationFn: () => post<{ taskId: string }>(`/stack/runs/${run.id}/agent`),
    onSuccess: () => {
      toast('The agent is on it', 'ok');
      qc.invalidateQueries({ queryKey: ['agent-links'] });
    },
  });
  const rollback = useMutation({
    mutationFn: (service?: string) => post<StackRun>(`/stack/runs/${run.id}/rollback`, service ? { service } : {}),
    onSuccess: (r) => {
      const res = r.rollback?.results ?? [];
      toast(res.length ? res.map((x) => `${x.service}: ${x.ok ? 'rolled back' : x.message}`).join('; ') : 'Nothing to roll back', res.every((x) => x.ok) ? 'ok' : 'error');
      qc.invalidateQueries({ queryKey: ['stack-runs'] });
      qc.invalidateQueries({ queryKey: ['stack-versions'] });
    },
  });
  const recover = useMutation({
    mutationFn: () => post<{ movies: number; episodes: number; unmatched: string[] }>(`/stack/runs/${run.id}/recover-lost`),
    onSuccess: (r) => toast(`Searching again: ${r.movies} movie(s), ${r.episodes} episode(s)${r.unmatched.length ? `; ${r.unmatched.length} couldn't be matched` : ''}`, 'ok'),
  });
  const changed = run.steps.filter((s) => s.oldImage && s.newImage && s.oldImage !== s.newImage && (s.phase === 'done' || s.phase === 'failed'));
  const active = run.status === 'running' || run.status === 'queued';

  return (
    <Card className="mb-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {active ? <Loader2 className="size-4 animate-spin text-info" /> : run.status === 'done' ? <CheckCircle2 className="size-4 text-ok" /> : <CircleAlert className="size-4 text-bad" />}
        <span className="font-medium">{run.status === 'done' ? 'Updated' : run.status === 'failed' ? 'Stopped with a problem' : 'Updating'}</span>
        <span className="text-xs text-muted">
          {relTime(run.started * 1000)}
          {run.finished ? ` · took ${Math.max(1, Math.round((run.finished - run.started) / 60))} min` : ''}
        </span>
        <div className="ml-auto flex gap-1.5">
          {!active && !agentTaskId && (run.status === 'failed' || run.lostJobs.length > 0) && (
            <Button size="sm" variant="ghost" busy={askAgent.isPending} onClick={() => askAgent.mutate()} title="Hand this run's problems to your maintenance agent">
              <Bot className="size-3.5" /> Ask the agent
            </Button>
          )}
          {!active && changed.length > 0 && (
            <Button size="sm" variant="ghost" busy={rollback.isPending && rollback.variables === undefined} onClick={() => rollback.mutate(undefined)} title="Put every app this run changed back on its previous image">
              <Undo2 className="size-3.5" /> Roll back all
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setShowLog(!showLog)}>
            Log
          </Button>
        </div>
      </div>
      <ul className="mt-2 space-y-1 text-xs">
        {run.steps.map((s) => (
          <li key={s.service} className="flex flex-wrap items-center gap-2">
            <span className="w-20 font-medium">{s.service}</span>
            <span className={s.phase === 'failed' ? 'text-bad' : s.phase === 'done' ? 'text-ok' : s.phase === 'current' ? 'text-muted' : 'text-info'}>
              {s.phase === 'done' ? `${short(s.oldVersion ?? null)} → ${short(s.newVersion ?? null)}` : s.phase === 'current' ? 'already up to date' : s.phase}
            </span>
            {s.message && s.phase !== 'current' && <span className="text-muted">{s.message}</span>}
            {!active && changed.includes(s) && (
              <Button size="sm" variant="ghost" busy={rollback.isPending && rollback.variables === s.service} onClick={() => rollback.mutate(s.service)} title={`Put ${s.service} back on ${short(s.oldVersion ?? null)}`}>
                <RotateCcw className="size-3" /> Roll back
              </Button>
            )}
          </li>
        ))}
      </ul>
      {run.lostJobs.length > 0 && (
        <div className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-2.5 text-xs">
          <p>
            SABnzbd couldn't reload {run.lostJobs.length} part-downloaded job{run.lostJobs.length === 1 ? '' : 's'} after the update, and Radarr/Sonarr won't notice by
            themselves.
          </p>
          <Button size="sm" className="mt-2" busy={recover.isPending} onClick={() => recover.mutate()}>
            <Search className="size-3.5" /> Search for them again
          </Button>
        </div>
      )}
      {run.rollback && (
        <p className="mt-2 text-xs text-muted">
          Rolled back {relTime(run.rollback.at * 1000)}: {run.rollback.results.map((x) => `${x.service} ${x.ok ? 'ok' : 'failed'}`).join(', ')}
        </p>
      )}
      {agentTaskId && <AgentTaskView taskId={agentTaskId} />}
      {showLog && <pre className="mt-2 max-h-64 overflow-auto rounded bg-surface-2 p-2 text-[11px] whitespace-pre-wrap">{run.log.join('\n')}</pre>}
    </Card>
  );
}
