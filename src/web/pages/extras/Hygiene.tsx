import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api.ts';
import { Card, ErrorBox, inputCls, Spinner } from '../../components/ui.tsx';

interface Item {
  kind: 'missing-stale' | 'unmonitored' | 'duplicate' | 'queue-warning' | 'kept-leftover' | 'unpack-leftover';
  app: string;
  title: string;
  detail: string;
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
  ageDays?: number;
}
interface Hygiene {
  items: Item[];
  counts: Record<string, number>;
  feedNote: string;
  agentJournalHint: string;
}

const KINDS: { kind: Item['kind']; title: string; blurb: string }[] = [
  { kind: 'queue-warning', title: 'Stuck in the *arr queue', blurb: 'Downloads Radarr/Sonarr flagged with a warning or error (blocked import, unknown title, missing files).' },
  { kind: 'missing-stale', title: 'Wanted for a long time, nothing queued', blurb: 'Monitored, no file, and nothing in the download queue. Usually needs a manual search or a different release.' },
  { kind: 'kept-leftover', title: 'Kept in complete/ (old import only)', blurb: 'Folders a name-based cleanup would keep because they only match an older import. Some are real files that never imported; check before deleting.' },
  { kind: 'unpack-leftover', title: '_UNPACK_ leftovers', blurb: 'Interrupted unpacks. A few have held complete, never-imported films; ffprobe before removing.' },
  { kind: 'duplicate', title: 'Duplicate entries', blurb: 'More than one *arr entry for the same TMDB id.' },
  { kind: 'unmonitored', title: 'Unmonitored', blurb: 'Saga, Radarr and Sonarr will not search or upgrade these.' },
];

export default function HygienePage() {
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ['extras-hygiene', days], queryFn: () => get<Hygiene>(`/extras/hygiene?days=${days}`) });
  if (q.isLoading) return <Spinner label="Checking the library" />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-info/40 bg-info/10 px-4 py-3 text-sm">
        <strong>Report only.</strong> Nothing here deletes anything. {d.agentJournalHint}{' '}
        <Link to="/dashboard" className="text-accent">
          Agent journal →
        </Link>
      </div>
      <label className="flex items-center gap-2 text-sm">
        Treat as stale after
        <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 30))} className={`${inputCls} w-20`} aria-label="Days" />
        days
      </label>
      {KINDS.map((k) => {
        const items = d.items.filter((i) => i.kind === k.kind);
        return (
          <Card key={k.kind} title={`${k.title} (${items.length})`}>
            <p className="text-xs text-muted mb-2">{k.blurb}</p>
            {items.length ? (
              <ul className="divide-y divide-line text-sm max-h-80 overflow-y-auto">
                {items.slice(0, 300).map((i, n) => (
                  <li key={`${i.title}-${n}`} className="py-1.5">
                    {i.tmdbId && i.mediaType ? (
                      <Link to={`/${i.mediaType}/${i.tmdbId}`} className="font-medium hover:text-accent">
                        {i.title}
                      </Link>
                    ) : (
                      <span className="font-medium font-mono text-xs break-all">{i.title}</span>
                    )}
                    <span className="text-xs text-muted"> · {i.app}</span>
                    <div className="text-xs text-muted break-words">{i.detail}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">None.</p>
            )}
            {(k.kind === 'kept-leftover' || k.kind === 'unpack-leftover') && <p className="text-[11px] text-muted mt-2">{d.feedNote}</p>}
          </Card>
        );
      })}
    </div>
  );
}
