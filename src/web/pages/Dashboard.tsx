import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ChevronDown, RefreshCw } from 'lucide-react';
import type { HealthItem, ThroughputStats } from '../../shared/types.ts';
import { get, post } from '../api.ts';
import { bytes, duration, rate, relTime } from '../format.ts';
import { Button, Card, ErrorBox, ProgressBar, Spinner, Stat, StatusDot } from '../components/ui.tsx';

interface PlexOverview {
  sessions: { user: string; title: string; subtitle?: string; mediaType: string; progress: number; state: string; player: string; decision: string; resolution?: string; bandwidthKbps?: number; location?: string; thumb?: string }[];
  counts: { directPlay: number; directStream: number; transcode: number; bandwidthKbps: number };
  recentlyAdded: { title: string; subtitle?: string; mediaType: string; addedAt: number; thumb?: string }[];
  week: { plays: number; directPlay: number; copy: number; transcode: number; byUser: { user: string; plays: number }[] };
}

interface AgentResponse {
  feed: { ts: number; journalDate: string; journal: string; detectLogTail: string[]; running: boolean; cronEnabled: boolean; lastCommits: string[] } | null;
  error: string | null;
  gateTail: string[];
  cleanupTail: string[];
}

interface LibrarySummary {
  movies: number;
  moviesWithFile: number;
  movieBytes: number;
  byQuality: { quality: string; count: number }[];
  series: number;
  episodes: number;
  episodeFiles: number;
  tvBytes: number;
  refreshedAt: number;
}

const thumbOk = (t?: string) => !!t && /^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/.test(t);

/** Effective download rate in 10-minute buckets; paused buckets drawn in amber. */
function RateChart({ series }: { series: ThroughputStats['rateSeries'] }) {
  if (series.length < 2) return <p className="text-sm text-muted py-6 text-center">Not enough samples yet (one per minute).</p>;
  const W = 720;
  const H = 160;
  const pad = { l: 44, r: 8, t: 8, b: 22 };
  const max = Math.max(...series.map((s) => s.bps), 1);
  const t0 = series[0]!.ts;
  const t1 = series[series.length - 1]!.ts;
  const x = (ts: number) => pad.l + ((ts - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const bw = Math.max(1, (W - pad.l - pad.r) / series.length - 1);
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const hours = series.filter((s, i) => i === 0 || new Date(s.ts * 1000).getHours() !== new Date(series[i - 1]!.ts * 1000).getHours()).filter((_, i, arr) => i % Math.ceil(arr.length / 8) === 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Effective download rate, last 24 hours">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray={v ? '3 3' : undefined} />
          <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">
            {v ? `${(v / 1024 ** 2).toFixed(0)}M` : '0'}
          </text>
        </g>
      ))}
      {series.map((s) => (
        <rect key={s.ts} x={x(s.ts) - bw / 2} y={y(s.bps)} width={bw} height={Math.max(0, H - pad.b - y(s.bps))} fill={s.paused ? 'var(--warn)' : 'var(--info)'} opacity={0.85}>
          <title>{`${new Date(s.ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: ${rate(s.bps)}${s.paused ? ' (paused part of the time)' : ''}`}</title>
        </rect>
      ))}
      {hours.map((s) => (
        <text key={`h${s.ts}`} x={x(s.ts)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--muted)">
          {new Date(s.ts * 1000).toLocaleTimeString([], { hour: 'numeric' })}
        </text>
      ))}
    </svg>
  );
}

