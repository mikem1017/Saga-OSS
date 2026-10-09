/**
 * Honest ETAs. SAB's own timeleft divides by the instantaneous speed and ignores pauses (the PP guard,
 * low-disk pauses), so it's wildly optimistic one minute and absurd the next. Saga instead measures the
 * effective rate — bytes SAB actually downloaded per wall-clock second over a window, pauses included —
 * and walks the queue in order, since SAB runs strictly in queue order.
 */

export interface RateSample {
  ts: number; // unix seconds
  totalBytes: number | null; // SAB server_stats.total, monotonic except on reset
}

/** Effective download rate (bytes/s) over the last `windowSec`. Null if there isn't enough data. */
export function effectiveRate(samples: RateSample[], windowSec: number, nowSec: number): number | null {
  const pts = samples.filter((s) => s.totalBytes !== null && s.ts >= nowSec - windowSec).sort((a, b) => a.ts - b.ts);
  if (pts.length < 2) return null;
  const span = pts[pts.length - 1]!.ts - pts[0]!.ts;
  if (span < Math.min(windowSec * 0.25, 600)) return null; // need at least a quarter of the window (max 10 min)
  let bytes = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i]!.totalBytes! - pts[i - 1]!.totalBytes!;
    if (d > 0) bytes += d; // a negative delta is a counter reset; skip it
  }
  return bytes / span;
}

export interface EtaInput {
  leftBytes: number;
  status: string;
}

export interface EtaOutput {
  startsInSec: number | null;
  etaSec: number | null;
}

/** Cumulative ETAs for queue slots in SAB order. Paused jobs are skipped by SAB, so they don't block those behind them. */
export function queueEtas(slots: EtaInput[], rateBps: number | null): EtaOutput[] {
  let ahead = 0;
  return slots.map((s) => {
    if (s.status === 'Paused') return { startsInSec: null, etaSec: null };
    const out =
      rateBps && rateBps > 0
        ? { startsInSec: Math.round(ahead / rateBps), etaSec: Math.round((ahead + s.leftBytes) / rateBps) }
        : { startsInSec: null, etaSec: null };
    ahead += s.leftBytes;
    return out;
  });
}

/** Bytes queued ahead of a new job that joins at a given priority (SAB keeps priority bands in order). */
export function bytesAheadOfNewJob(slots: { leftBytes: number; priority: string; status: string }[], priority: 'High' | 'Normal', atTopOfBand: boolean): number {
  const rank = (p: string) => (p === 'Force' ? 3 : p === 'High' ? 2 : p === 'Normal' ? 1 : 0);
  const mine = rank(priority);
  let ahead = 0;
  for (const s of slots) {
    if (s.status === 'Paused') continue;
    const r = rank(s.priority);
    if (r > mine || (r === mine && !atTopOfBand)) ahead += s.leftBytes;
  }
  return ahead;
}

export function formatDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return 'unknown';
  if (sec < 90) return `${Math.max(1, Math.round(sec))}s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 48 * 3600) return `${(sec / 3600).toFixed(sec < 36000 ? 1 : 0)} h`;
  return `${(sec / 86400).toFixed(1)} days`;
}
