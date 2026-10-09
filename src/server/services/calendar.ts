import type { Stack } from '../stack.ts';
import type { CalendarEvent } from '../../shared/types.ts';

export async function calendarEvents(stack: Stack, start: Date, end: Date): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  const [movies, episodes] = await Promise.all([
    stack.radarr ? stack.radarr.calendar(start, end).catch(() => []) : [],
    stack.sonarr ? stack.sonarr.calendar(start, end, { includeSeries: true }).catch(() => []) : [],
  ]);
  const inRange = (d?: string) => !!d && new Date(d) >= start && new Date(d) <= end;
  for (const m of movies as any[]) {
    for (const [kind, date] of [
      ['cinema', m.inCinemas],
      ['digital', m.digitalRelease],
      ['physical', m.physicalRelease],
    ] as const) {
      if (!inRange(date)) continue;
      out.push({
        id: `m${m.id}-${kind}`,
        date: date.slice(0, 10),
        allDay: true,
        mediaType: 'movie',
        kind,
        title: m.title,
        subtitle: kind === 'cinema' ? 'In cinemas' : kind === 'digital' ? 'Digital release' : 'Physical release',
        hasFile: !!m.hasFile,
        tmdbId: m.tmdbId,
      });
    }
  }
  for (const e of episodes as any[]) {
    if (!e.airDateUtc) continue;
    out.push({
      id: `e${e.id}`,
      date: e.airDateUtc,
      allDay: false,
      mediaType: 'tv',
      kind: 'episode',
      title: e.series?.title ?? 'Episode',
      subtitle: `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}${e.title ? ` · ${e.title}` : ''}`,
      hasFile: !!e.hasFile,
      tmdbId: e.series?.tmdbId,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function toIcs(events: CalendarEvent[]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Saga//Releases//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Saga releases', 'X-PUBLISHED-TTL:PT1H'];
  const stamp = icsDate(new Date());
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.id}@saga`, `DTSTAMP:${stamp}`);
    if (e.allDay) {
      const d = e.date.slice(0, 10).replace(/-/g, '');
      const next = new Date(`${e.date.slice(0, 10)}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, '')}`);
    } else {
      const start = new Date(e.date);
      lines.push(`DTSTART:${icsDate(start)}`, `DTEND:${icsDate(new Date(start.getTime() + 30 * 60_000))}`);
    }
    lines.push(`SUMMARY:${esc(`${e.title}${e.subtitle ? ` — ${e.subtitle}` : ''}`)}`);
    lines.push(`DESCRIPTION:${esc(e.hasFile ? 'In library' : 'Not downloaded yet')}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  // RFC 5545: CRLF and lines folded at 75 octets.
  return lines.map((l) => (l.length > 74 ? l.match(/.{1,74}/g)!.join('\r\n ') : l)).join('\r\n') + '\r\n';
}
