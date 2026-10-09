import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { GuestCard, MediaType } from '../types.ts';
import { get } from '../api.ts';
import { Card, Loading } from '../components.tsx';
import { useMe } from '../App.tsx';

function Rail({ id, title }: { id: string; title: string; type: MediaType }) {
  const { data, isLoading } = useQuery({ queryKey: ['rail', id], queryFn: () => get<{ results: GuestCard[] }>(`/rail/${id}`) });
  return (
    <section className="mb-7">
      <h2 className="font-semibold mb-2">{title}</h2>
      {isLoading ? (
        <div className="flex gap-3 overflow-hidden">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton w-32 sm:w-36 aspect-[2/3] rounded-xl shrink-0" />)}</div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 snap-x">
          {(data?.results ?? []).map((c) => (
            <div key={`${c.mediaType}:${c.tmdbId}`} className="snap-start">
              <Card card={c} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function HomePage() {
  const { me } = useMe();
  const { data: rails, isLoading } = useQuery({ queryKey: ['rails'], queryFn: () => get<{ id: string; title: string; type: MediaType }[]>('/rails') });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: () => get<{ posts: { id: number; message: string; level: string }[]; auto: { level: string; message: string }[] }>('/status'), refetchInterval: 5 * 60_000 });
  const notes = [...(status?.posts ?? []), ...(status?.auto ?? [])];
  return (
    <div>
      {notes.map((n, i) => (
        <div key={i} className={`mb-3 rounded-lg border px-3 py-2 text-sm ${n.level === 'warn' ? 'border-warn/50 bg-warn/10' : 'border-line bg-surface'}`}>
          {n.message}
        </div>
      ))}
      <div className="flex items-end justify-between mb-4 gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Hi{me ? `, ${me.username}` : ''}</h1>
          <p className="text-sm text-muted">
            Find something, tap it, and request it. Or paste an IMDb or Letterboxd link into <Link to="/search" className="text-accent">Search</Link>.
          </p>
        </div>
      </div>
      {isLoading ? <Loading /> : rails?.map((r) => <Rail key={r.id} {...r} />)}
    </div>
  );
}
