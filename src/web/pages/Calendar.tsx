import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Copy, Film, Tv } from 'lucide-react';
import type { CalendarEvent } from '../../shared/types.ts';
import { get, post } from '../api.ts';
import { Button, Card, ErrorBox, inputCls, PageHeader, Spinner } from '../components/ui.tsx';
import { useToast } from '../components/toast.tsx';

const DAY = 86400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function IcalCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['ical'], queryFn: () => get<{ url: string | null }>('/calendar/ical') });
  const rotate = useMutation({
    mutationFn: () => post<{ url: string }>('/calendar/ical'),
    onSuccess: (d) => {
      qc.setQueryData(['ical'], d);
      toast('New iCal URL created; the old one stops working.', 'ok');
    },
  });
  return (
    <Card title="iCal feed" className="mb-5">
      <p className="text-sm text-muted mb-3">Subscribe from any calendar app. The URL is the secret, so treat it like a password; rotate it if it leaks.</p>
      {q.data?.url ? (
        <div className="flex flex-col sm:flex-row gap-2">
          <input className={`${inputCls} font-mono text-xs`} readOnly value={q.data.url} onFocus={(e) => e.target.select()} aria-label="iCal URL" />
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(q.data!.url!);
                toast('Copied', 'ok');
              } catch {
                toast('Copy failed; select and copy the URL', 'error');
              }
            }}
          >
            <Copy className="size-4" /> Copy
          </Button>
          <Button variant="ghost" busy={rotate.isPending} onClick={() => confirm('Create a new URL? Existing subscriptions stop updating.') && rotate.mutate()}>
            Rotate
          </Button>
        </div>
      ) : (
        <Button variant="primary" busy={rotate.isPending} onClick={() => rotate.mutate()}>
          Create iCal URL
        </Button>
      )}
    </Card>
  );
}

export default function CalendarPage() {
  const [start, setStart] = useState(() => startOfDay(new Date()));
  const days = 30;
  const end = new Date(start.getTime() + days * DAY);
  const q = useQuery({
    queryKey: ['calendar', start.toISOString()],
    queryFn: () => get<CalendarEvent[]>(`/calendar?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`),
  });
  const groups = new Map<string, CalendarEvent[]>();
  for (const e of q.data ?? []) {
    const d = e.allDay ? new Date(`${e.date.slice(0, 10)}T12:00:00`) : new Date(e.date);
    const key = startOfDay(d).toDateString();
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const today = startOfDay(new Date()).toDateString();
  return (
    <div>
      <PageHeader
        title="Calendar"
        sub={`${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setStart(new Date(start.getTime() - days * DAY))} aria-label="Previous 30 days">
              <ChevronLeft className="size-4" />
            </Button>
            <Button onClick={() => setStart(startOfDay(new Date()))}>Today</Button>
            <Button variant="ghost" onClick={() => setStart(new Date(start.getTime() + days * DAY))} aria-label="Next 30 days">
              <ChevronRight className="size-4" />
            </Button>
          </>
        }
      />
      <IcalCard />
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && q.data.length === 0 && <p className="text-muted text-sm">Nothing monitored is due in this window.</p>}
      <div className="space-y-4">
        {[...groups.entries()].map(([day, events]) => {
          const d = new Date(day);
          return (
            <section key={day}>
              <h2 className={`text-sm font-semibold mb-1.5 ${day === today ? 'text-accent' : 'text-muted'}`}>
                {d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
                {day === today && ' · today'}
              </h2>
              <ul className="rounded-xl border border-line bg-surface divide-y divide-line">
                {events.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    {e.mediaType === 'movie' ? <Film className="size-4 text-muted shrink-0" /> : <Tv className="size-4 text-muted shrink-0" />}
                    <span className="flex-1 min-w-0 truncate">
                      {e.tmdbId ? (
                        <Link to={`/${e.mediaType}/${e.tmdbId}`} className="font-medium hover:text-accent">
                          {e.title}
                        </Link>
                      ) : (
                        <span className="font-medium">{e.title}</span>
                      )}
                      {e.subtitle && <span className="text-muted"> · {e.subtitle}</span>}
                    </span>
                    {!e.allDay && <span className="text-xs text-muted tabular-nums">{new Date(e.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
                    <span className={`text-[11px] rounded px-1.5 py-0.5 font-semibold ${e.hasFile ? 'bg-ok text-black' : 'bg-surface-3 text-muted'}`}>{e.hasFile ? 'In library' : 'Not yet'}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
