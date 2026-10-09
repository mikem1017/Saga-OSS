import type { Stack } from '../stack.ts';
import type { HealthItem } from '../../shared/types.ts';
import type { ArrClient } from '../connectors/arr.ts';
import type { AgentFeed } from '../connectors/feeds.ts';
import type { DownloadsService } from './downloads.ts';
import type { LibraryService } from './library.ts';
import { UpstreamError } from '../http.ts';

const CACHE_POOL_WARN = 0.85; // ZFS slows past ~85%

/** *arr health → our levels. "Update available" is informational: update-arr.sh pulls new images every Sunday. */
function arrMessage(h: { source: string; type: string; message: string }): HealthItem['messages'][number] {
  if (h.source === 'UpdateCheck') return { level: 'info', text: h.message };
  return { level: h.type === 'error' ? 'error' : h.type === 'warning' ? 'warn' : 'info', text: h.message };
}

/** Health of every app Saga talks to, refreshed every two minutes in the background. */
export class HealthService {
  items = new Map<string, HealthItem>();
  agent: AgentFeed | null = null;
  agentError: string | null = null;
  private lastClientTest = 0;
  private clientTests = new Map<string, { ok: boolean; errors: string[] }>();
  private lastPlexTv = 0;
  private plexTv: { valid: boolean; username?: string; detail?: string } | null = null;

  constructor(
    private readonly stack: Stack,
    private readonly downloads: DownloadsService,
    private readonly library: LibraryService,
  ) {}

  list(): HealthItem[] {
    return [...this.items.values()];
  }

  private set(item: Omit<HealthItem, 'checkedAt'>) {
    this.items.set(item.id, { ...item, checkedAt: Date.now() });
  }

  async refresh(): Promise<void> {
    const s = this.stack;
    const tasks: Promise<unknown>[] = [];
    const testClients = Date.now() - this.lastClientTest > 15 * 60_000;
    if (testClients) this.lastClientTest = Date.now();
    for (const [id, client] of [
      ['radarr', s.radarr],
      ['sonarr', s.sonarr],
      ['lidarr', s.lidarr],
    ] as [string, ArrClient | undefined][])
      if (client) tasks.push(this.checkArr(id, client, testClients));
    if (s.prowlarr) tasks.push(this.checkProwlarr());
    if (s.sab) tasks.push(this.checkSab());
    if (s.plex) tasks.push(this.checkPlex());
    if (s.tautulli) tasks.push(this.simple('tautulli', 'Tautulli', () => s.tautulli!.serverInfo().then(() => undefined)));
    if (s.seerr) tasks.push(this.simple('seerr', 'Seerr', () => s.seerr!.status().then((r) => r.version)));
    if (s.tmdb) tasks.push(this.simple('tmdb', 'TMDB', () => s.tmdb!.configurationCheck().then(() => undefined)));
    tasks.push(this.checkGuardAndStorage());
    if (s.feedAgent) tasks.push(this.checkAgent());
    await Promise.allSettled(tasks);
    this.set({
      id: 'saga-library',
      name: 'Library cache',
      status: this.library.lastError ? 'warn' : this.library.lastRefresh ? 'ok' : 'unknown',
      summary: this.library.lastRefresh
        ? `${this.library.movies.size} movies, ${this.library.series.size} series; refreshed ${Math.round((Date.now() - this.library.lastRefresh) / 60_000)} min ago`
        : 'Not loaded yet',
      messages: this.library.lastError ? [{ level: 'warn', text: this.library.lastError }] : [],
    });
  }

  private describe(err: unknown): { status: HealthItem['status']; text: string } {
    if (err instanceof UpstreamError && err.authFailed) return { status: 'error', text: `${err.message} — the API key or token is invalid or expired` };
    return { status: 'error', text: err instanceof Error ? err.message : String(err) };
  }

  private async simple(id: string, name: string, fn: () => Promise<string | undefined>) {
    try {
      const version = await fn();
      this.set({ id, name, status: 'ok', version, summary: 'Reachable', messages: [] });
    } catch (err) {
      const d = this.describe(err);
      this.set({ id, name, status: d.status, summary: d.text, messages: [{ level: 'error', text: d.text }] });
    }
  }

