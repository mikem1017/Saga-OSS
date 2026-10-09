import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import type { TitleCard } from '../../shared/types.ts';
import { Poster, PosterSkeleton } from './Poster.tsx';
import { SelectAllButton, useSelection } from './Selection.tsx';

export function Rail({ title, cards, loading, seeAll, onAdd, extra }: { title: ReactNode; cards?: TitleCard[]; loading?: boolean; seeAll?: string; onAdd?: (c: TitleCard) => void; extra?: ReactNode }) {
  const sel = useSelection();
  if (!loading && cards && cards.length === 0) return null;
  return (
    <section className="mb-7">
      <div className="flex items-center justify-between mb-2.5 gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <div className="flex items-center gap-3">
          {extra}
          {sel?.active && cards && <SelectAllButton cards={cards} />}
          {seeAll && (
            <Link to={seeAll} className="text-sm text-muted hover:text-accent inline-flex items-center">
              See all <ChevronRight className="size-4" />
            </Link>
          )}
        </div>
      </div>
      <div className="scroll-row flex gap-3 overflow-x-auto pb-2 -mx-4 px-4">
        {loading && !cards ? Array.from({ length: 8 }, (_, i) => <PosterSkeleton key={i} />) : cards!.map((c) => <Poster key={`${c.mediaType}:${c.tmdbId}`} card={c} onAdd={onAdd} />)}
      </div>
    </section>
  );
}
