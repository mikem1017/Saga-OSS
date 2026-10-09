import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Read-only status feeds over SSH. Each target's authorized_keys entry pins Saga's key to a single
 * forced command (a status script on the download host, another on the agent host) that prints one JSON
 * object, so this key can't run anything else.
 */
export interface HostFeed {
  ts: number;
  guard: { paused: boolean; pausedSince: number | null; heartbeat: number | null; logTail: string[] };
  cleanup: { logTail: string[] };
  agentGate: { logTail: string[] };
  disks: { mount: string; size: number; used: number; avail: number }[];
  /** Folders in SAB's complete/ older than 24 h (the feed may cache this). Optional. */
  leftovers?: { name: string; category: string; size: number; mtime: number }[];
}

export interface AgentFeed {
  ts: number;
  journalDate: string;
  journal: string;
  detectLogTail: string[];
  running: boolean;
  cronEnabled: boolean;
  lastCommits: string[];
}

export class FeedClient {
  constructor(
    private readonly target: string,
    private readonly keyPath: string,
    private readonly knownHosts: string,
  ) {}

  get configured() {
    return existsSync(this.keyPath);
  }

  fetch<T>(): Promise<T> {
    return this.run<T>([], 20_000);
  }

  /**
   * Run the target's forced command with arguments (they arrive as SSH_ORIGINAL_COMMAND; the remote script
   * validates them). Only callers with fixed verbs and validated values use this.
   */
  protected run<T>(args: string[], timeoutMs: number, stdin?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'ssh',
        [
          '-i', this.keyPath,
          '-o', 'BatchMode=yes',
          '-o', 'ConnectTimeout=8',
          '-o', `UserKnownHostsFile=${this.knownHosts}`,
          '-o', 'StrictHostKeyChecking=yes',
          '-o', 'LogLevel=ERROR',
          this.target,
          ...args,
        ],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          // The ops scripts print {"error": ...} and exit 2 on refusal; surface that message.
          try {
            const parsed = JSON.parse(stdout) as T & { error?: string };
            if (parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error) return reject(new OpsRefused(parsed.error));
            if (!err) return resolve(parsed);
          } catch {
            /* fall through */
          }
          reject(new Error(`${this.target}: ${(stderr || err?.message || 'output was not JSON').trim().slice(0, 200)}`));
        },
      );
      child.stdin?.end(stdin ?? '');
    });
  }
}

/** The remote script refused the request (bad state or bad input); safe to show to the admin. */
export class OpsRefused extends Error {}

const SERVICE = /^[a-z0-9_-]+$/;
const RUN_ID = /^\d{8}-\d{6}$/;

export interface StackService {
  service: string;
  image: string;
  state: string;
  runningVersion: string | null;
  pulledVersion: string | null;
  remoteVersion: string | null;
  remoteError: string | null;
  checkedAt: number;
  updateAvailable: boolean;
  restartNeeded: boolean;
}

export interface StackPreflight {
  ppPending: number | null;
  guardPaused: boolean;
  runActive: boolean;
}

export interface StackRunStep {
  service: string;
  phase: 'waiting' | 'pulling' | 'restarting' | 'done' | 'current' | 'failed' | 'skipped';
  ok?: boolean;
  message?: string;
  oldImage?: string;
  newImage?: string;
  oldVersion?: string | null;
  newVersion?: string | null;
}

export interface StackRun {
  id: string;
  services: string[];
  status: 'queued' | 'running' | 'done' | 'failed';
  started: number;
  finished: number | null;
  steps: StackRunStep[];
  lostJobs: string[];
  rollback: { at: number; results: { service: string; ok: boolean; message: string }[] } | null;
  log: string[];
}

export type AgentTaskKind = 'download-problem' | 'lost-jobs' | 'stack-health';

export interface AgentTask {
  id: string;
  state: 'queued' | 'waiting' | 'running' | 'done' | 'failed' | 'refused';
  title?: string;
  kind?: AgentTaskKind;
  created?: number;
  started?: number;
  ended?: number;
  rc?: number;
  summary?: string | null;
  note?: string;
  progress?: string[];
}

const TASK_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

/**
 * The agent host's saga-agent-task: start a maintenance-agent run on one problem and watch it. The task is
 * structured data (kind, title, summary, details); the remote script bounds every field and allows one at a time.
 */
export class AgentTaskClient extends FeedClient {
  start(task: { kind: AgentTaskKind; title: string; summary: string; details: Record<string, unknown>; requestedBy: string }) {
    return this.run<{ id: string }>(['start'], 60_000, JSON.stringify(task));
  }

  status(id: string) {
    if (!TASK_ID.test(id)) throw new OpsRefused('bad task id');
    return this.run<AgentTask>(['status', id], 30_000);
  }

  list() {
    return this.run<{ tasks: AgentTask[]; active: AgentTask | null }>(['list'], 30_000);
  }
}

/** The download host's saga-ops: stack versions, updates, rollback. Every verb and value is validated here and again remotely. */
export class OpsClient extends FeedClient {
  versions(refresh = false) {
    return this.run<{ ts: number; services: StackService[]; preflight: StackPreflight }>(refresh ? ['versions', 'refresh'] : ['versions'], 120_000);
  }

  update(services: string[] | 'all') {
    if (services !== 'all' && (!services.length || !services.every((s) => SERVICE.test(s)))) throw new OpsRefused('bad service name');
    return this.run<{ runId: string; services: string[] }>(['update', services === 'all' ? 'all' : services.join(',')], 120_000);
  }

  status(runId: string) {
    if (!RUN_ID.test(runId)) throw new OpsRefused('bad run id');
    return this.run<StackRun>(['status', runId], 30_000);
  }

  runs() {
    return this.run<{ runs: StackRun[]; preflight: StackPreflight }>(['runs'], 60_000);
  }

  rollback(runId: string, service?: string) {
    if (!RUN_ID.test(runId) || (service && !SERVICE.test(service))) throw new OpsRefused('bad run id or service');
    return this.run<StackRun>(service ? ['rollback', runId, service] : ['rollback', runId], 15 * 60_000);
  }
}
