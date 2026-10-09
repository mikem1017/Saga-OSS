import { Link } from 'react-router';
import { Plus, Star, Film, Tv, Check } from 'lucide-react';
import { selectable, useSelection } from './Selection.tsx';
import type { LibraryState, TitleCard } from '../../shared/types.ts';
import { duration, img } from '../format.ts';

export function stateLabel(s: LibraryState): { text: string; cls: string; title: string } | null {
  switch (s.kind) {
    case 'available': {
      const res = s.resolution ? (s.resolution >= 2160 ? '4K' : `${s.resolution}p`) : s.quality;
      const eps = s.have !== undefined && s.total ? ` · ${s.have}/${s.total}` : '';
      return { text: `${res}${eps}`, cls: 'bg-ok text-black', title: `In library (${s.quality})${eps ? `, ${s.have} of ${s.total} episodes` : ''}` };
    }
    case 'downloading':
      return {
        text: `${Math.round(s.percent)}% · ~${duration(s.etaSec)}`,
        cls: 'bg-info text-white',
        title: `Downloading ${Math.round(s.percent)}%, about ${duration(s.etaSec)} left${s.jobs && s.jobs > 1 ? ` (${s.jobs} jobs)` : ''}`,
      };
    case 'queued':
      return {
        text: `#${s.position} · ~${duration(s.etaSec)}`,
        cls: 'bg-warn text-black',
        title: `Queued at position ${s.position}; starts in ~${duration(s.startsInSec)}, done in ~${duration(s.etaSec)}${s.jobs && s.jobs > 1 ? ` (${s.jobs} jobs)` : ''}`,
      };
    case 'importing':
      return { text: 'Importing', cls: 'bg-violet text-white', title: s.detail ?? 'Downloaded; waiting for post-processing or import' };
    case 'missing':
      return {
        text: s.monitored ? (s.total ? `Wanted · ${s.have ?? 0}/${s.total}` : 'Wanted') : 'Unmonitored',
        cls: 'bg-surface-3 text-fg',
        title: s.monitored ? 'Monitored, not downloaded yet' : 'In the *arr but unmonitored',
      };
    case 'requested':
      return { text: `Requested${s.by[0] ? ` · ${s.by[0]}` : ''}`, cls: 'bg-teal text-black', title: `Requested by ${s.by.join(', ')}` };
    default:
      return null;
  }
}

export function StateBadge({ state, className = '' }: { state: LibraryState; className?: string }) {
  const l = stateLabel(state);
  if (!l) return null;
  return (
    <span title={l.title} className={`inline-block rounded-md px-1.5 py-0.5 text-[11px] font-semibold leading-tight tabular-nums whitespace-nowrap ${l.cls} ${className}`}>
      {l.text}
    </span>
  );
}

export function Poster({ card, onAdd, size = 'md', fluid }: { card: TitleCard; onAdd?: (c: TitleCard) => void; size?: 'sm' | 'md'; fluid?: boolean }) {
  const src = img(card.posterPath, size === 'sm' ? 'w185' : 'w342');
  const w = fluid ? 'w-full min-w-0' : size === 'sm' ? 'w-28' : 'w-36 sm:w-40';
  const sel = useSelection();
  const selecting = !!sel?.active;
  const canSelect = selecting && selectable(card);
  const picked = canSelect && sel!.isSelected(card);
  return (
    <div className={`group relative ${w} shrink-0 ${selecting && !canSelect ? 'opacity-45' : ''}`}>
      {canSelect && (
        // In select mode the poster toggles selection instead of navigating.
        <button
          onClick={() => sel!.toggle(card)}
          aria-pressed={picked}
          aria-label={`${picked ? 'Deselect' : 'Select'} ${card.title}`}
          className={`absolute inset-x-0 top-0 aspect-[2/3] z-10 rounded-xl transition ${picked ? 'ring-3 ring-accent bg-accent/15' : 'hover:ring-2 hover:ring-accent/60'}`}
        >
          <span className={`absolute bottom-2 right-2 size-6 rounded-md border-2 flex items-center justify-center ${picked ? 'bg-accent border-accent text-accent-fg' : 'bg-black/50 border-white/80'}`}>
            {picked && <Check className="size-4" strokeWidth={3} />}
          </span>
        </button>
      )}
      <Link to={`/${card.mediaType}/${card.tmdbId}`} className="block rounded-xl overflow-hidden bg-surface-2 aspect-[2/3] border border-line focus-visible:ring-2">
        {src ? (
          <img src={src} alt="" loading="lazy" decoding="async" className="size-full object-cover transition group-hover:scale-[1.03]" />
        ) : (
          <div className="size-full flex flex-col items-center justify-center gap-2 text-muted p-2 text-center text-xs">
            {card.mediaType === 'movie' ? <Film className="size-6" /> : <Tv className="size-6" />}
            {card.title}
          </div>
        )}
        <div className="absolute top-1.5 left-1.5 right-1.5 flex justify-between items-start gap-1 pointer-events-none">
          <StateBadge state={card.state} />
          {card.mediaType === 'tv' && <span className="ml-auto rounded bg-black/70 text-white text-[10px] px-1 py-0.5 font-medium">TV</span>}
        </div>
      </Link>
      {onAdd && !selecting && card.state.kind === 'none' && (
        <button
          onClick={() => onAdd(card)}
          aria-label={`Add ${card.title}`}
          className="absolute bottom-[3.4rem] right-1.5 rounded-full bg-accent text-accent-fg p-1.5 shadow-lg opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 transition"
        >
          <Plus className="size-4" />
        </button>
      )}
      <div className="mt-1.5 px-0.5">
        <Link to={`/${card.mediaType}/${card.tmdbId}`} className="block text-sm font-medium leading-tight truncate hover:text-accent" title={card.title}>
          {card.title}
        </Link>
        <div className="text-xs text-muted flex items-center gap-1.5 mt-0.5">
          {card.year ?? '—'}
          {card.rating ? (
            <span className="inline-flex items-center gap-0.5">
              <Star className="size-3 fill-current" />
              {card.rating.toFixed(1)}
            </span>
          ) : null}
          {card.role && <span className="truncate" title={card.role}>· {card.role}</span>}
        </div>
      </div>
    </div>
  );
}

export function PosterSkeleton({ size = 'md', fluid }: { size?: 'sm' | 'md'; fluid?: boolean }) {
  return (
    <div className={`${fluid ? 'w-full' : size === 'sm' ? 'w-28' : 'w-36 sm:w-40'} shrink-0`}>
      <div className="skeleton aspect-[2/3] rounded-xl" />
      <div className="skeleton h-3 rounded mt-2 w-3/4" />
      <div className="skeleton h-3 rounded mt-1 w-1/3" />
    </div>
  );
}

export function PosterGrid({ cards, onAdd, loading }: { cards: TitleCard[]; onAdd?: (c: TitleCard) => void; loading?: boolean }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-3 gap-y-5">
      {cards.map((c) => (
        <Poster key={`${c.mediaType}:${c.tmdbId}`} card={c} onAdd={onAdd} fluid />
      ))}
      {loading && Array.from({ length: 12 }, (_, i) => <PosterSkeleton key={`s${i}`} fluid />)}
    </div>
  );
}
