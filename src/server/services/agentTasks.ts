import type { Stack } from '../stack.ts';
import { OpsRefused, type AgentTask, type AgentTaskKind } from '../connectors/feeds.ts';
import { getSetting, setSetting } from '../db.ts';
import { AGENT_TASKS, ProblemError, type ProblemsService } from './problems.ts';
import { audit } from './audit.ts';

export class AgentTaskError extends Error {}

/**
 * "Ask the agent" from Saga: hands one problem to an unattended maintenance agent on the agent host through its
 * saga-agent-task forced command. Owner-approved 2026-10-09, knowing agent runs execute without permission prompts.
 * The task is structured data built here from Saga's own records (never free text from the browser); the remote side
 * bounds every field, allows one task at a time and 10 a day, and the agent keeps its usual guardrails.
 */
export class AgentTasks {
  constructor(
    private readonly stack: Stack,
    private readonly problems: ProblemsService,
  ) {}

  private client() {
    if (!this.stack.opsAgent) throw new AgentTaskError('The agent hand-off is not configured (OPS_AGENT_HOST)');
    return this.stack.opsAgent;
  }

  private remember(key: string, taskId: string) {
    const m = getSetting<Record<string, string>>(this.stack.db, AGENT_TASKS, {});
    m[key] = taskId;
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete m[k];
    setSetting(this.stack.db, AGENT_TASKS, m);
  }

  private async start(key: string, kind: AgentTaskKind, title: string, summary: string, details: Record<string, unknown>, actor: string) {
    try {
      const { id } = await this.client().start({ kind, title, summary, details, requestedBy: actor });
      this.remember(key, id);
      audit(this.stack.db, actor, 'agent.task', title, `task ${id} (${kind})`);
      return { taskId: id };
    } catch (err) {
      audit(this.stack.db, actor, 'agent.task', title, err instanceof Error ? err.message : String(err), false);
      throw err instanceof OpsRefused ? new AgentTaskError(err.message) : err;
    }
  }

  async forProblem(problemId: string, actor: string) {
    let p;
    try {
      p = await this.problems.get(problemId);
    } catch (err) {
      throw err instanceof ProblemError ? new AgentTaskError(err.message) : err;
    }
    const what = p.kind === 'sab-failed' ? 'SABnzbd failed this download and no *arr is tracking it any more' : `${p.app} has this queue item stuck in "${p.state}"`;
    const summary =
      `${what}. Title: ${p.title} (${p.app}). Find out why it failed and get the title downloaded and imported, ` +
      `following the runbook. Tracked by ${p.app}: ${p.tracked ? 'yes' : 'no'}.`;
    return this.start(
      problemId,
      'download-problem',
      `${p.title}: ${p.state ?? 'problem'}`,
      summary,
      {
        problemId: p.id,
        app: p.app,
        mediaType: p.mediaType,
        release: p.release,
        messages: p.messages,
        tracked: p.tracked,
        sabNzoId: p.nzoId ?? null,
        arrQueueId: p.queueId ?? null,
        movieId: p.movieId ?? null,
        seriesId: p.seriesId ?? null,
        episodeIds: p.episodeIds ?? null,
        tmdbId: p.tmdbId ?? null,
      },
      actor,
    );
  }

  /** A Stack update run that failed or dropped SAB jobs. */
  async forRun(runId: string, actor: string) {
    if (!this.stack.opsStack) throw new AgentTaskError('Stack updates are not configured (OPS_STACK_HOST)');
    const run = await this.stack.opsStack.status(runId);
    const failed = run.steps.filter((s) => s.phase === 'failed');
    if (!failed.length && !run.lostJobs.length) throw new AgentTaskError('That run finished cleanly; nothing for the agent to look at');
    const kind: AgentTaskKind = failed.length ? 'stack-health' : 'lost-jobs';
    const summary = failed.length
      ? `A Saga stack update run (saga-ops run ${run.id}) stopped: ${failed.map((s) => `${s.service}: ${s.message ?? 'failed'}`).join('; ')}. ` +
        `Diagnose and get the app healthy. Rolling back to the previous image is acceptable (old image IDs are in ~/saga-ops/runs/${run.id}.json).`
      : `After a Saga stack update restarted SABnzbd (saga-ops run ${run.id}), ${run.lostJobs.length} part-downloaded job(s) failed to load and dropped out of the queue. ` +
        'Make sure every affected title is being downloaded again through Radarr/Sonarr, and quarantine orphaned folders only once the re-grabs are queued.';
    return this.start(
      `run:${run.id}`,
      kind,
      failed.length ? `Stack update run ${run.id} failed` : `${run.lostJobs.length} SAB jobs lost in run ${run.id}`,
      summary,
      { runId: run.id, failedSteps: failed.map((s) => ({ service: s.service, message: s.message ?? null })), lostJobs: run.lostJobs.slice(0, 50) },
      actor,
    );
  }

  status(taskId: string): Promise<AgentTask> {
    return this.client().status(taskId);
  }

  async list() {
    const r = await this.client().list();
    return { ...r, links: getSetting<Record<string, string>>(this.stack.db, AGENT_TASKS, {}) };
  }
}
