import { describe, expect, it } from 'vitest';
import { decide, seedRules, loadRules } from '../src/server/services/rules.ts';
import { openMemoryDb } from '../src/server/db.ts';
import type { AddRule } from '../src/shared/types.ts';

const tvCtx = {
  profiles: [
    { id: 4, name: 'HD-1080p' },
    { id: 7, name: 'Tuned-TV' },
  ],
  roots: [{ id: 1, path: '/tv' }],
  preferredProfile: 'Tuned-TV',
};
const movieCtx = { profiles: [{ id: 1, name: 'Any' }, { id: 7, name: 'Tuned-Movies' }], roots: [{ id: 1, path: '/movies' }], preferredProfile: 'Tuned-Movies' };

describe('add rules', () => {
  it('defaults to the configured profile and first root', () => {
    const d = decide([], { mediaType: 'movie', genres: ['Action'] }, movieCtx);
    expect(d).toMatchObject({ qualityProfileName: 'Tuned-Movies', rootFolderPath: '/movies', ruleName: 'Default', monitor: 'movieOnly' });
  });

  it('seeded rules never pick a stock profile; anime gets the anime type', () => {
    const db = openMemoryDb();
    seedRules(db, tvCtx.profiles);
    const rules = loadRules(db);
    const kids = decide(rules, { mediaType: 'tv', genres: ['Kids', 'Animation'], certification: 'TV-Y7', language: 'en' }, tvCtx);
    expect(kids.qualityProfileName).toBe('Tuned-TV');
    const anime = decide(rules, { mediaType: 'tv', genres: ['Animation'], language: 'ja' }, tvCtx);
    expect(anime.seriesType).toBe('anime');
    expect(anime.qualityProfileName).toBe('Tuned-TV');
  });

  it('falls back to the most-tuned profile, not the last one', () => {
    const ctx = { profiles: [{ id: 9, name: 'Tuned', scoredFormats: 40 }, { id: 4, name: 'HD-1080p', scoredFormats: 0, stock: true }], roots: [{ id: 1, path: '/m' }] };
    expect(decide([], { mediaType: 'movie', genres: [] }, ctx).qualityProfileName).toBe('Tuned');
  });

  it('skips disabled rules, wrong media types, and unknown profiles', () => {
    const rules: AddRule[] = [
      { id: 1, position: 0, name: 'off', enabled: false, mediaType: 'any', conditions: {}, actions: { qualityProfileId: 1 } },
      { id: 2, position: 1, name: 'tv only', enabled: true, mediaType: 'tv', conditions: {}, actions: { qualityProfileId: 1 } },
      { id: 3, position: 2, name: 'bogus', enabled: true, mediaType: 'movie', conditions: {}, actions: { qualityProfileId: 999 } },
    ];
    const d = decide(rules, { mediaType: 'movie', genres: [] }, movieCtx);
    expect(d.qualityProfileName).toBe('Tuned-Movies');
    expect(d.ruleName).toBe('bogus');
  });

  it('year bounds need a known year', () => {
    const rules: AddRule[] = [{ id: 1, position: 0, name: 'old', enabled: true, mediaType: 'movie', conditions: { yearMax: 1980 }, actions: { qualityProfileId: 1 } }];
    expect(decide(rules, { mediaType: 'movie', genres: [], year: 1975 }, movieCtx).qualityProfileName).toBe('Any');
    expect(decide(rules, { mediaType: 'movie', genres: [] }, movieCtx).qualityProfileName).toBe('Tuned-Movies');
  });
});