  private async checkArr(id: string, client: ArrClient, testClients: boolean) {
    try {
      const [status, health] = await Promise.all([client.systemStatus(), client.health()]);
      if (testClients) {
        const tests = await client.testAllDownloadClients().catch((e) => [{ id: 0, isValid: false, validationFailures: [{ errorMessage: String(e.message ?? e) }] }]);
        this.clientTests.set(id, { ok: tests.every((t) => t.isValid), errors: tests.flatMap((t) => t.validationFailures.map((f) => f.errorMessage)) });
      }
      const ct = this.clientTests.get(id);
      const messages = health.map(arrMessage);
      if (ct && !ct.ok) messages.unshift({ level: 'error', text: `Download client test failed: ${ct.errors.join('; ') || 'unknown'}` });
      const worst = messages.some((m) => m.level === 'error') ? 'error' : messages.some((m) => m.level === 'warn') ? 'warn' : 'ok';
      this.set({
        id,
        name: client.app,
        status: worst,
        version: status.version,
        summary: messages.some((m) => m.level !== 'info') ? `${messages.filter((m) => m.level !== 'info').length} health message(s)` : `Healthy${ct ? '; download client OK' : ''}`,
        messages,
      });
    } catch (err) {
      const d = this.describe(err);
      this.set({ id, name: client.app, status: d.status, summary: d.text, messages: [{ level: 'error', text: d.text }] });
    }
  }

  private async checkProwlarr() {
    const p = this.stack.prowlarr!;
    try {
      const [status, health, indexers, istatus] = await Promise.all([p.systemStatus(), p.health(), p.indexers(), p.indexerStatus()]);
      const messages = health.map(arrMessage);
      for (const st of istatus) {
        const ix = indexers.find((i) => i.id === st.indexerId);
        if (st.disabledTill && new Date(st.disabledTill) > new Date())
          messages.push({ level: 'warn', text: `${ix?.name ?? `Indexer ${st.indexerId}`} disabled until ${new Date(st.disabledTill).toLocaleString()} after failures` });
      }
      const enabled = indexers.filter((i) => i.enable);
      const worst = messages.some((m) => m.level === 'error') ? 'error' : messages.some((m) => m.level === 'warn') ? 'warn' : 'ok';
      this.set({ id: 'prowlarr', name: 'Prowlarr', status: worst, version: status.version, summary: `${enabled.length} indexer(s) enabled: ${enabled.map((i) => i.name).join(', ')}`, messages });
    } catch (err) {
      const d = this.describe(err);
      this.set({ id: 'prowlarr', name: 'Prowlarr', status: d.status, summary: d.text, messages: [{ level: 'error', text: d.text }] });
    }
  }

