import webpush from 'web-push';
import type { DB } from '../db.ts';
import type { Config } from '../config.ts';
import { log } from '../log.ts';

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Message {
  kind: string;
  title: string;
  body?: string;
  /** Path inside the portal (guests) or the admin app (admin). */
  url?: string;
}

/**
 * In-app notifications always; web push when the person subscribed; email (Resend) for guests who have an
 * address and haven't turned email off. Sending never throws: a failed channel is logged and skipped.
 */
export class Notifier {
  readonly pushEnabled: boolean;
  /** Test hook: every outbound message lands here too. */
  sent: { channel: 'push' | 'email'; to: string; message: Message }[] = [];

  constructor(
    private readonly db: DB,
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.pushEnabled = !!(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);
    if (this.pushEnabled) {
      const from = config.MAIL_FROM.match(/<([^>]+)>/)?.[1] ?? config.MAIL_FROM;
      webpush.setVapidDetails(`mailto:${from}`, config.VAPID_PUBLIC_KEY!, config.VAPID_PRIVATE_KEY!);
    }
  }

  get emailEnabled() {
    return !!this.config.RESEND_API_KEY;
  }

  subscribe(guestId: number | null, sub: PushSubscriptionJson): void {
    this.db
      .prepare(
        'INSERT INTO push_subscriptions (guest_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET guest_id = excluded.guest_id, p256dh = excluded.p256dh, auth = excluded.auth',
      )
      .run(guestId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now());
  }

  unsubscribe(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  async toGuest(guestId: number, m: Message): Promise<void> {
    this.db.prepare('INSERT INTO notifications (guest_id, kind, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(guestId, m.kind, m.title, m.body ?? null, m.url ?? null, Date.now());
    const g = this.db.prepare('SELECT email, notify_email FROM guests WHERE id = ?').get(guestId) as { email: string | null; notify_email: number } | undefined;
    const subs = this.db.prepare('SELECT * FROM push_subscriptions WHERE guest_id = ?').all(guestId) as any[];
    await Promise.all([
      ...subs.map((s) => this.push(s, m, this.config.PORTAL_PUBLIC_URL)),
      g?.email && g.notify_email ? this.email(g.email, m) : Promise.resolve(),
    ]);
  }

  async toAdmin(m: Message): Promise<void> {
    this.db.prepare('INSERT INTO notifications (guest_id, kind, title, body, url, created_at) VALUES (NULL, ?, ?, ?, ?, ?)').run(m.kind, m.title, m.body ?? null, m.url ?? null, Date.now());
    const subs = this.db.prepare('SELECT * FROM push_subscriptions WHERE guest_id IS NULL').all() as any[];
    await Promise.all(subs.map((s) => this.push(s, m, this.config.PUBLIC_URL)));
  }

  private async push(sub: any, m: Message, base: string): Promise<void> {
    this.sent.push({ channel: 'push', to: sub.endpoint, message: m });
    if (!this.pushEnabled) return;
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: m.title, body: m.body ?? '', url: m.url ? new URL(m.url, base).toString() : base, tag: m.kind }),
        { TTL: 24 * 3600 },
      );
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) this.unsubscribe(sub.endpoint);
      else log.warn(`push failed: ${err?.statusCode ?? ''} ${err?.message ?? err}`);
    }
  }

  async email(to: string, m: Message): Promise<void> {
    this.sent.push({ channel: 'email', to, message: m });
    if (!this.config.RESEND_API_KEY) return;
    const link = m.url ? new URL(m.url, this.config.PORTAL_PUBLIC_URL).toString() : this.config.PORTAL_PUBLIC_URL;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const html = `<div style="font-family:system-ui,sans-serif;max-width:480px">
      <h2 style="margin:0 0 8px">${esc(m.title)}</h2>
      ${m.body ? `<p style="color:#444">${esc(m.body)}</p>` : ''}
      <p><a href="${esc(link)}" style="display:inline-block;background:#f59e0b;color:#111;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open Saga Requests</a></p>
      <p style="color:#888;font-size:12px">You can turn these emails off in Saga Requests → Settings.</p></div>`;
    try {
      const res = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: this.config.MAIL_FROM, to: [to], subject: m.title, html, text: `${m.title}\n\n${m.body ?? ''}\n\n${link}` }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) log.warn(`email to guest failed: HTTP ${res.status}`);
    } catch (err) {
      log.warn(`email failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
