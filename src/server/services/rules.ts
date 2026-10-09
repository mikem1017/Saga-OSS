import type { DB } from '../db.ts';
import type { AddDecision, AddRule, MediaType, RuleActions, RuleConditions } from '../../shared/types.ts';
import type { QualityProfile, RootFolder } from '../connectors/arr.ts';

export interface TitleFacts {
  mediaType: MediaType;
  genres: string[];
  certification?: string;
  language?: string;
  year?: number;
}

export interface RuleContext {
  profiles: QualityProfile[];
  roots: RootFolder[];
  /** DEFAULT_MOVIE_PROFILE / DEFAULT_TV_PROFILE, matched by name. */
  preferredProfile?: string;
}

/** Built-in defaults before any rule fires: the configured profile (else the most tuned one), first root folder. */
export function defaultDecision(type: MediaType, ctx: RuleContext): AddDecision {
  // The configured default profile; otherwise whichever profile has the most scored custom formats (e.g. one
  // Recyclarr maintains). Never a stock profile by default.
  const tuned = [...ctx.profiles].sort((a, b) => (b.scoredFormats ?? 0) - (a.scoredFormats ?? 0))[0];
  const hq = (ctx.preferredProfile ? ctx.profiles.find((p) => p.name === ctx.preferredProfile) : undefined) ?? tuned ?? { id: 1, name: 'Any' };
  return {
    ruleId: null,
    ruleName: 'Default',
    qualityProfileId: hq.id,
    qualityProfileName: hq.name,
    rootFolderPath: ctx.roots[0]?.path ?? (type === 'movie' ? '/movies' : '/tv'),
    monitor: type === 'movie' ? 'movieOnly' : 'all',
    minimumAvailability: 'released',
    seriesType: 'standard',
    searchNow: true,
    bumpOnGrab: false,
    seasons: null,
  };
}

export function matches(c: RuleConditions, f: TitleFacts): boolean {
  const genres = f.genres.map((g) => g.toLowerCase());
  if (c.genresAny?.length && !c.genresAny.some((g) => genres.includes(g.toLowerCase()))) return false;
  if (c.genresNone?.length && c.genresNone.some((g) => genres.includes(g.toLowerCase()))) return false;
  if (c.certificationIn?.length && !(f.certification && c.certificationIn.includes(f.certification))) return false;
  if (c.languageIn?.length && !(f.language && c.languageIn.includes(f.language))) return false;
  if (c.yearMin && !(f.year && f.year >= c.yearMin)) return false;
  if (c.yearMax && !(f.year && f.year <= c.yearMax)) return false;
  return true;
}

/**
 * Rules run in position order and *stack*: each matching rule overrides only the fields it sets, so a
 * "kids → 1080p" rule and an "anime → anime series type" rule can both apply. The decision names every
 * rule that fired.
 */
export function decide(rules: AddRule[], facts: TitleFacts, ctx: RuleContext): AddDecision {
  const d = defaultDecision(facts.mediaType, ctx);
  const fired: string[] = [];
  for (const r of [...rules].sort((a, b) => a.position - b.position)) {
    if (!r.enabled) continue;
    if (r.mediaType !== 'any' && r.mediaType !== facts.mediaType) continue;
    if (!matches(r.conditions, facts)) continue;
    apply(d, r.actions, ctx);
    fired.push(r.name);
    if (d.ruleId === null) d.ruleId = r.id;
  }
  if (fired.length) d.ruleName = fired.join(' + ');
  return d;
}

function apply(d: AddDecision, a: RuleActions, ctx: RuleContext) {
  if (a.qualityProfileId !== undefined) {
    const p = ctx.profiles.find((p) => p.id === a.qualityProfileId);
    if (p) {
      d.qualityProfileId = p.id;
      d.qualityProfileName = p.name;
    }
  }
  if (a.rootFolderPath && ctx.roots.some((r) => r.path === a.rootFolderPath)) d.rootFolderPath = a.rootFolderPath;
  if (a.monitor) d.monitor = a.monitor;
  if (a.minimumAvailability) d.minimumAvailability = a.minimumAvailability;
  if (a.seriesType) d.seriesType = a.seriesType;
  if (a.searchNow !== undefined) d.searchNow = a.searchNow;
  if (a.bumpOnGrab !== undefined) d.bumpOnGrab = a.bumpOnGrab;
}

export function loadRules(db: DB): AddRule[] {
  return (db.prepare('SELECT * FROM add_rules ORDER BY position').all() as any[]).map((r) => ({
    id: r.id,
    position: r.position,
    name: r.name,
    enabled: !!r.enabled,
    mediaType: r.media_type,
    conditions: JSON.parse(r.conditions),
    actions: JSON.parse(r.actions),
  }));
}

export function saveRules(db: DB, rules: Omit<AddRule, 'id'>[]): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM add_rules').run();
    const ins = db.prepare('INSERT INTO add_rules (position, name, enabled, media_type, conditions, actions) VALUES (?, ?, ?, ?, ?, ?)');
    rules.forEach((r, i) => ins.run(i, r.name, r.enabled ? 1 : 0, r.mediaType, JSON.stringify(r.conditions), JSON.stringify(r.actions)));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * First-run rules. Quality comes from the default profile (DEFAULT_*_PROFILE, else the most tuned one),
 * so the only seeded rule sets Sonarr's series type for anime.
 */
export function seedRules(db: DB, _sonarrProfiles: QualityProfile[]): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM add_rules').get() as { n: number }).n;
  if (count > 0) return;
  saveRules(db, [
    {
      position: 0,
      name: 'Anime series type',
      enabled: true,
      mediaType: 'tv',
      conditions: { genresAny: ['Animation'], languageIn: ['ja'] },
      actions: { seriesType: 'anime' },
    },
  ]);
}
