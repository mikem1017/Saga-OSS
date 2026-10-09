// API shapes shared by the server and the web app.

export type MediaType = 'movie' | 'tv';

/** Live library state shown as a badge on every title. */
export type LibraryState =
  | { kind: 'available'; quality: string; resolution?: number; have?: number; total?: number; plexUrl?: string }
  | { kind: 'downloading'; percent: number; etaSec: number | null; position: number; jobs?: number }
  | { kind: 'queued'; position: number; etaSec: number | null; startsInSec: number | null; jobs?: number }
  | { kind: 'importing'; detail?: string }
  | { kind: 'missing'; monitored: boolean; have?: number; total?: number }
  | { kind: 'requested'; by: string[] }
  | { kind: 'none' };

export interface TitleCard {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year?: number;
  posterPath?: string | null;
  backdropPath?: string | null;
  rating?: number;
  overview?: string;
  state: LibraryState;
  /** Character or job, for person pages. */
  role?: string;
}

export interface Page<T> {
  page: number;
  totalPages: number;
  totalResults: number;
  results: T[];
  /** Set when one response spans several upstream pages (owned titles hidden): where to continue. */
  nextPage?: number;
  /** True when titles already in the library were left out. */
  filtered?: boolean;
}

export interface AddDecision {
  ruleId: number | null;
  ruleName: string;
  qualityProfileId: number;
  qualityProfileName: string;
  rootFolderPath: string;
  monitor: 'all' | 'future' | 'missing' | 'existing' | 'firstSeason' | 'lastSeason' | 'pilot' | 'none' | 'movieOnly';
  minimumAvailability: 'announced' | 'inCinemas' | 'released';
  seriesType: 'standard' | 'anime' | 'daily';
  searchNow: boolean;
  bumpOnGrab: boolean;
  /** TV only: explicit season selection; null = follow `monitor`. */
  seasons: number[] | null;
}

export interface AddPreviewItem {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year?: number;
  posterPath?: string | null;
  decision: AddDecision;
  alreadyInLibrary: boolean;
  estBytes: number;
  estBasis: string;
}

export interface AddPreview {
  items: AddPreviewItem[];
  toAdd: number;
  totalBytes: number;
  /** Seconds until the last item finishes if it joins the back of the queue. */
  etaBackSec: number | null;
  /** Same, if bumped to the top of its priority band. */
  etaBumpedSec: number | null;
  rateBps: number | null;
  queueBytesAhead: number;
}

export interface AddResult {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  ok: boolean;
  message: string;
  arrId?: number;
}

export interface QueueJob {
  nzoId: string;
  index: number;
  name: string;
  category: string;
  priority: string;
  status: string;
  sizeBytes: number;
  leftBytes: number;
  percent: number;
  etaSec: number | null;
  startsInSec: number | null;
  arr?: { app: 'radarr' | 'sonarr'; itemId: number; title: string; tmdbId?: number; mediaType: MediaType; queueId: number; episode?: string };
}

export interface PostProcJob {
  nzoId: string;
  name: string;
  category: string;
  status: string;
  actionLine?: string;
  completed?: number;
}

export interface GuardState {
  available: boolean;
  paused: boolean;
  pausedSince: number | null;
  heartbeatAgeSec: number | null;
  fresh: boolean;
  logTail: string[];
}

export interface DownloadsSnapshot {
  updatedAt: number;
  sabPaused: boolean;
  pauseReason: string | null;
  speedBps: number;
  speedLimitBps: number | null;
  rateBps: number | null;
  rateWindowMin: number;
  totalJobs: number;
  totalLeftBytes: number;
  backlogEtaSec: number | null;
  categories: { category: string; jobs: number; leftBytes: number }[];
  guard: GuardState;
  postProcessing: PostProcJob[];
  jobs: QueueJob[];
  jobsTotalMatched: number;
}

export interface HealthItem {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'error' | 'unknown';
  version?: string;
  summary: string;
  messages: { level: 'info' | 'warn' | 'error'; text: string }[];
  checkedAt: number;
}

export interface ThroughputStats {
  updatedAt: number;
  importsLast24h: { movies: number; episodes: number; bytes: number };
  importsPerHour: number;
  hourly: { hour: number; movies: number; episodes: number }[];
  ppAvgSec: number | null;
  dlAvgSec: number | null;
  ppSampleSize: number;
  failedLast24h: number;
  completedLast24h: number;
  failedRate: number | null;
  servers: { name: string; day: number; week: number; month: number; total: number }[];
  rate1hBps: number | null;
  rate6hBps: number | null;
  rate24hBps: number | null;
  backlogBytes: number;
  backlogEtaSec: number | null;
  rateSeries: { ts: number; bps: number; paused: boolean }[];
  storage: { mount: string; size: number; used: number; avail: number }[];
}

export interface CalendarEvent {
  id: string;
  date: string;
  allDay: boolean;
  mediaType: MediaType;
  kind: 'episode' | 'cinema' | 'digital' | 'physical';
  title: string;
  subtitle?: string;
  hasFile: boolean;
  tmdbId?: number;
}

export interface ActivityEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  ok: boolean;
}

export interface RuleConditions {
  genresAny?: string[];
  genresNone?: string[];
  certificationIn?: string[];
  languageIn?: string[];
  yearMin?: number;
  yearMax?: number;
  animation?: boolean;
}

export interface RuleActions {
  qualityProfileId?: number;
  rootFolderPath?: string;
  monitor?: AddDecision['monitor'];
  minimumAvailability?: AddDecision['minimumAvailability'];
  seriesType?: AddDecision['seriesType'];
  searchNow?: boolean;
  bumpOnGrab?: boolean;
}

export interface AddRule {
  id: number;
  position: number;
  name: string;
  enabled: boolean;
  mediaType: MediaType | 'any';
  conditions: RuleConditions;
  actions: RuleActions;
}

export interface Me {
  username: string;
  role: string;
  csrf: string;
}

/** A download the admin can act on (Downloads → Problems). */
export interface Problem {
  id: string; // arr:<app>:<queueId> | sab:<nzo_id>
  kind: 'arr-stuck' | 'sab-failed';
  app: 'radarr' | 'sonarr';
  title: string;
  mediaType: 'movie' | 'tv';
  tmdbId?: number;
  release: string;
  messages: string[];
  state: string | null;
  at: number | null;
  /** An *arr queue item still exists for it. Untracked SAB failures are never re-searched automatically. */
  tracked: boolean;
  queueId?: number;
  nzoId?: string;
  movieId?: number;
  seriesId?: number;
  episodeIds?: number[];
  seasonNumber?: number;
  actions: ('search' | 'releases' | 'retry' | 'dismiss')[];
  /** A maintenance-agent run was started for this problem from Saga. */
  agentTaskId?: string;
}

export interface ReleaseOption {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  ageDays: number;
  score: number;
  quality: string | null;
  rejected: boolean;
  rejections: string[];
  /** Same release name as the one that failed (often the same upload). */
  sameAsFailed: boolean;
}
