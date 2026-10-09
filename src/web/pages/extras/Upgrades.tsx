import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { get, post } from '../../api.ts';
import { bytes, relTime } from '../../format.ts';
import { Button, Card, ErrorBox, inputCls, Segmented, Spinner, Stat } from '../../components/ui.tsx';
import { useToast } from '../../components/toast.tsx';

interface UpgradeItem {
  key: string;
  app: 'radarr' | 'sonarr';
  id: number;
  seasonNumber?: number;
  tmdbId?: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year?: number;
  episodes?: number;
  quality: string;
  resolution?: number;
  score: number | null;
  cutoffScore: number;
  cutoffQuality: string;
  reason: 'quality' | 'score';
  sizeBytes: number;
  estBytes: number;
  profile: string;
}
interface UpgradesResponse {
  items: UpgradeItem[];
  totals: { movies: number; seasons: number; episodes: number };
  generatedAt: number;
}

const MAX = 50;

export default function Upgrades() {
  const qc = useQueryClient();
  const toast = useToast();
  const [app, setApp] = useState<'all' | 'radarr' | 'sonarr'>('all');
  const [reason, setReason] = useState<'all' | 'quality' | 'score'>('quality');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const data = useQuery({ queryKey: ['extras-upgrades'], queryFn: () => get<UpgradesResponse>('/extras/upgrades'), staleTime: 5 * 60_000 });
  const refresh = useMutation({
    mutationFn: () => get<UpgradesResponse>('/extras/upgrades?refresh=1'),
    onSuccess: (d) => qc.setQueryData(['extras-upgrades'], d),
  });
  const search = useMutation({
    mutationFn: (keys: string[]) => post<{ started: number; messages: string[] }>('/extras/upgrades/search', { keys }),
    onSuccess: (r) => {
      toast(r.messages.join(' · ') || `${r.started} search(es) started`, 'ok');
      setSel(new Set());
    },
  });

  const items = useMemo(() => {
    const needle = q.toLowerCase().trim();
    return (data.data?.items ?? []).filter((i) => (app === 'all' || i.app === app) && (reason === 'all' || i.reason === reason) && (!needle || i.title.toLowerCase().includes(needle)));
  }, [data.data, app, reason, q]);
  const chosen = items.filter((i) => sel.has(i.key));
  const estTotal = chosen.reduce((a, i) => a + i.estBytes, 0);

  if (data.isLoading) return <Spinner label="Reading cutoff-unmet lists from Radarr and Sonarr" />;
  if (data.error) return <ErrorBox error={data.error} />;
  const d = data.data!;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Films below cutoff" value={d.totals.movies.toLocaleString()} />
        <Stat label="Seasons below cutoff" value={d.totals.seasons.toLocaleString()} sub={`${d.totals.episodes.toLocaleString()} episodes`} />
        <Stat label="Below quality cutoff" value={d.items.filter((i) => i.reason === 'quality').length.toLocaleString()} sub="the rest only miss the custom-format score" />
        <Stat label="Checked" value={relTime(d.generatedAt)} />
      </div>
      <p className="text-xs text-muted">
        Profiles are read live from Radarr and Sonarr: cutoff quality and custom-format cutoff score come from them, nothing is copied into Saga. A cutoff
        score of 10,000 means nearly every file is "below cutoff" on score alone, so the default filter shows only files below the <em>quality</em> cutoff.
      </p>
      <Card
        title="Below cutoff"
        actions={
          <Button size="sm" variant="ghost" onClick={() => refresh.mutate()} busy={refresh.isPending}>
            <RefreshCw className="size-3.5" /> Re-check
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Segmented value={app} onChange={setApp} options={[{ value: 'all', label: 'All' }, { value: 'radarr', label: 'Films' }, { value: 'sonarr', label: 'TV' }]} />
          <Segmented value={reason} onChange={setReason} options={[{ value: 'quality', label: 'Quality' }, { value: 'score', label: 'Score only' }, { value: 'all', label: 'Both' }]} />
          <input className={`${inputCls} max-w-xs`} placeholder="Filter by title" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter by title" />
          <span className="text-xs text-muted">{items.length.toLocaleString()} shown</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 mb-2 text-sm">
          <button className="text-accent text-xs" onClick={() => setSel(new Set(items.slice(0, MAX).map((i) => i.key)))}>
            Select first {Math.min(MAX, items.length)}
          </button>
          <button className="text-muted text-xs hover:text-fg" onClick={() => setSel(new Set())}>
            None
          </button>
          <span className="text-xs text-muted">
            {chosen.length} selected{chosen.length > MAX && <span className="text-warn"> (max {MAX} per click)</span>} · ~{bytes(estTotal, 0)} to download
          </span>
          <Button size="sm" variant="primary" disabled={!chosen.length || chosen.length > MAX} busy={search.isPending} onClick={() => search.mutate(chosen.map((c) => c.key))} className="ml-auto">
            Search for upgrades
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted text-left">
              <tr className="border-b border-line">
                <th className="py-2 w-8" />
                <th className="py-2">Title</th>
                <th className="py-2">Now</th>
                <th className="py-2">Score</th>
                <th className="py-2">Cutoff</th>
                <th className="py-2 text-right">On disk</th>
                <th className="py-2 text-right">Est. upgrade</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.slice(0, 500).map((i) => (
                <tr key={i.key} className="hover:bg-surface-2">
                  <td className="py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${i.title}`}
                      checked={sel.has(i.key)}
                      onChange={(e) => {
                        const s = new Set(sel);
                        if (e.target.checked) s.add(i.key);
                        else s.delete(i.key);
                        setSel(s);
                      }}
                    />
                  </td>
                  <td className="py-1.5">
                    {i.tmdbId ? (
                      <Link to={`/${i.mediaType}/${i.tmdbId}`} className="hover:text-accent">
                        {i.title} {i.year && <span className="text-muted">({i.year})</span>}
                      </Link>
                    ) : (
                      i.title
                    )}
                    {i.episodes && <span className="text-xs text-muted"> · {i.episodes} ep</span>}
                  </td>
                  <td className="py-1.5">
                    <span className={i.reason === 'quality' ? 'text-warn' : ''}>{i.quality}</span>
                  </td>
                  <td className="py-1.5 tabular-nums">{i.score ?? '—'}</td>
                  <td className="py-1.5 text-xs text-muted">
                    {i.cutoffQuality} · {i.cutoffScore.toLocaleString()}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{bytes(i.sizeBytes, 0)}</td>
                  <td className="py-1.5 text-right tabular-nums text-muted">~{bytes(i.estBytes, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length > 500 && <p className="text-xs text-muted mt-2">Showing the first 500; narrow the filter to see more.</p>}
          {!items.length && <p className="text-sm text-muted py-6 text-center">Nothing below cutoff with these filters.</p>}
        </div>
      </Card>
    </div>
  );
}
