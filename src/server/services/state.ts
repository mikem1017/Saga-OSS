import type { LibraryState, MediaType, TitleCard } from '../../shared/types.ts';
import type { LibraryService } from './library.ts';
import type { DownloadsService } from './downloads.ts';

/** Resolves the live badge for a title from the library mirror, the joined download queue and Seerr requests. */
export class StateService {
  constructor(
    private readonly library: LibraryService,
    private readonly downloads: DownloadsService,
  ) {}

  forMovie(tmdbId: number): LibraryState {
    const m = this.library.movies.get(tmdbId);
    if (m) {
      if (m.hasFile) {
        const q = m.movieFile?.quality.quality;
        return { kind: 'available', quality: q?.name ?? 'on disk', resolution: q?.resolution };
      }
      const dl = this.downloads.stateForMovie(m.id);
      if (dl) return dl;
      return { kind: 'missing', monitored: m.monitored };
    }
    const req = this.library.requests.get(`movie:${tmdbId}`);
    return req ? { kind: 'requested', by: req } : { kind: 'none' };
  }

  forTv(tmdbId: number): LibraryState {
    const s = this.library.series.get(tmdbId);
    if (s) {
      const dl = this.downloads.stateForSeries(s.id);
      if (dl && (dl.kind === 'downloading' || dl.kind === 'queued')) return dl;
      const st = s.statistics;
      const have = st?.episodeFileCount ?? 0;
      const total = st?.episodeCount ?? 0;
      if (have > 0) {
        const profile = this.library.sonarrProfiles.find((p) => p.id === s.qualityProfileId)?.name ?? 'on disk';
        return { kind: 'available', quality: profile, have, total };
      }
      if (dl) return dl;
      return { kind: 'missing', monitored: s.monitored, have, total };
    }
    const req = this.library.requests.get(`tv:${tmdbId}`);
    return req ? { kind: 'requested', by: req } : { kind: 'none' };
  }

  for(mediaType: MediaType, tmdbId: number): LibraryState {
    return mediaType === 'movie' ? this.forMovie(tmdbId) : this.forTv(tmdbId);
  }

  decorate<T extends Omit<TitleCard, 'state'>>(cards: T[]): (T & { state: LibraryState })[] {
    return cards.map((c) => ({ ...c, state: this.for(c.mediaType, c.tmdbId) }));
  }

  /** True when the title is in the *arr already (any state other than none/requested). */
  inLibrary(mediaType: MediaType, tmdbId: number): boolean {
    return mediaType === 'movie' ? this.library.movies.has(tmdbId) : this.library.series.has(tmdbId);
  }
}
