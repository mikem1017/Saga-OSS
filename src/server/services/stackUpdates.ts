import type { Stack } from '../stack.ts';
import { OpsRefused, type StackRun } from '../connectors/feeds.ts';
import { audit } from './audit.ts';

export class StackError extends Error {}

/**
 * Container updates on the download host through its saga-ops forced command: versions, update runs (one service at a time,
 * SABnzbd last, refused while SAB post-processes), rollback, and recovery of SAB jobs that fail to load after a
 * SAB upgrade (71 were dropped going 5.0.4 -> 5.1.3 on 2026-10-09, and the *arrs silently forgot them).
 */
export class StackUpdates {
  constructor(private readonly stack: Stack) {}

  private ops() {
    if (!this.stack.opsStack) throw new StackError('Stack updates are not configured (OPS_STACK_HOST)');
    return this.stack.opsStack;
  }

  versions(refresh = false) {
    return this.ops().versions(refresh);
  }

  runs() {
    return this.ops().runs();
  }

  status(runId: string) {
    return this.ops().status(runId);
  }

  /** Who's watching right now (restarting Plex cuts them off). */
  async plexStreams(): Promise<number> {
    if (!this.stack.tautulli) return 0;
    try {
      return Number((await this.stack.tautulli.activity()).stream_count) || 0;
    } catch {
      return 0;
    }
  }

  async start(services: string[] | 'all', actor: string, opts: { allowStreaming?: boolean } = {}) {
    const includesPlex = services === 'all' || services.includes('plex');
    if (includesPlex && !opts.allowStreaming) {
      const n = await this.plexStreams();
      if (n > 0) throw new StackError(`${n} Plex stream${n === 1 ? ' is' : 's are'} playing; updating Plex restarts it. Confirm to update anyway, or leave Plex out.`);
    }
    try {
      const r = await this.ops().update(services);
      audit(this.stack.db, actor, 'stack.update', r.services.join(', '), `run ${r.runId}`);
      return r;
    } catch (err) {
      audit(this.stack.db, actor, 'stack.update', services === 'all' ? 'all' : services.join(', '), String(err instanceof Error ? err.message : err), false);
      throw err instanceof OpsRefused ? new StackError(err.message) : err;
    }
  }

  async rollback(runId: string, service: string | undefined, actor: string) {
    try {
      const r = await this.ops().rollback(runId, service);
      const res = r.rollback?.results ?? [];
      audit(this.stack.db, actor, 'stack.rollback', service ?? 'all changed', `run ${runId}: ${res.map((x) => `${x.service} ${x.ok ? 'ok' : 'FAILED'}`).join(', ')}`, res.every((x) => x.ok));
      return r;
    } catch (err) {
      throw err instanceof OpsRefused ? new StackError(err.message) : err;
    }
  }

  /**
   * Re-search the titles behind SAB jobs that failed to load after a run restarted SABnzbd. Job folder names are
   * parsed by Sonarr first (episodes), then Radarr (movies); only items still without a file are searched.
   */
  async recoverLost(runId: string, actor: string): Promise<{ movies: number; episodes: number; unmatched: string[] }> {
    const run: StackRun = await this.ops().status(runId);
    const { radarr, sonarr } = this.stack;
    const movies = new Set<number>();
    const episodes = new Set<number>();
    const unmatched: string[] = [];
    for (const name of run.lostJobs) {
      try {
        const s = sonarr ? await sonarr.parse(name) : undefined;
        if (s?.series && s.episodes?.length) {
          for (const e of s.episodes) if (!e.hasFile) episodes.add(e.id);
          continue;
        }
        const m = radarr ? await radarr.parse(name) : undefined;
        if (m?.movie) {
          if (!m.movie.hasFile) movies.add(m.movie.id);
          continue;
        }
      } catch {
        /* count as unmatched */
      }
      unmatched.push(name);
    }
    if (movies.size && radarr) await radarr.searchMovies([...movies]);
    if (episodes.size && sonarr) await sonarr.searchEpisodes([...episodes]);
    audit(this.stack.db, actor, 'stack.recover-lost', `run ${runId}`, `${movies.size} movie(s), ${episodes.size} episode(s) searched; ${unmatched.length} unmatched`);
    return { movies: movies.size, episodes: episodes.size, unmatched };
  }
}
