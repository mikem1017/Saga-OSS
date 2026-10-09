import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Clock, ExternalLink, Play, Plus, Star } from 'lucide-react';
import type { LibraryState, MediaType, TitleCard } from '../../shared/types.ts';
import { get } from '../api.ts';
import { bytes, img } from '../format.ts';
import { AddDialog, useQuickAdd, type SeasonInfo } from '../components/AddDialog.tsx';
import { StateBadge, stateLabel } from '../components/Poster.tsx';
import { Rail } from '../components/Rail.tsx';
import { Button, Card, ErrorBox, Modal, ProgressBar, Spinner } from '../components/ui.tsx';

interface Person {
  id: number;
  name: string;
  character?: string;
  job?: string;
  profilePath?: string | null;
}

interface TitleDetail extends TitleCard {
  tagline?: string;
  runtime?: number;
  genres: { id: number; name: string }[];
  status?: string;
  releaseDate?: string;
  certification?: string;
  originalLanguage?: string;
  voteCount?: number;
  imdbId?: string;
  tvdbId?: number;
  homepage?: string;
  trailerKey?: string;
  collection?: { id: number; name: string };
  companies: { id: number; name: string }[];
  networks: { id: number; name: string }[];
  keywords: { id: number; name: string }[];
  providers?: { link?: string; flatrate: { id: number; name: string; logoPath: string }[] };
  cast: Person[];
  crew: Person[];
  seasons?: SeasonInfo[];
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  recommendations: TitleCard[];
  similar: TitleCard[];
  library?: {
    app: 'radarr' | 'sonarr';
    id: number;
    monitored: boolean;
    hasFile?: boolean;
    quality?: string;
    sizeOnDisk?: number;
    profile?: string;
    path?: string;
    added?: string;
    seriesType?: string;
    seasons?: { seasonNumber: number; monitored: boolean; have: number; total: number; aired: number; sizeOnDisk: number }[];
  };
}

function StateLine({ state }: { state: LibraryState }) {
  const l = stateLabel(state);
  if (!l) return <span className="text-sm text-muted">Not in library</span>;
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <StateBadge state={state} /> <span className="text-muted">{l.title}</span>
    </span>
  );
}

