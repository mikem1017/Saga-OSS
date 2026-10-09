import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { Page, TitleCard } from '../../shared/types.ts';
import { get } from '../api.ts';
import { PosterGrid } from './Poster.tsx';
import { Button, ErrorBox } from './ui.tsx';
import { useQuickAdd } from './AddDialog.tsx';
import { SelectAllButton, SelectToggle, useSelection } from './Selection.tsx';

const BATCHES = [20, 50, 100, 250] as const;
const STORE_KEY = 'saga.batchSize';

function readBatch(): number {
  try {
    const n = Number(localStorage.getItem(STORE_KEY));
    return BATCHES.includes(n as (typeof BATCHES)[number]) ? n : 20;
  } catch {
    return 20;
  }
}

/**
 * Infinite poster grid over any paged endpoint. `path` must not include page=.
 * "Show N" (remembered per browser) loads that many titles up front, so a whole batch can be selected and added at once.
 */
export function PagedGrid({ path, queryKey, empty = 'Nothing found.' }: { path: string; queryKey: unknown[]; empty?: string }) {
  const sep = path.includes('?') ? '&' : '?';
  const [batch, setBatch] = useState(readBatch);
  const [target, setTarget] = useState(batch);
  const q = useInfiniteQuery({
    queryKey: ['paged', ...queryKey],
    queryFn: ({ pageParam }) => get<Page<TitleCard>>(`${path}${sep}page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.nextPage !== undefined ? last.nextPage : last.filtered ? undefined : last.page < last.totalPages ? last.page + 1 : undefined),
  });
  const { onAdd, dialog } = useQuickAdd();
  const sel = useSelection();
  const sentinel = useRef<HTMLDivElement>(null);
  const seen = new Set<string>();
  const cards = (q.data?.pages ?? []).flatMap((p) => p.results).filter((c) => {
    const k = `${c.mediaType}:${c.tmdbId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Keep fetching pages (TMDB gives 20 a page) until the chosen batch is loaded.
  useEffect(() => {
    if (cards.length < target && q.hasNextPage && !q.isFetching) void q.fetchNextPage();
  }, [cards.length, target, q.hasNextPage, q.isFetching, q.fetchNextPage]);
  useEffect(() => {
    setTarget(batch);
  }, [path, batch]);

  // Past the batch, scrolling to the bottom loads the next batch.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && q.hasNextPage && !q.isFetching && cards.length >= target) setTarget((t) => t + batch);
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [q.hasNextPage, q.isFetching, cards.length, target, batch]);

  const total = q.data?.pages[0]?.totalResults;
  const loadingMore = cards.length < target && q.hasNextPage;
  return (
    <div>
      {q.error && <ErrorBox error={q.error} />}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3 text-xs text-muted">
        {total !== undefined &&
          (q.data?.pages[0]?.filtered ? (
            <span>{cards.length.toLocaleString()} shown · titles you have are hidden</span>
          ) : (
            <span>
              {cards.length.toLocaleString()} of {total.toLocaleString()} shown
            </span>
          ))}
        <label className="inline-flex items-center gap-1.5">
          Show
          <select
            className="rounded-md bg-surface-2 border border-line px-1.5 py-0.5 text-xs text-fg"
            value={batch}
            onChange={(e) => {
              const n = Number(e.target.value);
              setBatch(n);
              try {
                localStorage.setItem(STORE_KEY, String(n));
              } catch {
                /* private mode */
              }
            }}
          >
            {BATCHES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          at a time
        </label>
        {loadingMore && <span>Loading {Math.min(target, total ?? target)}…</span>}
        <span className="ml-auto flex items-center gap-3">
          {sel?.active && <SelectAllButton cards={cards} />}
          <SelectToggle />
        </span>
      </div>
      {!q.isLoading && cards.length === 0 && !q.error && <p className="text-muted text-sm py-10 text-center">{empty}</p>}
      <PosterGrid cards={cards} onAdd={onAdd} loading={q.isLoading || q.isFetchingNextPage} />
      <div ref={sentinel} className="h-8" />
      {q.hasNextPage && !q.isFetching && (
        <div className="flex justify-center">
          <Button onClick={() => setTarget(cards.length + batch)}>Load {batch} more</Button>
        </div>
      )}
      {dialog}
    </div>
  );
}
