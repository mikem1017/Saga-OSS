export function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  if (sec < 90) return '1 min';
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 48 * 3600) {
    const h = sec / 3600;
    return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
  }
  const d = sec / 86400;
  return `${d < 10 ? d.toFixed(1).replace(/\.0$/, '') : Math.round(d)} days`;
}

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i >= 3 ? digits : 0)} ${units[i]}`;
}

export function rate(bps: number | null | undefined): string {
  if (!bps) return '—';
  return `${bytes(bps)}/s`;
}

export function relTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  return `${Math.round(diff / 86400)} d ago`;
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const img = (path: string | null | undefined, size: 'w92' | 'w185' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original' = 'w342') =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;

export function plural(n: number, word: string, pluralWord = `${word}s`) {
  return `${n.toLocaleString()} ${n === 1 ? word : pluralWord}`;
}
