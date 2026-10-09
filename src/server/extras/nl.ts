import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { Stack } from '../stack.ts';
import type { DiscoverService } from '../services/discover.ts';
import type { TitleCard } from '../../shared/types.ts';
import { getSetting, setSetting } from '../db.ts';
import { audit } from '../services/audit.ts';
import { costUsd, filtersToBrowse, libraryMatch, type NlFilters, type NlLookups } from './pure.ts';

/**
 * Natural-language discover: Claude turns "90s heist films in 4K I don't have" into structured TMDB discover
 * filters; Saga runs the query and filters by live library state. Off unless ANTHROPIC_API_KEY is set, with a
 * hard monthly spend cap (default $5) recorded in nl_queries.
 */

const FilterSchema = z.object({
  mediaType: z.enum(['movie', 'tv']),
  titleSearch: z.string().nullable(),
  genres: z.array(z.string()),
  yearFrom: z.number().int().nullable(),
  yearTo: z.number().int().nullable(),
  keywords: z.array(z.string()),
  people: z.array(z.string()),
  language: z.string().nullable(),
  country: z.string().nullable(),
  sort: z.enum(['popularity', 'rating', 'newest', 'oldest', 'revenue']),
  minRating: z.number().nullable(),
  library: z.enum(['missing', 'have', 'any']),
  haveQuality: z.enum(['4k', '1080p']).nullable(),
  summary: z.string(),
});

const SYSTEM = `You translate a media server owner's request for films or TV shows into search filters for TMDB's /discover endpoint.

Rules:
- mediaType: "movie" unless the request is clearly about TV series/shows.
- genres: TMDB genre names only (Action, Adventure, Animation, Comedy, Crime, Documentary, Drama, Family, Fantasy, History, Horror, Music, Mystery, Romance, Science Fiction, Thriller, War, Western; TV also has "Action & Adventure", "Kids", "Sci-Fi & Fantasy", "War & Politics", "Reality", "Talk", "Soap", "News"). Use the TV variants for TV.
- keywords: short TMDB keyword phrases for themes a genre can't express ("heist", "time travel", "based on novel or book", "cyberpunk", "found footage"). Prefer 1–3 strong keywords; they are ORed together.
- people: full names of actors or directors explicitly mentioned.
- Decades: "90s" means yearFrom 1990, yearTo 1999. "recent" means the last 5 years from 2026.
- language/country: ISO 639-1 language ("ja", "ko", "fr") and ISO 3166-1 country codes, only when asked for.
- library: "missing" when the user says they don't have it / want to add it; "have" when they ask what they already own; otherwise "any".
- haveQuality: only with library "have" and an explicit quality ("in 4K", "in 1080p"). A quality mentioned for things they don't have ("4K films I don't have") is a wish, not a filter: use library "missing" and haveQuality null.
- sort: "rating" for best/top/acclaimed, "newest"/"oldest" when asked, otherwise "popularity".
- minRating: a 0–10 floor only when asked ("well reviewed" ≈ 7).
- titleSearch: only when the request names one specific title; otherwise null.
- summary: one short sentence describing the search you built, for display.`;

export class NlDiscover {
  private client: Anthropic | null = null;
  readonly model: string;

