import { useQuery } from '@tanstack/react-query';
import type { GuestCard, RequestView } from '../types.ts';
import { get } from '../api.ts';
import { Grid, Loading } from '../components.tsx';
import { RequestRow } from './Requests.tsx';

export default function SoonPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['coming-soon'],
    queryFn: () => get<{ onTheWay: RequestView[]; readyForYou: RequestView[]; newInLibrary: GuestCard[] }>('/coming-soon'),
    refetchInterval: 60_000,
  });
  const { data: status } = useQuery({
    queryKey: ['status'],
    queryFn: () => get<{ posts: { id: number; message: string; level: string; createdAt: number }[]; auto: { level: string; message: string }[] }>('/status'),
  });
  if (isLoading) return <Loading />;
  const notes = [...(status?.posts ?? []), ...(status?.auto ?? [])];
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-bold tracking-tight mb-2">Coming soon</h1>
        <div className="rounded-xl border border-line bg-surface px-4 py-3 text-sm">
          <div className="font-semibold mb-1">Status</div>
          {notes.length ? (
            <ul className="space-y-1">
              {notes.map((n, i) => (
                <li key={i} className={n.level === 'warn' ? 'text-warn' : ''}>
                  {n.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">Everything's running normally.</p>
          )}
        </div>
      </section>
      <section>
        <h2 className="font-semibold mb-2">On the way for you</h2>
        {data?.onTheWay.length ? (
          <ul className="space-y-3">
            {data.onTheWay.map((r) => (
              <RequestRow key={r.id} r={r} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nothing waiting.</p>
        )}
      </section>
      {!!data?.readyForYou.length && (
        <section>
          <h2 className="font-semibold mb-2">Ready for you</h2>
          <ul className="space-y-3">
            {data.readyForYou.map((r) => (
              <RequestRow key={r.id} r={r} />
            ))}
          </ul>
        </section>
      )}
      {!!data?.newInLibrary.length && (
        <section>
          <h2 className="font-semibold mb-2">New in Plex this week</h2>
          <Grid cards={data.newInLibrary} />
        </section>
      )}
    </div>
  );
}
