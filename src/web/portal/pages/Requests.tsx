import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { RequestView } from '../types.ts';
import { get } from '../api.ts';
import { Loading, Steps } from '../components.tsx';
import { ProblemButton } from './Title.tsx';
import { img, relTime } from '../../format.ts';

export function RequestRow({ r }: { r: RequestView }) {
  return (
    <li className="flex gap-3 rounded-xl border border-line bg-surface p-3">
      <Link to={`/${r.mediaType}/${r.tmdbId}`} className="shrink-0">
        <img src={img(r.posterPath, 'w185')} alt="" className="w-14 aspect-[2/3] rounded-lg object-cover bg-surface-2" />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <Link to={`/${r.mediaType}/${r.tmdbId}`} className="font-medium leading-tight hover:text-accent">
            {r.title} {r.year && <span className="text-muted font-normal">({r.year})</span>}
            {r.seasons && <span className="text-muted font-normal text-sm"> · S{r.seasons.join(', S')}</span>}
          </Link>
          <span className="text-xs text-muted whitespace-nowrap">{relTime(r.createdAt)}</span>
        </div>
        <div className="mt-2">
          <Steps r={r} />
        </div>
        <div className="mt-1 flex items-center gap-3">
          {r.plexUrl && (
            <a href={r.plexUrl} target="_blank" rel="noreferrer" className="text-sm text-accent">
              Watch in Plex →
            </a>
          )}
          {r.step === 'available' && <ProblemButton mediaType={r.mediaType} tmdbId={r.tmdbId} />}
        </div>
      </div>
    </li>
  );
}

export default function RequestsPage() {
  const { data, isLoading } = useQuery({ queryKey: ['requests'], queryFn: () => get<RequestView[]>('/requests'), refetchInterval: 30_000 });
  const { data: problems } = useQuery({
    queryKey: ['problems'],
    queryFn: () => get<{ id: number; title: string; kind: string; status: string; resolutionNote: string | null; createdAt: number }[]>('/problems'),
  });
  if (isLoading) return <Loading />;
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-4">My requests</h1>
      {!data?.length ? (
        <p className="text-muted text-sm">
          Nothing yet. <Link to="/" className="text-accent">Find something to request</Link>.
        </p>
      ) : (
        <ul className="space-y-3">
          {data.map((r) => (
            <RequestRow key={r.id} r={r} />
          ))}
        </ul>
      )}
      {!!problems?.length && (
        <section className="mt-8">
          <h2 className="font-semibold mb-2">Problems you reported</h2>
          <ul className="space-y-2 text-sm">
            {problems.map((p) => (
              <li key={p.id} className="rounded-lg border border-line bg-surface px-3 py-2">
                <span className="font-medium">{p.title}</span> · {p.kind.replace('_', ' ')} ·{' '}
                <span className={p.status === 'resolved' ? 'text-ok' : 'text-warn'}>{p.status === 'resolved' ? `fixed${p.resolutionNote ? `: ${p.resolutionNote}` : ''}` : 'open'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
