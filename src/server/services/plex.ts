import type { Stack } from '../stack.ts';

export interface PlexOverview {
  sessions: {
    user: string;
    title: string;
    subtitle?: string;
    mediaType: string;
    progress: number;
    state: string;
    player: string;
    decision: string;
    resolution?: string;
    bandwidthKbps?: number;
    location?: string;
    thumb?: string;
  }[];
  counts: { directPlay: number; directStream: number; transcode: number; bandwidthKbps: number };
  recentlyAdded: { title: string; subtitle?: string; mediaType: string; addedAt: number; thumb?: string }[];
  week: { plays: number; directPlay: number; copy: number; transcode: number; byUser: { user: string; plays: number }[] };
}

export async function plexOverview(stack: Stack): Promise<PlexOverview> {
  const t = stack.tautulli;
  if (!t) throw new Error('Tautulli is not configured');
  const after = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  // Recently added comes from Plex itself: Tautulli's list stays empty while the library is being rebuilt.
  const [act, recent, hist] = await Promise.all([
    t.activity(),
    stack.plex ? stack.plex.recentlyAdded(24).catch(() => []) : Promise.resolve([]),
    t.history({ after, length: 2000 }).catch(() => ({ data: [], recordsFiltered: 0 })),
  ]);
  const byUser = new Map<string, number>();
  let dp = 0;
  let copy = 0;
  let tc = 0;
  for (const h of hist.data ?? []) {
    byUser.set(h.friendly_name ?? h.user, (byUser.get(h.friendly_name ?? h.user) ?? 0) + 1);
    if (h.transcode_decision === 'transcode') tc++;
    else if (h.transcode_decision === 'copy') copy++;
    else dp++;
  }
  return {
    sessions: (act.sessions ?? []).map((s) => ({
      user: s.friendly_name || s.user,
      title: s.grandparent_title || s.title,
      subtitle: s.grandparent_title ? s.full_title.replace(`${s.grandparent_title} - `, '') : s.year,
      mediaType: s.media_type,
      progress: Number(s.progress_percent),
      state: s.state,
      player: `${s.player} (${s.platform})`,
      decision: s.transcode_decision,
      resolution: s.stream_video_full_resolution,
      bandwidthKbps: s.bandwidth ? Number(s.bandwidth) : undefined,
      location: s.location,
      thumb: s.thumb,
    })),
    counts: {
      directPlay: Number(act.stream_count_direct_play ?? 0),
      directStream: Number(act.stream_count_direct_stream ?? 0),
      transcode: Number(act.stream_count_transcode ?? 0),
      bandwidthKbps: Number(act.total_bandwidth ?? 0),
    },
    recentlyAdded: (recent as any[]).map((r) => ({
      title: r.grandparentTitle || r.parentTitle || r.title,
      subtitle: r.type === 'episode' ? `S${r.parentIndex}E${r.index} · ${r.title}` : r.type === 'season' ? r.title : r.year ? String(r.year) : undefined,
      mediaType: r.type,
      addedAt: Number(r.addedAt) * 1000,
      thumb: r.thumb || r.parentThumb || r.grandparentThumb,
    })),
    week: {
      plays: hist.data?.length ?? 0,
      directPlay: dp,
      copy,
      transcode: tc,
      byUser: [...byUser.entries()].map(([user, plays]) => ({ user, plays })).sort((a, b) => b.plays - a.plays),
    },
  };
}
