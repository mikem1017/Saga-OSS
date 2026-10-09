import type { Stack } from '../stack.ts';
import type { DownloadsService } from './downloads.ts';
import { SAB_PRIORITY } from '../connectors/sab.ts';
import { audit } from './audit.ts';

export class ControlError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/**
 * Admin queue actions. Two rules learned the hard way are enforced here, not in the UI:
 *  1. Never resume a pause the PP guard made (it resumes itself once post-processing drains).
 *  2. Never use SAB's Force priority — Force downloads even while SAB is paused, which defeats the guard.
 */
export class QueueControl {
  constructor(
    private readonly stack: Stack,
    private readonly downloads: DownloadsService,
  ) {}

  private sab() {
    if (!this.stack.sab) throw new ControlError('SABnzbd is not configured', 503);
    return this.stack.sab;
  }

  private slot(nzoId: string) {
    const slot = this.downloads.queue?.slots.find((s) => s.nzo_id === nzoId);
    if (!slot) throw new ControlError('That job is no longer in the queue', 404);
    return slot;
  }

  private async after() {
    await this.downloads.pollQueue();
  }

  /** Top of the High band: the fastest a job can go without Force. */
  async bump(nzoId: string, actor: string) {
    const slot = this.slot(nzoId);
    const sab = this.sab();
    if (slot.priority !== 'High' && slot.priority !== 'Force') await sab.setPriority(nzoId, SAB_PRIORITY.High);
    await sab.switchPosition(nzoId, 0);
    audit(this.stack.db, actor, 'queue.bump', slot.filename, `from #${slot.index + 1} (${slot.priority})`);
    await this.after();
  }

  async setPriority(nzoId: string, priority: keyof typeof SAB_PRIORITY, actor: string) {
    if (!(priority in SAB_PRIORITY)) throw new ControlError('Priority must be Low, Normal or High (Force is never used)', 400);
    const slot = this.slot(nzoId);
    await this.sab().setPriority(nzoId, SAB_PRIORITY[priority]);
    audit(this.stack.db, actor, 'queue.priority', slot.filename, `${slot.priority} → ${priority}`);
    await this.after();
  }

  async move(nzoId: string, index: number, actor: string) {
    const slot = this.slot(nzoId);
    if (!Number.isInteger(index) || index < 0) throw new ControlError('Bad position', 400);
    const res = await this.sab().switchPosition(nzoId, index);
    audit(this.stack.db, actor, 'queue.move', slot.filename, `#${slot.index + 1} → #${(res?.result?.position ?? index) + 1}`);
    await this.after();
  }

  async pauseJob(nzoId: string, actor: string) {
    const slot = this.slot(nzoId);
    await this.sab().pauseJob(nzoId);
    audit(this.stack.db, actor, 'queue.pause-job', slot.filename);
    await this.after();
  }

  async resumeJob(nzoId: string, actor: string) {
    const slot = this.slot(nzoId);
    await this.sab().resumeJob(nzoId);
    audit(this.stack.db, actor, 'queue.resume-job', slot.filename);
    await this.after();
  }

  /**
   * Cancel through the *arr when it tracks the job (so it isn't treated as a failure and re-grabbed);
   * otherwise delete from SAB directly.
   */
  async cancel(nzoId: string, opts: { blocklist: boolean }, actor: string) {
    const slot = this.slot(nzoId);
    const link = this.downloads.linkFor(nzoId);
    if (link) {
      const client = link.app === 'radarr' ? this.stack.radarr : this.stack.sonarr;
      if (!client) throw new ControlError(`${link.app} is not configured`, 503);
      await client.removeQueueItem(link.queueId, { removeFromClient: true, blocklist: opts.blocklist, skipRedownload: !opts.blocklist });
      audit(this.stack.db, actor, 'queue.cancel', slot.filename, `via ${link.app}${opts.blocklist ? ' (blocklisted, will search again)' : ' (no re-download)'}`);
    } else {
      await this.sab().deleteJob(nzoId);
      audit(this.stack.db, actor, 'queue.cancel', slot.filename, 'via SAB (not tracked by an *arr)');
    }
    await this.after();
  }

  /**
   * Always a timed pause. A maintenance agent may treat an open-ended pause with nothing post-processing as
   * "stuck" (sab.paused_idle) and would resume it; a timed pause is bounded and SAB lifts it by itself.
   */
  async pauseAll(minutes: number, actor: string) {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) throw new ControlError('Pause for 1 minute to 24 hours', 400);
    await this.sab().pauseFor(minutes);
    audit(this.stack.db, actor, 'sab.pause', null, `for ${minutes} min`);
    await this.after();
  }

  async resumeAll(actor: string) {
    await this.downloads.pollFeed();
    const guard = this.downloads.guardState();
    if (guard.paused) throw new ControlError('The PP guard paused SAB because post-processing is backed up. It resumes on its own; Saga will not override it.');
    if (!guard.available && this.stack.feedHost)
      throw new ControlError("Can't read the PP guard's state right now, so Saga won't resume (it might be the guard's pause).", 503);
    const reason = this.downloads.pauseReason();
    await this.sab().resume();
    audit(this.stack.db, actor, 'sab.resume', null, reason ?? undefined);
    await this.after();
  }
}
