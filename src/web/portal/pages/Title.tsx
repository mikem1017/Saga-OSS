import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Flag, Star } from 'lucide-react';
import type { MediaType, TitleView } from '../types.ts';
import { get, post } from '../api.ts';
import { Badge, Card, Loading, RequestButton, Steps } from '../components.tsx';
import { img } from '../../format.ts';
import { Button, Field, Modal, inputCls } from '../../components/ui.tsx';
import { useToast } from '../../components/toast.tsx';

export function ProblemButton({ mediaType, tmdbId }: { mediaType: MediaType; tmdbId: number }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('audio');
  const [note, setNote] = useState('');
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => post('/problems', { mediaType, tmdbId, kind, note: note || undefined }),
    onSuccess: () => {
      toast("Thanks, the admin has been told. You'll hear back when it's fixed.", 'ok');
      setOpen(false);
      setNote('');
    },
  });
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Flag className="size-3.5" /> Report a problem
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Report a problem">
        <div className="space-y-3">
          <Field label="What's wrong?">
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="audio">Bad or missing audio</option>
              <option value="subtitles">Subtitles missing or out of sync</option>
              <option value="video">Picture problems</option>
              <option value="wrong_file">Wrong film or episode</option>
              <option value="other">Something else</option>
            </select>
          </Field>
          <Field label="Details (optional)">
            <textarea className={inputCls} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. episode 4 has no sound after 20 minutes" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" busy={m.isPending} onClick={() => m.mutate()}>
              Send
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export default function TitlePage({ type }: { type: MediaType }) {
  const { id = '' } = useParams();
  const { data: t, isLoading, error } = useQuery({ queryKey: ['title', type, id], queryFn: () => get<TitleView>(`/title/${type}/${id}`), refetchInterval: 60_000 });
  if (isLoading) return <Loading />;
  if (error || !t) return <p className="text-muted">Couldn't load that title.</p>;
  const backdrop = img(t.backdropPath, 'w1280');
  return (
    <div>
      <div className="relative -mx-4 -mt-5 mb-5 px-4 pt-5 pb-5 overflow-hidden">
        {backdrop && <img src={backdrop} alt="" className="absolute inset-0 size-full object-cover opacity-20" />}
        <div className="relative flex gap-4">
          <img src={img(t.posterPath, 'w342')} alt="" className="w-28 sm:w-40 rounded-xl border border-line aspect-[2/3] object-cover bg-surface-2 shrink-0" />
          <div className="min-w-0 space-y-2">
            <h1 className="text-2xl font-bold leading-tight">
              {t.title} {t.year && <span className="text-muted font-normal">({t.year})</span>}
            </h1>
            {t.tagline && <p className="text-sm italic text-muted">{t.tagline}</p>}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              {t.certification && <span className="border border-line rounded px-1">{t.certification}</span>}
              {t.runtime ? <span>{t.runtime} min</span> : null}
              {t.rating ? (
                <span className="inline-flex items-center gap-0.5">
                  <Star className="size-3 fill-current" />
                  {t.rating.toFixed(1)}
                </span>
              ) : null}
              <span>{t.genres.join(' · ')}</span>
            </div>
            <Badge state={t.state} />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <RequestButton title={t} />
              {(t.state.kind === 'available' || t.myRequest) && <ProblemButton mediaType={t.mediaType} tmdbId={t.tmdbId} />}
            </div>
          </div>
        </div>
      </div>
      {t.myRequest && (
        <div className="rounded-xl border border-line bg-surface p-4 mb-5">
          <div className="text-sm font-semibold mb-2">
            Your request{t.myRequest.seasons ? ` · season ${t.myRequest.seasons.join(', ')}` : ''}
          </div>
          <Steps r={t.myRequest} />
          {t.myRequest.plexUrl && (
            <a href={t.myRequest.plexUrl} target="_blank" rel="noreferrer" className="inline-block mt-2 text-sm text-accent">
              Open in Plex →
            </a>
          )}
        </div>
      )}
      {t.overview && <p className="text-sm leading-relaxed mb-5 max-w-3xl">{t.overview}</p>}
      {t.seasons && (
        <section className="mb-5">
          <h2 className="font-semibold mb-2">Seasons</h2>
          <div className="flex flex-wrap gap-2">
            {t.seasons.map((s) => (
              <span key={s.seasonNumber} className={`rounded-lg border px-2.5 py-1 text-xs ${s.inPlex ? 'border-ok/50 text-ok' : s.coming ? 'border-violet/50 text-violet' : 'border-line text-muted'}`}>
                S{s.seasonNumber} · {s.episodeCount} eps {s.inPlex ? '· in Plex' : s.coming ? '· coming' : ''}
              </span>
            ))}
          </div>
        </section>
      )}
      {t.trailerKey && (
        <section className="mb-5 max-w-3xl">
          <h2 className="font-semibold mb-2">Trailer</h2>
          <div className="aspect-video rounded-xl overflow-hidden border border-line">
            <iframe className="size-full" src={`https://www.youtube-nocookie.com/embed/${t.trailerKey}`} title="Trailer" referrerPolicy="strict-origin-when-cross-origin" allow="encrypted-media; picture-in-picture" allowFullScreen loading="lazy" />
          </div>
        </section>
      )}
      {t.cast.length > 0 && (
        <section className="mb-5">
          <h2 className="font-semibold mb-2">Cast</h2>
          <p className="text-sm text-muted">{t.cast.map((c) => c.name).join(', ')}</p>
        </section>
      )}
      {t.recommendations.length > 0 && (
        <section>
          <h2 className="font-semibold mb-2">You might also like</h2>
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4">
            {t.recommendations.map((c) => (
              <Card key={`${c.mediaType}:${c.tmdbId}`} card={c} />
            ))}
          </div>
        </section>
      )}
      <p className="mt-6 text-xs text-muted">
        <Link to="/requests">See all your requests →</Link>
      </p>
    </div>
  );
}