  private async checkSab() {
    const sab = this.stack.sab!;
    try {
      const [ver, warnings] = await Promise.all([sab.version(), sab.warnings().catch(() => ({ warnings: [] }))]);
      const messages: HealthItem['messages'] = (warnings.warnings ?? []).slice(-5).map((w: any) => ({ level: w.type === 'ERROR' ? 'error' : 'warn', text: String(w.text).slice(0, 300) }));
      if (this.downloads.queueError) messages.unshift({ level: 'error', text: `Queue poll failed: ${this.downloads.queueError}` });
      const reason = this.downloads.pauseReason();
      if (reason) messages.unshift({ level: reason.startsWith('PP guard') ? 'info' : 'warn', text: `Paused — ${reason}` });
      this.set({
        id: 'sabnzbd',
        name: 'SABnzbd',
        status: messages.some((m) => m.level === 'error') ? 'error' : reason && !reason.startsWith('PP guard') ? 'warn' : 'ok',
        version: ver.version,
        summary: `${this.downloads.queue?.noofslots_total ?? '?'} jobs queued${reason ? ` · paused: ${reason.split(/[(:]/)[0]!.trim()}` : ''}`,
        messages,
      });
    } catch (err) {
      const d = this.describe(err);
      this.set({ id: 'sabnzbd', name: 'SABnzbd', status: d.status, summary: d.text, messages: [{ level: 'error', text: d.text }] });
    }
  }

  /** Two checks: the local server accepts the token, and plex.tv still considers it valid (the failure Seerr hit for two weeks). */
  private async checkPlex() {
    const plex = this.stack.plex!;
    const messages: HealthItem['messages'] = [];
    let status: HealthItem['status'] = 'ok';
    let version: string | undefined;
    try {
      const id = await plex.identity();
      version = id.MediaContainer.version;
      const sections = await plex.sections();
      messages.push({ level: 'info', text: `Libraries: ${sections.map((s) => s.title).join(', ')}` });
    } catch (err) {
      const d = this.describe(err);
      status = 'error';
      messages.push({ level: 'error', text: d.text });
    }
    if (Date.now() - this.lastPlexTv > 30 * 60_000) {
      this.lastPlexTv = Date.now();
      this.plexTv = await plex.accountTokenValid();
    }
    if (this.plexTv && !this.plexTv.valid) {
      status = 'error';
      messages.unshift({ level: 'error', text: `Plex token rejected by plex.tv: ${this.plexTv.detail}. Replace PLEX_TOKEN.` });
    } else if (this.plexTv?.detail) messages.push({ level: 'warn', text: this.plexTv.detail });
    this.set({
      id: 'plex',
      name: 'Plex',
      status,
      version,
      summary: status === 'ok' ? `Token valid${this.plexTv?.username ? ` (${this.plexTv.username})` : ''}` : (messages[0]?.text ?? 'Error'),
      messages,
    });
  }

  private async checkGuardAndStorage() {
    if (!this.stack.feedHost) return;
    const g = this.downloads.guardState();
    const messages: HealthItem['messages'] = [];
    let status: HealthItem['status'] = 'ok';
    if (this.downloads.feedError) {
      status = 'error';
      messages.push({ level: 'error', text: this.downloads.feedError });
    } else if (g.available) {
      if (!g.fresh) {
        status = 'error';
        messages.push({ level: 'error', text: `PP guard heartbeat is ${g.heartbeatAgeSec ?? '?'} s old — the guard cron may have stopped` });
      }
      messages.push({ level: 'info', text: g.paused ? `Guard has paused downloads since ${new Date((g.pausedSince ?? 0) * 1000).toLocaleTimeString()}` : 'Guard is not pausing' });
      for (const d of this.downloads.feed?.disks ?? []) {
        const pct = d.size ? d.used / d.size : 0;
        if (pct > CACHE_POOL_WARN) {
          if (status === 'ok') status = 'warn';
          messages.push({ level: 'warn', text: `${d.mount} is ${(pct * 100).toFixed(0)}% full` });
        } else messages.push({ level: 'info', text: `${d.mount}: ${(d.avail / 1024 ** 4).toFixed(1)} TB free (${(pct * 100).toFixed(0)}% used)` });
      }
    }
    this.set({ id: 'host-feed', name: 'Download host feed', status: g.available || this.downloads.feedError ? status : 'unknown', summary: messages[0]?.text ?? 'No feed yet', messages });
  }

  private async checkAgent() {
    try {
      this.agent = await this.stack.feedAgent!.fetch<AgentFeed>();
      this.agentError = null;
      const messages: HealthItem['messages'] = [];
      if (!this.agent.cronEnabled) messages.push({ level: 'warn', text: 'Maintenance agent schedule is paused' });
      const lastDetect = this.agent.detectLogTail[this.agent.detectLogTail.length - 1];
      if (lastDetect) messages.push({ level: 'info', text: lastDetect.slice(0, 300) });
      this.set({
        id: 'agent',
        name: 'Maintenance agent',
        status: this.agent.cronEnabled ? 'ok' : 'warn',
        summary: this.agent.running ? 'Running a repair session now' : `Idle; journal ${this.agent.journalDate}`,
        messages,
      });
    } catch (err) {
      this.agentError = err instanceof Error ? err.message : String(err);
      this.set({ id: 'agent', name: 'Maintenance agent', status: 'unknown', summary: this.agentError, messages: [] });
    }
  }
}
