import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, Download, Film, Search, Star, Tv, X, Loader2, PartyPopper } from 'lucide-react';
import type { CreateResult, GuestCard, GuestState, RequestView, TitleView } from './types.ts';
import { duration, img } from '../format.ts';
import { post } from './api.ts';
import { Button, Modal, ProgressBar } from '../components/ui.tsx';
import { useToast } from '../components/toast.tsx';

export function stateBadge(s: GuestState): { text: string; cls: string } | null {
  switch (s.kind) {
    case 'available':
      return { text: 'In Plex', cls: 'bg-ok text-black' };
    case 'downloading':
      return { text: `${Math.round(s.percent)}% · ~${duration(s.etaSec)}`, cls: 'bg-info text-white' };
    case 'queued':
      return { text: `Coming · ~${duration(s.etaSec)}`, cls: 'bg-warn text-black' };
    case 'coming':
      return { text: 'Coming soon', cls: 'bg-violet text-white' };
    case 'requested':
      return { text: 'Requested', cls: 'bg-teal text-black' };
    default:
      return null;
  }
}

export function Badge({ state }: { state: GuestState }) {
  const b = stateBadge(state);
  if (!b) return null;
  return <span className={`inline-block rounded-md px-1.5 py-0.5 text-[11px] font-semibold leading-tight whitespace-nowrap ${b.cls}`}>{b.text}</span>;
}

export function Card({ card, fluid }: { card: GuestCard; fluid?: boolean }) {
  const src = img(card.posterPath, 'w342');
  return (
    <Link to={`/${card.mediaType}/${card.tmdbId}`} className={`group block ${fluid ? 'w-full min-w-0' : 'w-32 sm:w-36'} shrink-0`}>
      <div className="relative rounded-xl overflow-hidden bg-surface-2 aspect-[2/3] border border-line">
        {src ? (
          <img src={src} alt="" loading="lazy" decoding="async" className="size-full object-cover transition group-hover:scale-[1.03]" />
        ) : (
          <div className="size-full flex flex-col items-center justify-center gap-2 text-muted p-2 text-center text-xs">
            {card.mediaType === 'movie' ? <Film className="size-6" /> : <Tv className="size-6" />}
            {card.title}
          </div>
        )}
        <div className="absolute top-1.5 left-1.5">
          <Badge state={card.state} />
        </div>
      </div>
      <div className="mt-1.5 text-sm font-medium leading-tight truncate group-hover:text-accent">{card.title}</div>
      <div className="text-xs text-muted flex items-center gap-1.5">
        {card.year ?? '—'}
        {card.rating ? (
          <span className="inline-flex items-center gap-0.5">
            <Star className="size-3 fill-current" />
            {card.rating.toFixed(1)}
          </span>
        ) : null}
        {card.mediaType === 'tv' && <span>· TV</span>}
      </div>
    </Link>
  );
}

export function Grid({ cards }: { cards: GuestCard[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-3 gap-y-5">
      {cards.map((c) => (
        <Card key={`${c.mediaType}:${c.tmdbId}`} card={c} fluid />
      ))}
    </div>
  );
}

const STEPS: { key: string; label: string }[] = [
  { key: 'requested', label: 'Requested' },
  { key: 'approved', label: 'Approved' },
  { key: 'queued', label: 'Queued' },
  { key: 'downloading', label: 'Downloading' },
  { key: 'available', label: 'Ready' },
];
const ORDER: Record<string, number> = { requested: 0, approved: 1, searching: 1, queued: 2, downloading: 3, importing: 3, available: 4 };

export function Steps({ r }: { r: RequestView }) {
  if (r.step === 'declined')
    return (
      <div className="text-sm text-bad flex items-center gap-1.5">
        <X className="size-4" /> {r.stepDetail}
      </div>
    );
  const at = ORDER[r.step] ?? 0;
  return (
    <div>
      <ol className="flex items-center gap-1" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s.key} className="flex-1">
            <div className={`h-1.5 rounded-full ${i <= at ? (r.step === 'available' ? 'bg-ok' : 'bg-accent') : 'bg-surface-3'}`} />
            <div className={`text-[10px] mt-1 ${i === at ? 'text-fg font-medium' : 'text-muted'} hidden sm:block`}>{s.label}</div>
          </li>
        ))}
      </ol>
      <div className="text-sm mt-1.5 flex flex-wrap items-center gap-x-2 text-muted">
        {r.step === 'available' ? <Check className="size-4 text-ok" /> : r.step === 'downloading' ? <Download className="size-4 text-info" /> : r.step === 'searching' ? <Search className="size-4" /> : <Clock className="size-4" />}
        <span className="text-fg">{r.stepDetail}</span>
        {r.etaSec != null && r.step !== 'available' && <span>· ready in about {duration(r.etaSec)}</span>}
      </div>
      {r.step === 'downloading' && r.percent !== undefined && (
        <div className="mt-1.5">
          <ProgressBar value={r.percent} />
        </div>
      )}
    </div>
  );
}