function PeopleRow({ title, people }: { title: string; people: Person[] }) {
  if (!people.length) return null;
  return (
    <section className="mb-7">
      <h2 className="text-lg font-semibold mb-2.5">{title}</h2>
      <div className="scroll-row flex gap-3 overflow-x-auto pb-2 -mx-4 px-4">
        {people.map((p, i) => (
          <Link key={`${p.id}-${i}`} to={`/person/${p.id}`} className="w-24 shrink-0 group">
            <div className="aspect-[2/3] rounded-xl overflow-hidden bg-surface-2 border border-line">
              {p.profilePath ? <img src={img(p.profilePath, 'w185')} alt="" loading="lazy" className="size-full object-cover" /> : <div className="size-full flex items-center justify-center text-2xl text-muted">{p.name[0]}</div>}
            </div>
            <div className="text-xs font-medium mt-1 leading-tight group-hover:text-accent line-clamp-2">{p.name}</div>
            <div className="text-[11px] text-muted leading-tight line-clamp-2">{p.character ?? p.job}</div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default function TitlePage({ type }: { type: MediaType }) {
  const { id } = useParams();
  const tmdbId = Number(id);
  const q = useQuery({ queryKey: ['title', type, tmdbId], queryFn: () => get<TitleDetail>(`/title/${type}/${tmdbId}`), refetchInterval: 30_000 });
  const [addOpen, setAddOpen] = useState(false);
  const [addSeasons, setAddSeasons] = useState<number[] | null>(null);
  const [trailer, setTrailer] = useState(false);
  const { onAdd, dialog } = useQuickAdd();
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const t = q.data!;
  const lib = t.library;
  const year = t.year ? ` (${t.year})` : '';
  const director = t.crew.filter((c) => c.job === 'Director' || c.job === 'Creator');

  return (
    <div>
      <div className="relative -mx-4 -mt-5 mb-6 overflow-hidden">
        {t.backdropPath && <img src={img(t.backdropPath, 'w1280')} alt="" className="absolute inset-0 size-full object-cover opacity-30" />}
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/80 to-bg/40" />
        <div className="relative px-4 pt-8 pb-6 flex flex-col sm:flex-row gap-6">
          <div className="w-40 sm:w-52 shrink-0 mx-auto sm:mx-0">
            <div className="aspect-[2/3] rounded-xl overflow-hidden border border-line bg-surface-2 shadow-2xl">
              {t.posterPath && <img src={img(t.posterPath, 'w500')} alt={`${t.title} poster`} className="size-full object-cover" />}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-bold tracking-tight">
              {t.title}
              <span className="text-muted font-normal">{year}</span>
            </h1>
            {t.tagline && <p className="text-muted italic mt-1">{t.tagline}</p>}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted mt-3">
              {t.certification && <span className="border border-line rounded px-1.5 text-xs">{t.certification}</span>}
              {t.runtime ? (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3.5" />
                  {t.runtime} min
                </span>
              ) : null}
              {t.rating ? (
                <span className="inline-flex items-center gap-1">
                  <Star className="size-3.5 fill-current text-accent" />
                  {t.rating.toFixed(1)} <span className="text-xs">({t.voteCount?.toLocaleString()})</span>
                </span>
              ) : null}
              {type === 'tv' && t.numberOfSeasons ? (
                <span>
                  {t.numberOfSeasons} seasons · {t.numberOfEpisodes} episodes
                </span>
              ) : null}
              {t.status && <span>{t.status}</span>}
            </div>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {t.genres.map((g) => (
                <Link key={g.id} to={`/browse?${type === 'tv' ? 'type=tv&' : ''}genre=${g.id}`} className="text-xs rounded-full border border-line bg-surface-2 px-2.5 py-1 hover:border-accent">
                  {g.name}
                </Link>
              ))}
            </div>
            <div className="mt-4">
              <StateLine state={t.state} />
            </div>
            <div className="flex flex-wrap gap-2 mt-4">
              <Button
                variant="primary"
                onClick={() => {
                  setAddSeasons(null);
                  setAddOpen(true);
                }}
              >
                <Plus className="size-4" />
                {lib ? (type === 'tv' ? 'Add seasons' : 'Library options') : 'Add'}
              </Button>
              {t.trailerKey && (
                <Button onClick={() => setTrailer(true)}>
                  <Play className="size-4" /> Trailer
                </Button>
              )}
              {t.imdbId && (
                <a className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg px-2" href={`https://www.imdb.com/title/${t.imdbId}/`} target="_blank" rel="noreferrer">
                  IMDb <ExternalLink className="size-3.5" />
                </a>
              )}
              <a className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg px-2" href={`https://www.themoviedb.org/${type}/${tmdbId}`} target="_blank" rel="noreferrer">
                TMDB <ExternalLink className="size-3.5" />
              </a>
            </div>
            {director.length > 0 && (
              <p className="text-sm mt-4">
                <span className="text-muted">{type === 'tv' ? 'Created by ' : 'Directed by '}</span>
                {director.map((d, i) => (
                  <span key={d.id}>
                    {i > 0 && ', '}
                    <Link to={`/person/${d.id}`} className="hover:text-accent">
                      {d.name}
                    </Link>
                  </span>
                ))}
              </p>
            )}
            {t.overview && <p className="text-sm leading-relaxed mt-3 max-w-3xl">{t.overview}</p>}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3 mb-7">
        <Card title="Library">
          {!lib ? (
            <p className="text-sm text-muted">Not in {type === 'movie' ? 'Radarr' : 'Sonarr'}.</p>
          ) : (
            <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <dt className="text-muted">Profile</dt>
              <dd>{lib.profile ?? '—'}</dd>
              <dt className="text-muted">Monitored</dt>
              <dd>{lib.monitored ? 'Yes' : 'No'}</dd>
              {type === 'movie' && (
                <>
                  <dt className="text-muted">File</dt>
                  <dd>{lib.hasFile ? `${lib.quality} · ${bytes(lib.sizeOnDisk)}` : 'None yet'}</dd>
                </>
              )}
              {type === 'tv' && (
                <>
                  <dt className="text-muted">On disk</dt>
                  <dd>{bytes(lib.sizeOnDisk)}</dd>
                  <dt className="text-muted">Type</dt>
                  <dd>{lib.seriesType}</dd>
                </>
              )}
              {lib.path && (
                <>
                  <dt className="text-muted">Path</dt>
                  <dd className="break-all text-xs font-mono">{lib.path}</dd>
                </>
              )}
            </dl>
          )}
        </Card>
        <Card title="Where to stream">
          {t.providers?.flatrate.length ? (
            <div className="flex flex-wrap gap-2">
              {t.providers.flatrate.map((p) => (
                <Link key={p.id} to={`/browse?${type === 'tv' ? 'type=tv&' : ''}provider=${p.id}`} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs hover:border-accent" title={`Browse ${p.name}`}>
                  <img src={img(p.logoPath, 'w92')} alt="" className="size-6 rounded" />
                  {p.name}
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">No subscription streaming in this region.</p>
          )}
        </Card>
        <Card title="More">
          <div className="space-y-2 text-sm">
            {t.collection && (
              <Link to={`/collection/${t.collection.id}`} className="block hover:text-accent">
                Part of <span className="font-medium">{t.collection.name}</span> →
              </Link>
            )}
            {(type === 'movie' ? t.companies : t.networks).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {(type === 'movie' ? t.companies : t.networks).map((c) => (
                  <Link
                    key={c.id}
                    to={type === 'movie' ? `/browse?company=${c.id}&companyName=${encodeURIComponent(c.name)}` : `/browse?type=tv&network=${c.id}&networkName=${encodeURIComponent(c.name)}`}
                    className="text-xs rounded-full border border-line bg-surface-2 px-2.5 py-1 hover:border-accent"
                  >
                    {c.name}
                  </Link>
                ))}
              </div>
            )}
            {t.keywords.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {t.keywords.map((k) => (
                  <Link key={k.id} to={`/browse?${type === 'tv' ? 'type=tv&' : ''}keyword=${k.id}&keywordName=${encodeURIComponent(k.name)}`} className="text-[11px] text-muted hover:text-accent">
                    #{k.name}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      {type === 'tv' && t.seasons && t.seasons.length > 0 && (
        <Card title="Seasons" className="mb-7">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {t.seasons.map((s) => {
              const ls = lib?.seasons?.find((x) => x.seasonNumber === s.seasonNumber);
              const total = ls?.aired || ls?.total || s.episodeCount;
              return (
                <div key={s.seasonNumber} className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 p-2">
                  <div className="w-10 h-14 rounded bg-surface-3 overflow-hidden shrink-0"><SeasonPoster path={s.posterPath} /></div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{s.name}</div>
                    <div className="text-xs text-muted">
                      {s.episodeCount} episodes{s.airDate ? ` · ${s.airDate.slice(0, 4)}` : ''}
                      {ls ? ` · have ${ls.have}/${total}${ls.monitored ? '' : ' · unmonitored'}` : ''}
                    </div>
                    {ls && total > 0 && (
                      <div className="mt-1">
                        <ProgressBar value={(ls.have / total) * 100} tone={ls.have >= total ? 'ok' : 'info'} />
                      </div>
                    )}
                  </div>
                  {(!ls || !ls.monitored) && (
                    <Button
                      size="sm"
                      onClick={() => {
                        setAddSeasons([s.seasonNumber]);
                        setAddOpen(true);
                      }}
                      aria-label={`Add ${s.name}`}
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <PeopleRow title="Cast" people={t.cast} />
      <PeopleRow title="Crew" people={t.crew.filter((c) => c.job !== 'Director' && c.job !== 'Creator')} />
      <Rail title="Recommended" cards={t.recommendations} onAdd={onAdd} />
      <Rail title="Similar" cards={t.similar} onAdd={onAdd} />

      <AddDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        mediaType={type}
        tmdbId={tmdbId}
        title={t.title}
        seasons={t.seasons}
        librarySeasons={lib?.seasons}
        initialSeasons={addSeasons}
      />
      <Modal open={trailer} onClose={() => setTrailer(false)} title={`${t.title} — trailer`} wide>
        {trailer && t.trailerKey && (
          <div className="aspect-video">
            <iframe
              className="size-full rounded-lg"
              src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(t.trailerKey)}?autoplay=1`}
              title="Trailer" referrerPolicy="strict-origin-when-cross-origin"
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          </div>
        )}
      </Modal>
      {dialog}
    </div>
  );
}

function SeasonPoster({ path }: { path?: string | null }) {
  return path ? <img src={img(path, 'w92')} alt="" loading="lazy" className="size-full object-cover" /> : null;
}
