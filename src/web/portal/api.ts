let csrf: string | null = null;
let onUnauthorized: (() => void) | null = null;
let onError: ((msg: string) => void) | null = null;

export const setCsrf = (t: string | null) => (csrf = t);
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);
export const setErrorHandler = (fn: (msg: string) => void) => (onError = fn);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; quiet?: boolean } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  let res: Response;
  try {
    res = await fetch(`/api/portal${path}`, { method, headers, credentials: 'same-origin', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    const msg = "Can't reach Saga right now. Check your connection.";
    if (!opts.quiet) onError?.(msg);
    throw new ApiError(msg, 0);
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    onUnauthorized?.();
    throw new ApiError('Not signed in', 401);
  }
  if (!res.ok) {
    const msg = (data && data.error) || `Something went wrong (${res.status})`;
    if (!opts.quiet) onError?.(msg);
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const get = <T>(path: string, quiet = false) => api<T>(path, { quiet });
export const post = <T>(path: string, body: unknown = {}, quiet = false) => api<T>(path, { method: 'POST', body, quiet });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