  constructor(
    private readonly stack: Stack,
    private readonly discover: DiscoverService,
  ) {
    this.model = process.env.NL_MODEL || 'claude-opus-5-5';
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      const ws = process.env.ANTHROPIC_WORKSPACE_ID;
      this.client = new Anthropic({ apiKey, defaultHeaders: ws ? { 'anthropic-workspace-id': ws } : undefined, maxRetries: 1, timeout: 60_000 });
    }
  }

  get enabled() {
    return !!this.client;
  }

  capUsd(): number {
    return getSetting<number>(this.stack.db, 'extras.nl_cap_usd', 5);
  }

  setCap(usd: number, actor: string) {
    setSetting(this.stack.db, 'extras.nl_cap_usd', usd);
    audit(this.stack.db, actor, 'extras.nl.cap', null, `$${usd.toFixed(2)} per month`);
  }

  monthToDate(): { costUsd: number; queries: number } {
    const d = new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const row = this.stack.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n FROM nl_queries WHERE ts >= ?').get(start) as { c: number; n: number };
    return { costUsd: row.c, queries: row.n };
  }

  status() {
    return {
      enabled: this.enabled,
      model: this.model,
      capUsd: this.capUsd(),
      ...this.monthToDate(),
      recent: this.stack.db.prepare('SELECT ts, prompt, cost_usd AS costUsd, ok, error FROM nl_queries ORDER BY id DESC LIMIT 15').all(),
    };
  }

  /** Ask the model for filters. Exposed separately so it can be mocked in tests. */
  async interpret(prompt: string, actor: string): Promise<NlFilters> {
    if (!this.client) throw new Error('Natural-language discover is off: add ANTHROPIC_API_KEY to Saga’s .env');
    const mtd = this.monthToDate();
    if (mtd.costUsd >= this.capUsd()) throw new Error(`Monthly cap reached ($${mtd.costUsd.toFixed(2)} of $${this.capUsd().toFixed(2)}). Raise it in Insights → Ask.`);
    const log = (u: any, ok: boolean, error: string | null) =>
      this.stack.db
        .prepare('INSERT INTO nl_queries (ts, actor, prompt, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(Date.now(), actor, prompt.slice(0, 500), this.model, u?.input_tokens ?? 0, u?.output_tokens ?? 0, u?.cache_read_input_tokens ?? 0, u?.cache_creation_input_tokens ?? 0, u ? costUsd(this.model, u) : 0, ok ? 1 : 0, error);
    try {
      const res = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 4096,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: prompt }],
        output_config: { effort: 'low', format: betaZodOutputFormat(FilterSchema) },
      });
      if (res.stop_reason === 'refusal') {
        log(res.usage, false, 'refused');
        throw new Error('The model declined this request.');
      }
      const parsed = res.parsed_output;
      if (!parsed) {
        log(res.usage, false, `no parsed output (stop: ${res.stop_reason})`);
        throw new Error('Could not understand that request; try rephrasing.');
      }
      log(res.usage, true, null);
      return parsed as NlFilters;
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        log(null, false, `${err.status ?? ''} ${err.message}`.slice(0, 300));
        throw new Error(`Claude API error ${err.status ?? ''}: ${err.message}`.slice(0, 300));
      }
      throw err;
    }
  }

  private async lookups(f: NlFilters): Promise<NlLookups> {
    const genres = await this.discover.genres(f.mediaType);
    const genreIds = new Map(genres.map((g) => [g.name.toLowerCase(), g.id]));
    const keywordIds = new Map<string, number | undefined>();
    for (const k of f.keywords) {
      const hits = await this.discover.searchKeywords(k).catch(() => []);
      const exact = hits.find((h: { name: string }) => h.name.toLowerCase() === k.toLowerCase());
      keywordIds.set(k.toLowerCase(), (exact ?? hits[0])?.id);
    }
    const personIds = new Map<string, number | undefined>();
    for (const p of f.people) {
      const hits = await this.discover.searchPeople(p).catch(() => []);
      personIds.set(p.toLowerCase(), hits[0]?.id);
    }
    return { genreIds, keywordIds, personIds };
  }

  /** Full run: interpret → TMDB → library filter. Pulls up to 5 pages to find enough matches. */
  async run(prompt: string, actor: string, interpret = (p: string) => this.interpret(p, actor)) {
    const filters = await interpret(prompt);
    let results: TitleCard[] = [];
    let dropped: string[] = [];
    let query: unknown;
    if (filters.titleSearch) {
      const page = await this.discover.search(filters.titleSearch);
      results = page.results.filter((r) => r.mediaType === filters.mediaType || !filters.titleSearch);
      query = { search: filters.titleSearch };
    } else {
      const mapped = filtersToBrowse(filters, await this.lookups(filters));
      dropped = mapped.dropped;
      query = mapped.query;
      for (let page = 1; page <= 5 && results.length < 40; page++) {
        const res = await this.discover.browse({ ...mapped.query, page });
        results.push(...res.results.filter((r) => libraryMatch(r.state as any, filters)));
        if (page >= res.totalPages) break;
      }
    }
    if (filters.titleSearch) results = results.filter((r) => libraryMatch(r.state as any, filters));
    audit(this.stack.db, actor, 'extras.nl.query', prompt.slice(0, 200), `${results.length} result(s); ${filters.summary}`);
    return { filters, query, dropped, results: results.slice(0, 60), monthToDate: this.monthToDate() };
  }
}
