import type { Me } from '../shared/types.ts';

let csrf: string | null = null;
let onUnauthorized: (() => void) | null = null;
let onError: ((msg: string) => void) | null = null;

export function setCsrf(token: string | null) {
  csrf = token;
}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}
export function setErrorHandler(fn: (msg: string) => void) {
  onError = fn;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

interface Opts {
  method?: string;
  body?: unknown;
  /** Don't show a toast for errors (caller handles them). */
  quiet?: boolean;
}

export async function api<T>(path: string, opts: Opts = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    const msg = 'Network error: Saga is unreachable';
    if (!opts.quiet) onError?.(msg);
    throw new ApiError(msg, 0);
  }
  const text = await res.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    onUnauthorized?.();
    throw new ApiError('Not signed in', 401, data);
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.error as string)) || `Request failed (${res.status})`;
    const full = data?.issues ? `${msg}: ${data.issues.join('; ')}` : msg;
    if (!opts.quiet) onError?.(full);
    throw new ApiError(full, res.status, data);
  }
  return data as T;
}

export const get = <T>(path: string, quiet = false) => api<T>(path, { quiet });
export const post = <T>(path: string, body?: unknown, quiet = false) => api<T>(path, { method: 'POST', body: body ?? {}, quiet });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body: body ?? {} });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export async function fetchMe(): Promise<Me | null> {
  try {
    const me = await api<Me>('/auth/me', { quiet: true });
    setCsrf(me.csrf);
    return me;
  } catch {
    return null;
  }
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });

/** POST that returns a file; saves it via an object URL. */
export async function downloadPost(path: string, body: unknown, fallbackName: string): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError('Not signed in', 401);
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = await res.json();
      msg = j.error ? (j.issues ? `${j.error}: ${j.issues.join('; ')}` : j.error) : msg;
    } catch {
      /* not JSON */
    }
    onError?.(msg);
    throw new ApiError(msg, res.status);
  }
  const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
