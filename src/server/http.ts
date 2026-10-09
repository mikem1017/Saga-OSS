/** Errors from an upstream app, with enough context to show on the dashboard without leaking keys. */
export class UpstreamError extends Error {
  constructor(
    readonly app: string,
    readonly status: number | null,
    message: string,
  ) {
    super(`${app}: ${message}`);
  }
  get authFailed(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/** JSON fetch with a timeout. Query values that are undefined are dropped. Never puts secrets in error text. */
export async function requestJson<T>(app: string, baseUrl: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (err) {
    const reason = err instanceof Error ? (err.name === 'TimeoutError' ? 'timed out' : err.message) : String(err);
    throw new UpstreamError(app, null, `unreachable (${reason})`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j.message ?? j.error ?? j.status_message ?? (Array.isArray(j) ? j.map((e: any) => e.errorMessage ?? e).join('; ') : detail);
    } catch {
      /* not JSON */
    }
    throw new UpstreamError(app, res.status, `HTTP ${res.status} ${String(detail).slice(0, 300)}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(app, res.status, 'returned non-JSON');
  }
}

export async function requestText(app: string, url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Saga/1.0)', 'accept-language': 'en-US,en;q=0.9', ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      redirect: 'follow',
    });
  } catch (err) {
    throw new UpstreamError(app, null, `unreachable (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) throw new UpstreamError(app, res.status, `HTTP ${res.status}`);
  return res.text();
}
