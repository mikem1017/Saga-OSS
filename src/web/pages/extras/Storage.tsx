import { useQuery } from '@tanstack/react-query';
import { get } from '../../api.ts';
import { bytes, relTime } from '../../format.ts';
import { Card, ErrorBox, ProgressBar, Spinner, Stat } from '../../components/ui.tsx';

interface Forecast {
  generatedAt: number;
  media: { mount: string; used: number; avail: number; size: number } | null;
  cache: { mount: string; used: number; avail: number; size: number; headroomBytes: number; sabMinFreeBytes: number } | null;
  growthBytesPerDay: number | null;
  growthBasis: string;
  importsDaily: { day: string; bytes: number }[];
  queue: { totalBytes: number; byCategory: { category: string; bytes: number }[] };
  queueFits: boolean | null;
  afterQueueAvail: number | null;
  fill: { daysToFull: number | null; fullAt: number | null; projection: { day: number; used: number }[] } | null;
  poolSamples: number;
}

/** Projected pool usage over time, against pool size and the remaining queue. */
function ProjectionChart({ f }: { f: Forecast }) {
  if (!f.media || !f.fill || f.fill.projection.length < 2) return <p className="text-sm text-muted py-6 text-center">No growth measured yet, so there's nothing to project.</p>;
  const W = 720;
  const H = 200;
  const pad = { l: 52, r: 10, t: 10, b: 24 };
  const pts = f.fill.projection;
  const maxDay = pts[pts.length - 1]!.day || 1;
  const size = f.media.size;
  const x = (d: number) => pad.l + (d / maxDay) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / size) * (H - pad.t - pad.b);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.used).toFixed(1)}`).join(' ');
  const queueLine = f.media.used + f.queue.totalBytes;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Projected media pool usage">
      {[0, 0.5, 1].map((fr) => (
        <g key={fr}>
          <line x1={pad.l} x2={W - pad.r} y1={y(fr * size)} y2={y(fr * size)} stroke="var(--border)" strokeDasharray={fr === 1 ? undefined : '3 3'} />
          <text x={pad.l - 6} y={y(fr * size) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">
            {bytes(fr * size, 0)}
          </text>
        </g>
      ))}
      {queueLine < size && (
        <g>
          <line x1={pad.l} x2={W - pad.r} y1={y(queueLine)} y2={y(queueLine)} stroke="var(--warn)" strokeDasharray="5 4" />
          <text x={W - pad.r} y={y(queueLine) - 4} textAnchor="end" fontSize="10" fill="var(--warn)">
            today + whole queue
          </text>
        </g>
      )}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" />
      {[0, Math.round(maxDay / 2), maxDay].map((d) => (
        <text key={d} x={x(d)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--muted)">
          {d === 0 ? 'today' : `+${d} d`}
        </text>
      ))}
    </svg>
  );
}

function ImportBars({ daily }: { daily: Forecast['importsDaily'] }) {
  const max = Math.max(...daily.map((d) => d.bytes), 1);
  return (
    <div className="flex items-end gap-1 h-28" role="img" aria-label="Imported bytes per day, last 14 days">
      {daily.map((d) => (
        <div key={d.day} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={`${d.day}: ${bytes(d.bytes)}`}>
          <div className="w-full bg-accent/70 rounded-t" style={{ height: `${(d.bytes / max) * 100}%`, minHeight: d.bytes ? 2 : 0 }} />
          <span className="text-[9px] text-muted">{d.day.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}

export default function Storage() {
  const q = useQuery({ queryKey: ['extras-forecast'], queryFn: () => get<Forecast>('/extras/forecast'), refetchInterval: 10 * 60_000 });
  if (q.isLoading) return <Spinner label="Reading pool usage and import history" />;
  if (q.error) return <ErrorBox error={q.error} />;
  const f = q.data!;
  const days = f.fill?.daysToFull;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label="Media pool full in"
          value={days == null ? '—' : days > 365 * 3 ? '3+ years' : days > 60 ? `${(days / 30).toFixed(1)} months` : `${days.toFixed(0)} days`}
          sub={f.fill?.fullAt ? new Date(f.fill.fullAt).toLocaleDateString() : 'not growing'}
          tone={days != null && days < 60 ? 'warn' : undefined}
        />
        <Stat label="Growth" value={f.growthBytesPerDay ? `${bytes(f.growthBytesPerDay)}/day` : '—'} sub={f.growthBasis} />
        <Stat
          label="Remaining queue"
          value={bytes(f.queue.totalBytes, 0)}
          sub={f.queueFits == null ? undefined : f.queueFits ? `fits: ${bytes(f.afterQueueAvail, 0)} left after` : 'does NOT fit in the media pool'}
          tone={f.queueFits === false ? 'bad' : undefined}
        />
        <Stat
          label="Cache pool headroom"
          value={f.cache ? bytes(f.cache.headroomBytes, 1) : '—'}
          sub={f.cache ? `above SAB's ${bytes(f.cache.sabMinFreeBytes, 0)} minimum free` : 'no host feed'}
          tone={f.cache && f.cache.headroomBytes < 200 * 1024 ** 3 ? 'warn' : undefined}
        />
      </div>
      <Card title="Media pool projection">
        {f.media && (
          <div className="mb-3 text-sm">
            <div className="flex justify-between text-xs text-muted mb-1">
              <span>
                {f.media.mount}: {bytes(f.media.used)} used of {bytes(f.media.size)}
              </span>
              <span>{bytes(f.media.avail)} free</span>
            </div>
            <ProgressBar value={(f.media.used / f.media.size) * 100} tone={f.media.used / f.media.size > 0.85 ? 'warn' : 'info'} />
          </div>
        )}
        <ProjectionChart f={f} />
        <p className="text-xs text-muted mt-2">
          {f.poolSamples < 24
            ? 'Saga records pool usage hourly; until it has a day or two of history the rate comes from *arr import sizes, which over-counts upgrades that replace files.'
            : `Based on ${f.poolSamples} hourly pool readings.`}{' '}
          Updated {relTime(f.generatedAt)}.
        </p>
      </Card>
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Imported per day (14 days)">
          <ImportBars daily={f.importsDaily} />
        </Card>
        <Card title="Queue by category">
          <ul className="space-y-2 text-sm">
            {f.queue.byCategory.map((c) => (
              <li key={c.category}>
                <div className="flex justify-between">
                  <span>{c.category}</span>
                  <span className="tabular-nums text-muted">{bytes(c.bytes)}</span>
                </div>
                <ProgressBar value={(c.bytes / Math.max(1, f.queue.totalBytes)) * 100} />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
