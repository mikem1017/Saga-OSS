import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../../api.ts';
import { relTime } from '../../format.ts';
import { Card, ErrorBox, Spinner, Toggle } from '../../components/ui.tsx';

interface Status {
  enabled: boolean;
  watchedShows: string[];
  recent: { ts: number; title: string; episode: string }[];
}

export default function AutoBumpPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['extras-autobump'], queryFn: () => get<Status>('/extras/autobump'), refetchInterval: 60_000 });
  const set = useMutation({ mutationFn: (enabled: boolean) => put<Status>('/extras/autobump', { enabled }), onSuccess: (s) => qc.setQueryData(['extras-autobump'], s) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data!;
  return (
    <div className="space-y-4">
      <Card title="Release-aware auto-bump">
        <p className="text-sm text-muted mb-3">
          When Sonarr grabs a new episode (aired in the last 14 days) of a show someone in the house watched in the last 14 days, Saga moves it to the top of SAB's High band, so it
          doesn't wait behind the movie backlog. Same bump as the Downloads page: High priority plus move to top, never Force, so the PP guard's pauses still hold. Checked every
          5 minutes; each download is bumped at most once and every bump is in the Activity log as <code>auto-bump</code>.
        </p>
        <Toggle checked={s.enabled} onChange={(v) => set.mutate(v)} label={s.enabled ? 'On' : 'Off'} />
      </Card>
      <div className="grid md:grid-cols-2 gap-4">
        <Card title={`Watched recently (${s.watchedShows.length})`}>
          {s.watchedShows.length ? (
            <ul className="text-sm space-y-1">
              {s.watchedShows.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No TV watched in the last 14 days (per Tautulli).</p>
          )}
        </Card>
        <Card title="Recent auto-bumps">
          {s.recent.length ? (
            <ul className="text-sm divide-y divide-line">
              {s.recent.map((r) => (
                <li key={`${r.ts}-${r.episode}`} className="py-1.5 flex justify-between gap-2">
                  <span>
                    {r.title} <span className="text-muted">{r.episode}</span>
                  </span>
                  <span className="text-xs text-muted whitespace-nowrap">{relTime(r.ts)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">None yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