/** Imports per hour, movies and episodes stacked. */
function ImportsChart({ hourly }: { hourly: ThroughputStats['hourly'] }) {
  const W = 720;
  const H = 150;
  const pad = { l: 28, r: 8, t: 8, b: 22 };
  const max = Math.max(...hourly.map((h) => h.movies + h.episodes), 1);
  const n = hourly.length || 1;
  const step = (W - pad.l - pad.r) / n;
  const y = (v: number) => (v / max) * (H - pad.t - pad.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Imports per hour, last 48 hours">
      <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--border)" />
      <text x={pad.l - 6} y={pad.t + 8} textAnchor="end" fontSize="10" fill="var(--muted)">
        {max}
      </text>
      {hourly.map((h, i) => {
        const x0 = pad.l + i * step + 1;
        const hm = y(h.movies);
        const he = y(h.episodes);
        const label = new Date(h.hour * 1000);
        return (
          <g key={h.hour}>
            <rect x={x0} y={H - pad.b - hm} width={Math.max(1, step - 2)} height={hm} fill="var(--accent)" />
            <rect x={x0} y={H - pad.b - hm - he} width={Math.max(1, step - 2)} height={he} fill="var(--teal)" />
            <title>{`${label.toLocaleString([], { weekday: 'short', hour: 'numeric' })}: ${h.movies} movies, ${h.episodes} episodes`}</title>
            {label.getHours() % 6 === 0 && (
              <text x={x0 + step / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--muted)">
                {label.getHours() === 0 ? label.toLocaleDateString([], { weekday: 'short' }) : label.toLocaleTimeString([], { hour: 'numeric' })}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function HealthGrid() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['health'], queryFn: () => get<HealthItem[]>('/health'), refetchInterval: 60_000 });
  const refresh = useMutation({ mutationFn: () => post<HealthItem[]>('/health/refresh'), onSuccess: (d) => qc.setQueryData(['health'], d) });
  const [open, setOpen] = useState<string | null>(null);
  const order = { error: 0, warn: 1, unknown: 2, ok: 3 };
  const items = [...(q.data ?? [])].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  return (
    <Card
      title="Health"
      actions={
        <Button size="sm" variant="ghost" onClick={() => refresh.mutate()} busy={refresh.isPending}>
          <RefreshCw className="size-3.5" /> Check now
        </Button>
      }
    >
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && items.length === 0 && <p className="text-sm text-muted">First health check runs ~15 s after start.</p>}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((h) => (
          <div key={h.id} className="rounded-lg border border-line bg-surface-2">
            <button className="w-full flex items-start gap-2.5 p-3 text-left" onClick={() => setOpen(open === h.id ? null : h.id)} aria-expanded={open === h.id}>
              <span className="mt-1.5">
                <StatusDot status={h.status} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className="font-medium text-sm">{h.name}</span>
                  {h.version && <span className="text-[11px] text-muted">v{h.version}</span>}
                </span>
                <span className="block text-xs text-muted truncate" title={h.summary}>
                  {h.summary}
                </span>
              </span>
              {h.messages.length > 0 && <ChevronDown className={`size-4 text-muted transition ${open === h.id ? 'rotate-180' : ''}`} />}
            </button>
            {open === h.id && h.messages.length > 0 && (
              <ul className="px-3 pb-3 space-y-1 text-xs">
                {h.messages.map((m, i) => (
                  <li key={i} className={m.level === 'error' ? 'text-bad' : m.level === 'warn' ? 'text-warn' : 'text-muted'}>
                    {m.text}
                  </li>
                ))}
                <li className="text-muted/70">checked {relTime(h.checkedAt)}</li>
              </ul>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function PlexPanel() {
  const q = useQuery({ queryKey: ['plex'], queryFn: () => get<PlexOverview>('/plex', true), refetchInterval: 30_000 });
  if (q.isLoading) return <Card title="Plex"><Spinner /></Card>;
  if (q.error) return <Card title="Plex"><ErrorBox error={q.error} /></Card>;
  const p = q.data!;
  const w = p.week;
  return (
    <Card title="Plex">
      <div className="text-sm mb-3">
        {p.sessions.length ? (
          <span>
            {p.sessions.length} streaming · {p.counts.directPlay} direct play · {p.counts.directStream} direct stream · {p.counts.transcode} transcode · {(p.counts.bandwidthKbps / 1000).toFixed(1)} Mbps
          </span>
        ) : (
          <span className="text-muted">Nobody is watching right now.</span>
        )}
      </div>
      <div className="space-y-2 mb-4">
        {p.sessions.map((s, i) => (
          <div key={i} className="flex gap-3 rounded-lg border border-line bg-surface-2 p-2">
            <div className="w-10 h-14 rounded bg-surface-3 overflow-hidden shrink-0">{thumbOk(s.thumb) && <img src={`/api/plex/thumb?path=${encodeURIComponent(s.thumb!)}`} alt="" className="size-full object-cover" />}</div>
            <div className="flex-1 min-w-0 text-sm">
              <div className="font-medium truncate">
                {s.title}
                {s.subtitle && <span className="text-muted font-normal"> · {s.subtitle}</span>}
              </div>
              <div className="text-xs text-muted truncate">
                {s.user} · {s.player} · {s.state}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1">
                  <ProgressBar value={s.progress} tone={s.decision === 'transcode' ? 'warn' : 'ok'} />
                </div>
                <span className={`text-[11px] ${s.decision === 'transcode' ? 'text-warn' : 'text-ok'}`}>
                  {s.decision}
                  {s.resolution ? ` · ${s.resolution}` : ''}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-xs text-muted mb-1">Last 7 days · {w.plays} plays</div>
          <div className="flex h-2 rounded-full overflow-hidden bg-surface-3 mb-1" aria-hidden>
            <div className="bg-ok" style={{ width: `${(w.directPlay / Math.max(1, w.plays)) * 100}%` }} />
            <div className="bg-info" style={{ width: `${(w.copy / Math.max(1, w.plays)) * 100}%` }} />
            <div className="bg-warn" style={{ width: `${(w.transcode / Math.max(1, w.plays)) * 100}%` }} />
          </div>
          <div className="text-xs text-muted">
            <span className="text-ok">{w.directPlay} direct</span> · <span className="text-info">{w.copy} stream</span> · <span className="text-warn">{w.transcode} transcode</span>
          </div>
          <ul className="mt-2 text-xs space-y-0.5">
            {w.byUser.slice(0, 6).map((u) => (
              <li key={u.user} className="flex justify-between">
                <span className="truncate">{u.user}</span>
                <span className="text-muted tabular-nums">{u.plays}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="text-xs text-muted mb-1">Recently added</div>
          <ul className="space-y-1">
            {p.recentlyAdded.slice(0, 8).map((r, i) => (
              <li key={i} className="text-xs flex justify-between gap-2">
                <span className="truncate">
                  {r.title}
                  {r.subtitle && <span className="text-muted"> · {r.subtitle}</span>}
                </span>
                <span className="text-muted whitespace-nowrap">{relTime(r.addedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

function Tail({ title, lines }: { title: string; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <details className="rounded-lg border border-line bg-surface-2">
      <summary className="cursor-pointer px-3 py-2 text-sm">{title}</summary>
      <pre className="text-[11px] leading-relaxed px-3 pb-3 overflow-x-auto whitespace-pre-wrap break-all text-muted">{lines.join('\n')}</pre>
    </details>
  );
}

function AgentPanel() {
  const q = useQuery({ queryKey: ['agent'], queryFn: () => get<AgentResponse>('/agent'), refetchInterval: 120_000 });
  const a = q.data;
  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><Bot className="size-4" /> Maintenance agent (read-only)</span>}>
      {q.isLoading && <Spinner />}
      {a?.error && <p className="text-sm text-warn mb-2">{a.error}</p>}
      {a && !a.feed && !a.error && <p className="text-sm text-muted">No agent feed yet.</p>}
      {a?.feed && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2 text-sm">
            <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${a.feed.running ? 'bg-info text-white' : 'bg-surface-3'}`}>{a.feed.running ? 'Running a session now' : 'Idle'}</span>
            <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${a.feed.cronEnabled ? 'bg-ok/20 text-ok' : 'bg-warn/20 text-warn'}`}>Cron {a.feed.cronEnabled ? 'enabled' : 'paused'}</span>
            <span className="text-xs text-muted self-center">feed {relTime(a.feed.ts * 1000)}</span>
          </div>
          <details className="rounded-lg border border-line bg-surface-2" open>
            <summary className="cursor-pointer px-3 py-2 text-sm">Journal {a.feed.journalDate}</summary>
            <pre className="text-xs leading-relaxed px-3 pb-3 max-h-80 overflow-y-auto whitespace-pre-wrap">{a.feed.journal || '(empty)'}</pre>
          </details>
          <Tail title="detect.log" lines={a.feed.detectLogTail} />
          <Tail title="Recent commits" lines={a.feed.lastCommits} />
        </div>
      )}
      {a && (
        <div className="space-y-2 mt-2">
          <Tail title="Agent command log" lines={a.gateTail} />
          <Tail title="Cleanup log" lines={a.cleanupTail} />
        </div>
      )}
    </Card>
  );
}

export default function DashboardPage() {
  const t = useQuery({ queryKey: ['throughput'], queryFn: () => get<ThroughputStats>('/throughput'), refetchInterval: 60_000 });
  const lib = useQuery({ queryKey: ['library-summary'], queryFn: () => get<LibrarySummary>('/library/summary'), refetchInterval: 5 * 60_000 });
  const s = t.data;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
      {t.error && <ErrorBox error={t.error} />}
      {t.isLoading && <Spinner label="Reading import history" />}
      {s && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat label="Imports / hour (24 h)" value={s.importsPerHour} sub={`${s.importsLast24h.movies} movies · ${s.importsLast24h.episodes} episodes`} />
            <Stat label="Imported (24 h)" value={bytes(s.importsLast24h.bytes)} />
            <Stat
              label="Post-processing per job"
              value={s.ppAvgSec !== null ? duration(s.ppAvgSec) : '—'}
              sub={s.dlAvgSec !== null ? `vs ${duration(s.dlAvgSec)} downloading · n=${s.ppSampleSize}` : 'jobs over 1 GB'}
              tone={s.ppAvgSec !== null && s.dlAvgSec !== null && s.ppAvgSec > s.dlAvgSec ? 'warn' : undefined}
            />
            <Stat label="Failed NZBs (24 h)" value={s.failedRate !== null ? `${s.failedRate}%` : '—'} sub={`${s.failedLast24h} failed · ${s.completedLast24h} completed`} />
            <Stat label="Effective rate" value={rate(s.rate6hBps ?? s.rate1hBps)} sub={`1 h ${rate(s.rate1hBps)} · 24 h ${rate(s.rate24hBps)}`} />
            <Stat label="Backlog" value={bytes(s.backlogBytes)} sub={`ETA ~${duration(s.backlogEtaSec)}`} />
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Download rate · last 24 h">
              <RateChart series={s.rateSeries} />
              <p className="text-xs text-muted mt-1">
                Effective bytes per second in 10-minute buckets, pauses included. <span className="text-warn">Amber</span> = SAB was paused for part of the bucket.
              </p>
            </Card>
            <Card title="Imports per hour · last 48 h">
              <ImportsChart hourly={s.hourly} />
              <p className="text-xs text-muted mt-1">
                From Radarr/Sonarr import history. <span className="text-accent">Movies</span> · <span className="text-teal">episodes</span>
              </p>
            </Card>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Usenet servers">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted text-left">
                  <tr>
                    <th className="py-1">Server</th>
                    <th className="py-1 text-right">Today</th>
                    <th className="py-1 text-right">Week</th>
                    <th className="py-1 text-right">Month</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {s.servers.map((sv) => (
                    <tr key={sv.name} className="border-t border-line">
                      <td className="py-1.5 truncate max-w-[12rem]">{sv.name}</td>
                      <td className="py-1.5 text-right">{bytes(sv.day)}</td>
                      <td className="py-1.5 text-right">{bytes(sv.week)}</td>
                      <td className="py-1.5 text-right">{bytes(sv.month)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Storage">
              {s.storage.length === 0 && <p className="text-sm text-muted">No storage feed from the download host.</p>}
              <div className="space-y-3">
                {s.storage.map((d) => {
                  const pct = d.size ? (d.used / d.size) * 100 : 0;
                  return (
                    <div key={d.mount}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="font-mono text-xs">{d.mount}</span>
                        <span className={`tabular-nums text-xs ${pct > 85 ? 'text-warn' : 'text-muted'}`}>
                          {bytes(d.used)} / {bytes(d.size)} · {bytes(d.avail)} free
                        </span>
                      </div>
                      <ProgressBar value={pct} tone={pct > 85 ? 'warn' : 'ok'} />
                    </div>
                  );
                })}
              </div>
              {lib.data && (
                <div className="mt-4 pt-3 border-t border-line text-sm grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-xs text-muted">Movies</div>
                    {lib.data.moviesWithFile.toLocaleString()} / {lib.data.movies.toLocaleString()} on disk · {bytes(lib.data.movieBytes)}
                  </div>
                  <div>
                    <div className="text-xs text-muted">TV</div>
                    {lib.data.series} shows · {lib.data.episodeFiles.toLocaleString()} / {lib.data.episodes.toLocaleString()} episodes · {bytes(lib.data.tvBytes)}
                  </div>
                  <div className="col-span-2 flex flex-wrap gap-1.5">
                    {lib.data.byQuality.slice(0, 8).map((q) => (
                      <span key={q.quality} className="text-[11px] rounded-full bg-surface-2 border border-line px-2 py-0.5">
                        {q.quality} · {q.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>
        </>
      )}
      <HealthGrid />
      <div className="grid gap-5 lg:grid-cols-2">
        <PlexPanel />
        <AgentPanel />
      </div>
    </div>
  );
}