const outcomeText: Record<CreateResult['outcome'], string> = {
  created: "Requested! You'll get a message when it's approved.",
  'auto-approved': "Approved and on its way. We'll tell you when it's ready.",
  merged: "Someone already asked for this, so you're on the list too. We'll tell you when it's ready.",
  'already-coming': "It's already on its way. We'll tell you when it's ready.",
};

/** Request button + dialog (season picker for TV). */
export function RequestButton({ title }: { title: TitleView }) {
  const [open, setOpen] = useState(false);
  const regular = (title.seasons ?? []).filter((s) => !s.inPlex && !s.coming);
  const [seasons, setSeasons] = useState<number[]>(() => regular.map((s) => s.seasonNumber));
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => post<CreateResult>('/requests', { mediaType: title.mediaType, tmdbId: title.tmdbId, seasons: title.mediaType === 'tv' ? seasons : undefined }),
    onSuccess: (res) => {
      toast(outcomeText[res.outcome], 'ok');
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['title', title.mediaType, String(title.tmdbId)] });
      qc.invalidateQueries({ queryKey: ['requests'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  if (!title.allowed) return <p className="text-sm text-muted">This title isn't available on your profile ({title.certification ?? 'unrated'}).</p>;
  if (title.state.kind === 'available' && title.mediaType === 'movie')
    return (
      <a href={`https://app.plex.tv/desktop/#!/search?pivot=top&query=${encodeURIComponent(title.title)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-ok text-black font-semibold px-4 py-2 text-sm">
        <PartyPopper className="size-4" /> Watch in Plex
      </a>
    );
  if (title.myRequest && title.mediaType === 'movie') return null;
  const tvNothingLeft = title.mediaType === 'tv' && !regular.length;
  if (tvNothingLeft) return <p className="text-sm text-muted">Every season is in Plex or already on its way.</p>;
  // Already queued/downloading/wanted: "requesting" just signs you up to be told when it lands, and it's free.
  const coming = title.mediaType === 'movie' && title.state.kind !== 'none' && title.state.kind !== 'requested';
  return (
    <>
      <Button variant="primary" onClick={() => (title.mediaType === 'movie' ? m.mutate() : setOpen(true))} busy={m.isPending}>
        {title.mediaType === 'movie' ? (coming ? "Notify me when it's ready" : 'Request this film') : 'Request seasons'}
      </Button>
      {coming && <span className="text-xs text-muted basis-full">Already on its way. This doesn't use any of your limits.</span>}
      <Modal open={open} onClose={() => setOpen(false)} title={`Request ${title.title}`}>
        <p className="text-sm text-muted mb-3">Pick the seasons you want. Seasons already in Plex or on their way aren't listed.</p>
        <div className="flex flex-wrap gap-2 mb-4">
          {regular.map((s) => {
            const on = seasons.includes(s.seasonNumber);
            return (
              <button
                key={s.seasonNumber}
                onClick={() => setSeasons((x) => (on ? x.filter((n) => n !== s.seasonNumber) : [...x, s.seasonNumber]))}
                className={`rounded-lg border px-3 py-1.5 text-sm ${on ? 'bg-accent text-accent-fg border-accent font-semibold' : 'border-line bg-surface-2'}`}
                aria-pressed={on}
              >
                Season {s.seasonNumber} <span className="text-xs opacity-75">· {s.episodeCount} eps</span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!seasons.length} busy={m.isPending} onClick={() => m.mutate()}>
            Request {seasons.length} season{seasons.length === 1 ? '' : 's'}
          </Button>
        </div>
      </Modal>
    </>
  );
}

export function Loading() {
  return (
    <div className="flex justify-center py-10 text-muted">
      <Loader2 className="size-6 animate-spin" />
    </div>
  );
}
