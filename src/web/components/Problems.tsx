import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, ChevronDown, Download, RefreshCw, RotateCcw, Search, X } from 'lucide-react';
import type { Problem, ReleaseOption } from '../../shared/types.ts';
import { get, post } from '../api.ts';
import { bytes, relTime } from '../format.ts';
import { Button, ErrorBox, Modal, Spinner, Toggle } from './ui.tsx';
import { useToast } from './toast.tsx';
import { AgentTaskView } from './AgentTask.tsx';

/**
 * Downloads → Problems: *arr queue items stuck in warning/error, plus SAB failures no *arr is tracking any more
 * (those are never re-searched by themselves). Each has one-click fixes.
 */
export function Problems() {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(true);
  const [picking, setPicking] = useState<Problem | null>(null);
  const q = useQuery({ queryKey: ['problems'], queryFn: () => get<Problem[]>('/problems', true), refetchInterval: 60_000 });
  const refresh = useMutation({
    mutationFn: () => get<Problem[]>('/problems?refresh=1'),
    onSuccess: (d) => qc.setQueryData(['problems'], d),
  });
  const act = useMutation({
    mutationFn: ({ p, action }: { p: Problem; action: 'search' | 'retry' | 'dismiss' | 'agent' }) =>
      post<{ message?: string; taskId?: string }>(`/problems/${encodeURIComponent(p.id)}/${action}`),
    onSuccess: (r) => {
      toast(r.message ?? 'The agent is on it', 'ok');
      qc.invalidateQueries({ queryKey: ['problems'] });
      qc.invalidateQueries({ queryKey: ['downloads'] });
    },
  });
  const items = q.data ?? [];
  if (!items.length && !q.error) return null;

  return (
    <section className="mb-4 rounded-xl border border-warn/50 bg-warn/10">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button className="flex flex-1 items-center gap-2 text-sm font-medium text-left min-w-0" onClick={() => setOpen(!open)} aria-expanded={open}>
          <AlertTriangle className="size-4 text-warn shrink-0" />
          Problems ({items.length})
          <span className="text-xs text-muted font-normal truncate hidden sm:inline">Failed or stuck downloads you can fix from here</span>
          <ChevronDown className={`size-4 ml-auto transition shrink-0 ${open ? 'rotate-180' : ''}`} />
        </button>
        <Button size="sm" variant="ghost" busy={refresh.isPending} onClick={() => refresh.mutate()} title="Check again now">
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {q.error && <div className="px-4 pb-3"><ErrorBox error={q.error} /></div>}
      {open && items.length > 0 && (
        <ul className="divide-y divide-warn/20 border-t border-warn/30">
          {items.map((p) => (
            <li key={p.id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${p.kind === 'sab-failed' ? 'bg-bad text-white' : 'bg-warn text-black'}`}>{p.state}</span>
                {p.tmdbId ? (
                  <Link to={`/${p.mediaType}/${p.tmdbId}`} className="font-medium hover:text-accent">
                    {p.title}
                  </Link>
                ) : (
                  <span className="font-medium">{p.title}</span>
                )}
                <span className="text-xs text-muted">
                  {p.app === 'radarr' ? 'Radarr' : 'Sonarr'}
                  {p.at ? ` · ${relTime(p.at)}` : ''}
                </span>
              </div>
              <div className="font-mono text-[11px] text-muted break-all mt-0.5">{p.release}</div>
              {p.messages.length > 0 && (
                <ul className="mt-1 text-xs list-disc pl-5 space-y-0.5">
                  {p.messages.map((m, n) => (
                    <li key={n}>{m}</li>
                  ))}
                </ul>
              )}
              {!p.tracked && (
                <p className="mt-1 text-xs text-muted">
                  {p.app === 'radarr' ? 'Radarr' : 'Sonarr'} isn't tracking this download any more, so nothing will search for it again unless you do.
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  busy={act.isPending && act.variables?.p.id === p.id && act.variables.action === 'search'}
                  onClick={() => act.mutate({ p, action: 'search' })}
                  title={p.tracked ? 'Blocklist this release and let the *arr grab the next best one' : 'Search the indexers for this title again'}
                >
                  <Search className="size-3.5" /> {p.tracked ? 'Blocklist & search again' : 'Search again'}
                </Button>
                <Button size="sm" onClick={() => setPicking(p)} title="See every release the indexers have and pick one">
                  <Download className="size-3.5" /> Pick a release
                </Button>
                {p.actions.includes('retry') && (
                  <Button
                    size="sm"
                    busy={act.isPending && act.variables?.p.id === p.id && act.variables.action === 'retry'}
                    onClick={() => act.mutate({ p, action: 'retry' })}
                    title="Retry in SABnzbd (re-fetches only the missing pieces). Rarely helps when the files themselves are bad."
                  >
                    <RotateCcw className="size-3.5" /> Retry in SAB
                  </Button>
                )}
                {!p.agentTaskId && (
                  <Button
                    size="sm"
                    busy={act.isPending && act.variables?.p.id === p.id && act.variables.action === 'agent'}
                    onClick={() => act.mutate({ p, action: 'agent' })}
                    title="Hand this to your maintenance agent: it diagnoses and fixes it on its own, with its usual guardrails, and reports back here"
                  >
                    <Bot className="size-3.5" /> Ask the agent
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => act.mutate({ p, action: 'dismiss' })} title="Hide this problem">
                  <X className="size-3.5" /> Dismiss
                </Button>
              </div>
              {p.agentTaskId && <AgentTaskView taskId={p.agentTaskId} />}
            </li>
          ))}
        </ul>
      )}
      {picking && <ReleasePicker problem={picking} onClose={() => setPicking(null)} />}
    </section>
  );
}

function ReleasePicker({ problem, onClose }: { problem: Problem; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [bump, setBump] = useState(true);
  const [showRejected, setShowRejected] = useState(false);
  const q = useQuery({
    queryKey: ['problem-releases', problem.id],
    queryFn: () => get<ReleaseOption[]>(`/problems/${encodeURIComponent(problem.id)}/releases`),
    staleTime: 5 * 60_000,
  });
  const grab = useMutation({
    mutationFn: (r: ReleaseOption) => post<{ message: string }>(`/problems/${encodeURIComponent(problem.id)}/grab`, { guid: r.guid, indexerId: r.indexerId, bump }),
    onSuccess: (r) => {
      toast(r.message, 'ok');
      qc.invalidateQueries({ queryKey: ['problems'] });
      qc.invalidateQueries({ queryKey: ['downloads'] });
      onClose();
    },
  });
  const rows = (q.data ?? []).filter((r) => showRejected || !r.rejected);
  const rejectedCount = (q.data ?? []).filter((r) => r.rejected).length;

  return (
    <Modal open onClose={onClose} title={`Pick a release: ${problem.title}`} wide>
      <p className="text-xs text-muted mb-3">
        Grabbing goes through {problem.app === 'radarr' ? 'Radarr' : 'Sonarr'}, so it tracks the download and handles a failure itself. Prefer a
        different upload (another indexer or size) over one marked <em>same as failed</em>.
      </p>
      <div className="flex flex-wrap items-center gap-4 mb-3">
        <Toggle checked={bump} onChange={setBump} label="Jump to the top of the queue when it arrives" />
        {rejectedCount > 0 && <Toggle checked={showRejected} onChange={setShowRejected} label={`Show ${rejectedCount} rejected`} />}
      </div>
      {q.isLoading ? (
        <Spinner label="Searching the indexers (can take a minute)" />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : !rows.length ? (
        <p className="text-sm text-muted">No releases found{rejectedCount ? ' that pass your profile' : ''}.</p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-xs">
            <thead className="text-muted text-left">
              <tr>
                <th className="py-1 px-1 font-medium">Release</th>
                <th className="py-1 px-1 font-medium">Indexer</th>
                <th className="py-1 px-1 font-medium text-right">Size</th>
                <th className="py-1 px-1 font-medium text-right">Age</th>
                <th className="py-1 px-1 font-medium text-right">Score</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.guid} className={r.rejected ? 'opacity-60' : ''}>
                  <td className="py-1.5 px-1 font-mono break-all">
                    {r.title}
                    {r.sameAsFailed && <span className="ml-1 rounded bg-warn/20 text-warn px-1 font-sans">same as failed</span>}
                    {r.rejected && r.rejections.length > 0 && <div className="font-sans text-bad mt-0.5">{r.rejections.join('; ')}</div>}
                  </td>
                  <td className="py-1.5 px-1 whitespace-nowrap">{r.indexer}</td>
                  <td className="py-1.5 px-1 text-right whitespace-nowrap">{bytes(r.size)}</td>
                  <td className="py-1.5 px-1 text-right whitespace-nowrap">{r.ageDays}d</td>
                  <td className="py-1.5 px-1 text-right">{r.score}</td>
                  <td className="py-1.5 px-1 text-right">
                    <Button size="sm" variant={r.rejected ? 'ghost' : 'primary'} busy={grab.isPending && grab.variables?.guid === r.guid} onClick={() => grab.mutate(r)}>
                      Grab
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
