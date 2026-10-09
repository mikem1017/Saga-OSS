import { describe, expect, it } from 'vitest';
import { mergePoolDisks } from '../src/server/services/downloads.ts';
import { bytesAheadOfNewJob, effectiveRate, queueEtas, formatDuration } from '../src/server/services/eta.ts';

const GB = 1024 ** 3;

describe('effectiveRate', () => {
  it('measures bytes per wall-clock second, pauses included', () => {
    // 60 MB/s for 30 min, then paused for 30 min: effective 30 MB/s over the hour.
    const s = [];
    for (let t = 0; t <= 3600; t += 60) s.push({ ts: 10_000 + t, totalBytes: 1e12 + Math.min(t, 1800) * 60e6 });
    expect(effectiveRate(s, 3600, 13_600)).toBeCloseTo(30e6, -4);
  });

  it('ignores counter resets', () => {
    const s = [
      { ts: 0, totalBytes: 1000 },
      { ts: 600, totalBytes: 61_000 },
      { ts: 1200, totalBytes: 10 }, // reset
      { ts: 1800, totalBytes: 60_010 },
    ];
    expect(effectiveRate(s, 3600, 1800)).toBeCloseTo(120_000 / 1800);
  });

  it('needs enough data', () => {
    expect(effectiveRate([{ ts: 0, totalBytes: 0 }], 3600, 0)).toBeNull();
    expect(effectiveRate([{ ts: 0, totalBytes: 0 }, { ts: 60, totalBytes: 100 }], 3600, 60)).toBeNull();
  });
});

describe('queueEtas', () => {
  it('walks the queue in order and skips paused jobs', () => {
    const etas = queueEtas(
      [
        { leftBytes: 10 * GB, status: 'Downloading' },
        { leftBytes: 5 * GB, status: 'Paused' },
        { leftBytes: 20 * GB, status: 'Queued' },
      ],
      GB / 10, // 100 MiB/s-ish → 10 s per GB
    );
    expect(etas[0]).toEqual({ startsInSec: 0, etaSec: 100 });
    expect(etas[1]).toEqual({ startsInSec: null, etaSec: null });
    expect(etas[2]).toEqual({ startsInSec: 100, etaSec: 300 });
  });

  it('returns nulls without a rate', () => {
    expect(queueEtas([{ leftBytes: 1, status: 'Queued' }], null)[0]).toEqual({ startsInSec: null, etaSec: null });
  });
});

describe('bytesAheadOfNewJob', () => {
  const slots = [
    { leftBytes: 1 * GB, priority: 'High', status: 'Downloading' },
    { leftBytes: 2 * GB, priority: 'High', status: 'Queued' },
    { leftBytes: 40 * GB, priority: 'Normal', status: 'Queued' },
    { leftBytes: 9 * GB, priority: 'Normal', status: 'Paused' },
  ];
  it('a new Normal job waits behind everything not paused', () => {
    expect(bytesAheadOfNewJob(slots, 'Normal', false)).toBe(43 * GB);
  });
  it('a bumped job only waits behind higher bands', () => {
    expect(bytesAheadOfNewJob(slots, 'High', true)).toBe(0);
    expect(bytesAheadOfNewJob(slots, 'Normal', true)).toBe(3 * GB);
  });
});

describe('formatDuration', () => {
  it('reads naturally', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(3 * 3600)).toBe('3.0 h');
    expect(formatDuration(3 * 86400)).toBe('3.0 days');
    expect(formatDuration(null)).toBe('unknown');
  });
});


describe('mergePoolDisks', () => {
  it('folds ZFS datasets of one pool into one entry', () => {
    const out = mergePoolDisks([
      { mount: '/mnt/cache/usenet', size: 100, used: 30, avail: 70 },
      { mount: '/mnt/media', size: 1000, used: 1, avail: 500 },
      { mount: '/mnt/media/movies', size: 1300, used: 800, avail: 500 },
      { mount: '/mnt/media/tv', size: 700, used: 200, avail: 500 },
    ]);
    expect(out).toEqual([
      { mount: '/mnt/cache/usenet', used: 30, avail: 70, size: 100 },
      { mount: '/mnt/media', used: 1001, avail: 500, size: 1501 },
    ]);
  });
});
