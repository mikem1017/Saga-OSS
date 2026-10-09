import { useInfiniteQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { ActivityEntry } from '../../shared/types.ts';
import { get } from '../api.ts';
import { dateTime } from '../format.ts';
import { Button, ErrorBox, PageHeader, Spinner } from '../components/ui.tsx';

const LIMIT = 100;

export default function ActivityPage() {
  const q = useInfiniteQuery({
    queryKey: ['activity'],
    queryFn: ({ pageParam }) => get<ActivityEntry[]>(`/activity?limit=${LIMIT}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length === LIMIT ? last[last.length - 1]!.id : undefined),
    refetchInterval: 30_000,
  });
  const rows = (q.data?.pages ?? []).flat();
  return (
    <div>
      <PageHeader title="Activity" sub="Every action Saga took against another system: who, what and when." />
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      <div className="rounded-xl border border-line bg-surface overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted text-left">
            <tr className="border-b border-line">
              <th className="px-3 py-2 w-8" aria-label="Result" />
              <th className="px-3 py-2 whitespace-nowrap">When</th>
              <th className="px-3 py-2">Who</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 align-top">
                <td className="px-3 py-2">{r.ok ? <CheckCircle2 className="size-4 text-ok" aria-label="ok" /> : <XCircle className="size-4 text-bad" aria-label="failed" />}</td>
                <td className="px-3 py-2 whitespace-nowrap text-muted tabular-nums">{dateTime(r.ts)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.actor}</td>
                <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{r.action}</td>
                <td className="px-3 py-2 max-w-[22rem] break-words">{r.target}</td>
                <td className={`px-3 py-2 max-w-[28rem] break-words text-xs ${r.ok ? 'text-muted' : 'text-bad'}`}>{r.detail}</td>
              </tr>
            ))}
            {!q.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted">
                  Nothing yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && (
        <div className="flex justify-center mt-4">
          <Button onClick={() => q.fetchNextPage()} busy={q.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
