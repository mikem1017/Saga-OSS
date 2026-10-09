import { requestJson } from '../http.ts';

export interface SabQueueSlot {
  index: number;
  nzo_id: string;
  filename: string;
  cat: string;
  priority: string; // "Force" | "High" | "Normal" | "Low" | "Stop"
  status: string; // Downloading | Queued | Paused | Fetching | Propagating | Checking | Grabbing
  mb: string;
  mbleft: string;
  percentage: string;
  timeleft: string;
  time_added?: number;
}

export interface SabQueue {
  version: string;
  paused: boolean;
  pause_int: string;
  paused_all?: boolean;
  status: string;
  kbpersec: string;
  speedlimit: string;
  speedlimit_abs: string;
  mbleft: string;
  mb: string;
  noofslots_total: number;
  diskspace1: string;
  diskspacetotal1: string;
  timeleft: string;
  have_warnings: string;
  slots: SabQueueSlot[];
}

export interface SabHistorySlot {
  nzo_id: string;
  name: string;
  category: string;
  status: string; // Completed | Failed | Queued | Verifying | Repairing | Extracting | Moving | Running | Fetching
  completed: number;
  download_time: number;
  postproc_time: number;
  bytes: number;
  fail_message: string;
  action_line?: string;
  time_added?: number;
}

export interface SabServerStats {
  total: number;
  month: number;
  week: number;
  day: number;
  servers: Record<string, { total: number; month: number; week: number; day: number; daily?: Record<string, number> }>;
}

/** SAB priority values for mode=queue&name=priority. Force (2) is never used: it ignores pauses, including the PP guard's. */
export const SAB_PRIORITY = { Low: -1, Normal: 0, High: 1 } as const;

/** History statuses that mean a job is waiting for or in post-processing (Queued means waiting for post-processing). */
export const PP_STATES = new Set(['Queued', 'QuickCheck', 'Verifying', 'Repairing', 'Fetching', 'Extracting', 'Moving', 'Running']);

export class SabClient {
  readonly app = 'SABnzbd';
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private call<T>(mode: string, params: Record<string, string | number | undefined> = {}, timeoutMs = 30_000): Promise<T> {
    return requestJson<T>(this.app, this.baseUrl, '/api', {
      query: { mode, output: 'json', apikey: this.apiKey, ...params },
      timeoutMs,
    });
  }

  version() {
    return this.call<{ version: string }>('version');
  }

  async queue(start = 0, limit = 0): Promise<SabQueue> {
    const res = await this.call<{ queue: SabQueue }>('queue', { start, limit }, 60_000);
    return res.queue;
  }

  async history(limit = 200, archive = false): Promise<{ slots: SabHistorySlot[]; ppslots?: number; noofslots: number }> {
    const res = await this.call<{ history: { slots: SabHistorySlot[]; ppslots?: number; noofslots: number } }>('history', {
      limit,
      archive: archive ? 1 : undefined,
    });
    return res.history;
  }

  /** Failed jobs only (active history and the archive). */
  async failedHistory(limit = 200): Promise<SabHistorySlot[]> {
    const [a, b] = await Promise.all([
      this.call<{ history: { slots: SabHistorySlot[] } }>('history', { limit, failed_only: 1 }),
      this.call<{ history: { slots: SabHistorySlot[] } }>('history', { limit, failed_only: 1, archive: 1 }),
    ]);
    const seen = new Set<string>();
    return [...a.history.slots, ...b.history.slots].filter((s) => !seen.has(s.nzo_id) && seen.add(s.nzo_id));
  }

  /** Retry a failed job. Since 5.1, SAB re-fetches only the articles that were missing. */
  retry(nzoId: string) {
    return this.call<{ status: boolean }>('retry', { value: nzoId });
  }

  /** Remove a job from history. Files are kept (del_files=0): the agent or cleanup handles leftovers. */
  deleteHistory(nzoId: string) {
    return this.call<{ status: boolean }>('history', { name: 'delete', value: nzoId, del_files: 0, archive: 0 });
  }

  serverStats() {
    return this.call<SabServerStats>('server_stats');
  }

  warnings() {
    return this.call<{ warnings: { text: string; type: string; time: number }[] }>('warnings');
  }

  async getConfig(section?: string) {
    const res = await this.call<{ config: Record<string, any> }>('get_config', { section });
    return res.config;
  }

  /** Create or update one Usenet server. Omitted keys are left as SAB has them. */
  setServer(keyword: string, values: Record<string, string | number>) {
    return this.call<{ value?: unknown; status?: boolean }>('set_config', { section: 'servers', keyword, ...values });
  }

  pause() {
    return this.call<{ status: boolean }>('pause');
  }

  /** Timed pause; SAB resumes by itself when it runs out (shows as pause_int). */
  pauseFor(minutes: number) {
    return this.call<{ status: boolean }>('config', { name: 'set_pause', value: Math.round(minutes) });
  }

  resume() {
    return this.call<{ status: boolean }>('resume');
  }

  /** Move a job to a queue index. SAB won't place a job above higher-priority jobs. */
  switchPosition(nzoId: string, index: number) {
    return this.call<{ result: { priority: number; position: number } }>('switch', { value: nzoId, value2: index });
  }

  setPriority(nzoId: string, priority: number) {
    if (priority > SAB_PRIORITY.High) throw new Error('Refusing Force priority: it bypasses the PP guard pause');
    return this.call<{ position: number }>('queue', { name: 'priority', value: nzoId, value2: priority });
  }

  pauseJob(nzoId: string) {
    return this.call<{ status: boolean }>('queue', { name: 'pause', value: nzoId });
  }

  resumeJob(nzoId: string) {
    return this.call<{ status: boolean }>('queue', { name: 'resume', value: nzoId });
  }

  deleteJob(nzoId: string) {
    return this.call<{ status: boolean }>('queue', { name: 'delete', value: nzoId });
  }
}

export const mbToBytes = (mb: string | number) => Math.round(Number(mb) * 1024 * 1024);
