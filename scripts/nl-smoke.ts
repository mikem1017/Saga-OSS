// One-off check of natural-language discover against the real Claude API (in-memory DB, no TMDB).
// Run with ANTHROPIC_API_KEY (+ ANTHROPIC_WORKSPACE_ID) in the environment. Prints status and token counts only.
import { openMemoryDb } from '../src/server/db.ts';
import { NlDiscover } from '../src/server/extras/nl.ts';

const db = openMemoryDb();
const nl = new NlDiscover({ db, config: {} } as any, {} as any);
try {
  const f = await nl.interpret('90s heist films in 4K I don’t have', 'smoke-test');
  console.log('ok', JSON.stringify({ mediaType: f.mediaType, genres: f.genres, keywords: f.keywords, years: [f.yearFrom, f.yearTo], library: f.library, haveQuality: f.haveQuality, summary: f.summary }));
} catch (err) {
  console.log('failed', err instanceof Error ? err.message : String(err));
}
console.log('usage', JSON.stringify(db.prepare('SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, round(cost_usd, 5) AS cost, ok, error FROM nl_queries').all()));
