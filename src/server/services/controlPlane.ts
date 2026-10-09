import type { Stack } from '../stack.ts';
import type { SecretBox } from '../crypto.ts';
import { audit } from './audit.ts';

/**
 * Phase 4 (read + diff): Saga records Usenet providers and indexers, imports them from SAB and Prowlarr so
 * nothing is retyped, tracks the business side (renewals, block balances, daily limits), and shows drift
 * between Saga's record and what the apps actually run. Pushing changes back (with a snapshot first) is the
 * next step; nothing here writes to SAB or Prowlarr.
 */

const PROVIDER_FIELDS = ['host', 'port', 'ssl', 'connections', 'priority', 'retention_days', 'enabled', 'optional', 'username'] as const;

interface ProviderRow {
  id: number;
  sab_name: string;
  display_name: string;
  host: string;
  port: number;
  ssl: number;
  connections: number;
  priority: number;
  retention_days: number;
  enabled: number;
  optional: number;
  username: string | null;
  password_enc: string | null;
  plan_type: string;
  renewal_date: string | null;
  price: number | null;
  billing_period: string | null;
  block_size_bytes: number | null;
  block_baseline_bytes: number | null;
  block_baseline_at: number | null;
  data_cap_bytes: number | null;
  notes: string | null;
  imported_at: number;
  updated_at: number;
}

interface IndexerRow {
  id: number;
  prowlarr_id: number | null;
  name: string;
  base_url: string;
  api_key_enc: string | null;
  enabled: number;
  priority: number;
  api_limit_day: number | null;
  grab_limit_day: number | null;
  vip_expiry: string | null;
  renewal_price: number | null;
  notes: string | null;
  imported_at: number;
  updated_at: number;
}

export interface Drift {
  field: string;
  saga: unknown;
  live: unknown;
}

const daysUntil = (date: string | null) => (date ? Math.ceil((new Date(`${date}T00:00:00`).getTime() - Date.now()) / 86400_000) : null);

function liveProvider(s: Record<string, any>) {
  return {
    host: String(s.host),
    port: Number(s.port),
    ssl: Number(s.ssl) ? 1 : 0,
    connections: Number(s.connections),
    priority: Number(s.priority),
    retention_days: Number(s.retention ?? 0),
    enabled: Number(s.enable) ? 1 : 0,
    optional: Number(s.optional) ? 1 : 0,
    username: s.username ? String(s.username) : null,
  };
}

export class ControlPlane {
  constructor(
    private readonly stack: Stack,
    private readonly box: SecretBox,
  ) {}

  /** Copy SAB servers and Prowlarr indexers into Saga. Existing records are left alone unless `overwrite`. */
  async importLive(actor: string, overwrite = false): Promise<{ providers: number; indexers: number }> {
    const { sab, prowlarr, db } = this.stack;
    let providers = 0;
    let indexers = 0;
    const now = Date.now();
    if (sab) {
      const cfg = await sab.getConfig('servers');
      for (const s of (cfg.servers ?? []) as Record<string, any>[]) {
        const exists = db.prepare('SELECT id FROM providers WHERE sab_name = ?').get(s.name);
        if (exists && !overwrite) continue;
        const live = liveProvider(s);
        // SAB's get_config returns the real password; seal it immediately. Saga never sends it to a browser.
        const pw = s.password && !/^\*+$/.test(String(s.password)) ? this.box.seal(String(s.password)) : null;
        db.prepare(
          `INSERT INTO providers (sab_name, display_name, host, port, ssl, connections, priority, retention_days, enabled, optional, username, password_enc, imported_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(sab_name) DO UPDATE SET display_name=excluded.display_name, host=excluded.host, port=excluded.port, ssl=excluded.ssl,
             connections=excluded.connections, priority=excluded.priority, retention_days=excluded.retention_days, enabled=excluded.enabled,
             optional=excluded.optional, username=excluded.username, password_enc=COALESCE(excluded.password_enc, providers.password_enc), updated_at=excluded.updated_at`,
        ).run(s.name, s.displayname || s.name, live.host, live.port, live.ssl, live.connections, live.priority, live.retention_days, live.enabled, live.optional, live.username, pw, now, now);
        providers++;
      }
    }
    if (prowlarr) {
      for (const ix of await prowlarr.indexers()) {
        const exists = db.prepare('SELECT id FROM indexers WHERE prowlarr_id = ?').get(ix.id);
        if (exists && !overwrite) continue;
        const field = (n: string) => ix.fields.find((f) => f.name === n)?.value;
        // Prowlarr masks API keys ("********"), so the key has to be entered once in Saga.
        db.prepare(
          `INSERT INTO indexers (prowlarr_id, name, base_url, enabled, priority, api_limit_day, grab_limit_day, vip_expiry, imported_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(prowlarr_id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, enabled=excluded.enabled, priority=excluded.priority,
             api_limit_day=COALESCE(excluded.api_limit_day, indexers.api_limit_day), grab_limit_day=COALESCE(excluded.grab_limit_day, indexers.grab_limit_day),
             vip_expiry=COALESCE(excluded.vip_expiry, indexers.vip_expiry), updated_at=excluded.updated_at`,
        ).run(
          ix.id,
          ix.name,
          String(field('baseUrl') ?? ''),
          ix.enable ? 1 : 0,
          ix.priority,
          (field('baseSettings.queryLimit') as number | null) ?? null,
          (field('baseSettings.grabLimit') as number | null) ?? null,
          (field('vipExpiration') as string) || null,
          now,
          now,
        );
        indexers++;
      }
    }
    audit(db, actor, 'control.import', null, `${providers} provider(s), ${indexers} indexer(s)${overwrite ? ' (overwrite)' : ''}`);
    return { providers, indexers };
  }

  async providers() {
    const { sab, db } = this.stack;
    const rows = db.prepare('SELECT * FROM providers ORDER BY priority, display_name').all() as unknown as ProviderRow[];
    const [cfg, stats] = sab ? await Promise.all([sab.getConfig('servers').catch(() => null), sab.serverStats().catch(() => null)]) : [null, null];
    const liveByName = new Map<string, Record<string, any>>(((cfg?.servers ?? []) as Record<string, any>[]).map((s) => [s.name, s]));
    const out = rows.map((r) => {
      const live = liveByName.get(r.sab_name);
      const drift: Drift[] = [];
      if (!live) drift.push({ field: 'server', saga: 'present', live: 'missing from SAB' });
      else {
        const l = liveProvider(live);
        for (const f of PROVIDER_FIELDS) if ((r as any)[f] !== (l as any)[f]) drift.push({ field: f, saga: (r as any)[f], live: (l as any)[f] });
        if (r.password_enc && live.password && !/^\*+$/.test(String(live.password)) && this.box.open(r.password_enc) !== String(live.password))
          drift.push({ field: 'password', saga: '(set)', live: '(different)' });
      }
      const usage = stats?.servers[r.sab_name] ?? stats?.servers[r.host];
      const blockUsed = r.block_baseline_bytes !== null && usage ? Math.max(0, usage.total - r.block_baseline_bytes) : null;
      const blockLeft = r.block_size_bytes && blockUsed !== null ? r.block_size_bytes - blockUsed : null;
      const renewIn = daysUntil(r.renewal_date);
      const warnings: string[] = [];
      if (renewIn !== null && renewIn <= 14) warnings.push(renewIn < 0 ? `Renewal date passed ${-renewIn} day(s) ago` : `Renews in ${renewIn} day(s)${r.price ? ` ($${r.price})` : ''}`);
      if (r.plan_type === 'block' && blockLeft !== null && r.block_size_bytes && blockLeft < r.block_size_bytes * 0.1)
        warnings.push(`Block nearly used: ${(blockLeft / 1024 ** 3).toFixed(0)} GB left`);
      if (r.data_cap_bytes && usage && usage.month > r.data_cap_bytes * 0.9) warnings.push('Over 90% of the monthly data cap');
      return {
        id: r.id,
        sabName: r.sab_name,
        displayName: r.display_name,
        host: r.host,
        port: r.port,
        ssl: !!r.ssl,
        connections: r.connections,
        priority: r.priority,
        retentionDays: r.retention_days,
        enabled: !!r.enabled,
        optional: !!r.optional,
        username: r.username,
        hasPassword: !!r.password_enc,
        planType: r.plan_type,
        renewalDate: r.renewal_date,
        renewInDays: renewIn,
        price: r.price,
        billingPeriod: r.billing_period,
        blockSizeBytes: r.block_size_bytes,
        blockUsedBytes: blockUsed,
        blockLeftBytes: blockLeft,
        dataCapBytes: r.data_cap_bytes,
        notes: r.notes,
        usage: usage ? { day: usage.day, week: usage.week, month: usage.month, total: usage.total } : null,
        drift,
        warnings,
        updatedAt: r.updated_at,
      };
    });
    const untracked = [...liveByName.keys()].filter((n) => !rows.some((r) => r.sab_name === n));
    return { providers: out, untrackedInSab: untracked, liveAvailable: !!cfg };
  }

  async indexers() {
    const { prowlarr, db } = this.stack;
    const rows = db.prepare('SELECT * FROM indexers ORDER BY priority, name').all() as unknown as IndexerRow[];
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [live, today, status] = prowlarr
      ? await Promise.all([
          prowlarr.indexers().catch(() => null),
          prowlarr.request<{ indexers: any[] }>('/indexerstats', { query: { startDate: startOfDay.toISOString() } }).catch(() => null),
          prowlarr.indexerStatus().catch(() => []),
        ])
      : [null, null, []];
    const out = rows.map((r) => {
      const l = live?.find((x) => x.id === r.prowlarr_id);
      const field = (n: string) => l?.fields.find((f) => f.name === n)?.value;
      const drift: Drift[] = [];
      if (!l) drift.push({ field: 'indexer', saga: 'present', live: 'missing from Prowlarr' });
      else {
        if (String(field('baseUrl') ?? '') !== r.base_url) drift.push({ field: 'base_url', saga: r.base_url, live: field('baseUrl') });
        if (!!l.enable !== !!r.enabled) drift.push({ field: 'enabled', saga: !!r.enabled, live: l.enable });
        if (l.priority !== r.priority) drift.push({ field: 'priority', saga: r.priority, live: l.priority });
        const ql = (field('baseSettings.queryLimit') as number | null) ?? null;
        const gl = (field('baseSettings.grabLimit') as number | null) ?? null;
        if (r.api_limit_day !== null && ql !== r.api_limit_day) drift.push({ field: 'api_limit_day', saga: r.api_limit_day, live: ql });
        if (r.grab_limit_day !== null && gl !== r.grab_limit_day) drift.push({ field: 'grab_limit_day', saga: r.grab_limit_day, live: gl });
      }
      const t = today?.indexers.find((x) => x.indexerId === r.prowlarr_id);
      const queriesToday = t ? t.numberOfQueries + t.numberOfRssQueries + (t.numberOfAuthQueries ?? 0) : null;
      const grabsToday = t ? t.numberOfGrabs : null;
      const st = status.find((s) => s.indexerId === r.prowlarr_id);
      const warnings: string[] = [];
      if (r.api_limit_day && queriesToday !== null && queriesToday > r.api_limit_day * 0.8) warnings.push(`${queriesToday}/${r.api_limit_day} API hits today`);
      if (r.grab_limit_day && grabsToday !== null && grabsToday > r.grab_limit_day * 0.8) warnings.push(`${grabsToday}/${r.grab_limit_day} grabs today`);
      const vip = daysUntil(r.vip_expiry ? r.vip_expiry.slice(0, 10) : null);
      if (vip !== null && vip <= 30) warnings.push(vip < 0 ? 'VIP expired' : `VIP expires in ${vip} day(s)`);
      if (st?.disabledTill && new Date(st.disabledTill) > new Date()) warnings.push(`Disabled by Prowlarr until ${new Date(st.disabledTill).toLocaleString()}`);
      return {
        id: r.id,
        prowlarrId: r.prowlarr_id,
        name: r.name,
        baseUrl: r.base_url,
        hasApiKey: !!r.api_key_enc,
        enabled: !!r.enabled,
        priority: r.priority,
        apiLimitDay: r.api_limit_day,
        grabLimitDay: r.grab_limit_day,
        vipExpiry: r.vip_expiry,
        vipInDays: vip,
        renewalPrice: r.renewal_price,
        notes: r.notes,
        today: { queries: queriesToday, grabs: grabsToday },
        drift,
        warnings,
        updatedAt: r.updated_at,
      };
    });
    return { indexers: out, liveAvailable: !!live };
  }

  /** Business fields plus desired config. Secrets are write-only: accepted here, never returned. */
  updateProvider(id: number, patch: Record<string, unknown>, actor: string) {
    const { db } = this.stack;
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as unknown as ProviderRow | undefined;
    if (!row) throw new Error('No such provider');
    const map: Record<string, string> = {
      displayName: 'display_name',
      host: 'host',
      port: 'port',
      ssl: 'ssl',
      connections: 'connections',
      priority: 'priority',
      retentionDays: 'retention_days',
      enabled: 'enabled',
      optional: 'optional',
      username: 'username',
      planType: 'plan_type',
      renewalDate: 'renewal_date',
      price: 'price',
      billingPeriod: 'billing_period',
      blockSizeBytes: 'block_size_bytes',
      dataCapBytes: 'data_cap_bytes',
      notes: 'notes',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    const changed: string[] = [];
    for (const [k, col] of Object.entries(map)) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      sets.push(`${col} = ?`);
      vals.push(v ?? null);
      changed.push(k);
    }
    if (typeof patch.password === 'string' && patch.password) {
      sets.push('password_enc = ?');
      vals.push(this.box.seal(patch.password));
      changed.push('password');
    }
    // Recording a block (or a top-up) resets the baseline to SAB's current counter for this server.
    if (patch.resetBlockBaseline === true && typeof patch.currentTotalBytes === 'number') {
      sets.push('block_baseline_bytes = ?', 'block_baseline_at = ?');
      vals.push(patch.currentTotalBytes, Date.now());
      changed.push('block baseline');
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    vals.push(Date.now(), id);
    db.prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]));
    audit(db, actor, 'control.provider.update', row.display_name, `changed: ${changed.join(', ')} (Saga record only; not pushed)`);
  }

  updateIndexer(id: number, patch: Record<string, unknown>, actor: string) {
    const { db } = this.stack;
    const row = db.prepare('SELECT name FROM indexers WHERE id = ?').get(id) as { name: string } | undefined;
    if (!row) throw new Error('No such indexer');
    const map: Record<string, string> = {
      name: 'name',
      baseUrl: 'base_url',
      enabled: 'enabled',
      priority: 'priority',
      apiLimitDay: 'api_limit_day',
      grabLimitDay: 'grab_limit_day',
      vipExpiry: 'vip_expiry',
      renewalPrice: 'renewal_price',
      notes: 'notes',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    const changed: string[] = [];
    for (const [k, col] of Object.entries(map)) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      sets.push(`${col} = ?`);
      vals.push(v ?? null);
      changed.push(k);
    }
    if (typeof patch.apiKey === 'string' && patch.apiKey) {
      sets.push('api_key_enc = ?');
      vals.push(this.box.seal(patch.apiKey));
      changed.push('apiKey');
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    vals.push(Date.now(), id);
    db.prepare(`UPDATE indexers SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]));
    audit(db, actor, 'control.indexer.update', row.name, `changed: ${changed.join(', ')} (Saga record only; not pushed)`);
  }

  // ---------------------------------------------------------------- push (phase 4)

  private snapshot(app: string, target: string, reason: string, payload: unknown, actor: string) {
    this.stack.db
      .prepare('INSERT INTO config_snapshots (ts, app, target, reason, payload_enc, actor) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), app, target, reason, this.box.seal(JSON.stringify(payload)), actor);
  }

  snapshots(limit = 50) {
    return (this.stack.db.prepare('SELECT id, ts, app, target, reason, actor FROM config_snapshots ORDER BY id DESC LIMIT ?').all(limit) as any[]);
  }

  /** The SAB parameters Saga's record says this server should have. Password only if Saga holds one. */
  private sabValues(r: ProviderRow): Record<string, string | number> {
    const v: Record<string, string | number> = {
      name: r.sab_name,
      displayname: r.display_name,
      host: r.host,
      port: r.port,
      ssl: r.ssl,
      connections: r.connections,
      priority: r.priority,
      retention: r.retention_days,
      enable: r.enabled,
      optional: r.optional,
    };
    if (r.username !== null) v.username = r.username;
    if (r.password_enc) v.password = this.box.open(r.password_enc);
    return v;
  }

  /** What a push would change, without changing anything. */
  async providerPlan(id: number) {
    const row = this.stack.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as unknown as ProviderRow | undefined;
    if (!row) throw new Error('No such provider');
    const list = await this.providers();
    const p = list.providers.find((x) => x.id === id)!;
    const creates = p.drift.some((d) => d.field === 'server');
    return { id, name: row.display_name, creates, changes: creates ? [] : p.drift, willSetPassword: !!row.password_enc };
  }

  /**
   * Push Saga's record of one provider to SAB: snapshot SAB's current server config (sealed), set_config,
   * then re-read and report any drift that's left.
   */
  async pushProvider(id: number, actor: string) {
    const sab = this.stack.sab;
    if (!sab) throw new Error('SABnzbd is not configured');
    const row = this.stack.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as unknown as ProviderRow | undefined;
    if (!row) throw new Error('No such provider');
    const plan = await this.providerPlan(id);
    const before = await sab.getConfig('servers');
    this.snapshot('sabnzbd', row.sab_name, plan.creates ? 'before create' : 'before update', before.servers ?? [], actor);
    if (!plan.creates && !plan.changes.length && !plan.willSetPassword) {
      audit(this.stack.db, actor, 'control.provider.push', row.display_name, 'no changes needed');
      return { ok: true, applied: [], remaining: [] };
    }
    await sab.setServer(row.sab_name, this.sabValues(row));
    const after = (await this.providers()).providers.find((x) => x.id === id)!;
    const applied = plan.creates ? ['server created'] : plan.changes.map((c) => c.field);
    audit(this.stack.db, actor, 'control.provider.push', row.display_name, `SAB ${plan.creates ? 'created' : 'updated'}: ${applied.join(', ') || 'password'}${after.drift.length ? `; still differs: ${after.drift.map((d) => d.field).join(', ')}` : ''}`, after.drift.length === 0);
    return { ok: after.drift.length === 0, applied, remaining: after.drift };
  }

  /** New provider in Saga's record (pushed separately, after a preview). */
  createProvider(v: { displayName: string; host: string; port: number; ssl: boolean; connections: number; priority: number; username?: string | null; password?: string; retentionDays?: number }, actor: string) {
    const now = Date.now();
    const res = this.stack.db
      .prepare(
        `INSERT INTO providers (sab_name, display_name, host, port, ssl, connections, priority, retention_days, enabled, optional, username, password_enc, imported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`,
      )
      .run(v.host, v.displayName, v.host, v.port, v.ssl ? 1 : 0, v.connections, v.priority, v.retentionDays ?? 0, v.username ?? null, v.password ? this.box.seal(v.password) : null, now, now);
    audit(this.stack.db, actor, 'control.provider.create', v.displayName, 'Saga record only (push to add it to SAB)');
    return Number(res.lastInsertRowid);
  }

  async indexerPlan(id: number) {
    const row = this.stack.db.prepare('SELECT * FROM indexers WHERE id = ?').get(id) as unknown as IndexerRow | undefined;
    if (!row) throw new Error('No such indexer');
    const ix = (await this.indexers()).indexers.find((x) => x.id === id)!;
    const creates = row.prowlarr_id === null || ix.drift.some((d) => d.field === 'indexer');
    return { id, name: row.name, creates, changes: creates ? [] : ix.drift, willSetApiKey: !!row.api_key_enc };
  }

  /**
   * Push one indexer to Prowlarr (which then syncs it to the *arrs): snapshot the indexer, PUT the changed
   * fields (or POST a new Newznab indexer), re-read. Prowlarr's masked "********" key means "unchanged".
   */
  async pushIndexer(id: number, actor: string) {
    const prowlarr = this.stack.prowlarr;
    if (!prowlarr) throw new Error('Prowlarr is not configured');
    const row = this.stack.db.prepare('SELECT * FROM indexers WHERE id = ?').get(id) as unknown as IndexerRow | undefined;
    if (!row) throw new Error('No such indexer');
    const plan = await this.indexerPlan(id);
    const setField = (fields: { name: string; value?: unknown }[], name: string, value: unknown) => {
      const f = fields.find((x) => x.name === name);
      if (f) f.value = value;
      else fields.push({ name, value });
    };
    if (plan.creates) {
      if (!row.api_key_enc) throw new Error('Enter the indexer API key in Saga first (Prowlarr needs it to add the indexer)');
      const profiles = await prowlarr.request<{ id: number }[]>('/appprofile');
      const fields: { name: string; value?: unknown }[] = [];
      setField(fields, 'baseUrl', row.base_url);
      setField(fields, 'apiPath', '/api');
      setField(fields, 'apiKey', this.box.open(row.api_key_enc));
      setField(fields, 'categories', [2000, 5000, 3000]);
      if (row.api_limit_day !== null) setField(fields, 'baseSettings.queryLimit', row.api_limit_day);
      if (row.grab_limit_day !== null) setField(fields, 'baseSettings.grabLimit', row.grab_limit_day);
      if (row.vip_expiry) setField(fields, 'vipExpiration', row.vip_expiry);
      const created = await prowlarr.request<{ id: number }>('/indexer', {
        method: 'POST',
        body: { name: row.name, implementation: 'Newznab', configContract: 'NewznabSettings', protocol: 'usenet', appProfileId: profiles[0]?.id ?? 1, enable: !!row.enabled, redirect: true, priority: row.priority, tags: [], fields },
      });
      this.stack.db.prepare('UPDATE indexers SET prowlarr_id = ?, updated_at = ? WHERE id = ?').run(created.id, Date.now(), id);
      audit(this.stack.db, actor, 'control.indexer.push', row.name, `Prowlarr created indexer ${created.id}`);
      return { ok: true, applied: ['indexer created'], remaining: [] };
    }
    const live = await prowlarr.request<{ id: number; enable: boolean; priority: number; fields: { name: string; value?: unknown }[] } & Record<string, unknown>>(`/indexer/${row.prowlarr_id}`);
    this.snapshot('prowlarr', String(row.prowlarr_id), 'before update', live, actor);
    if (!plan.changes.length && !plan.willSetApiKey) {
      audit(this.stack.db, actor, 'control.indexer.push', row.name, 'no changes needed');
      return { ok: true, applied: [], remaining: [] };
    }
    const next = structuredClone(live);
    next.enable = !!row.enabled;
    next.priority = row.priority;
    setField(next.fields, 'baseUrl', row.base_url);
    if (row.api_limit_day !== null) setField(next.fields, 'baseSettings.queryLimit', row.api_limit_day);
    if (row.grab_limit_day !== null) setField(next.fields, 'baseSettings.grabLimit', row.grab_limit_day);
    if (row.vip_expiry) setField(next.fields, 'vipExpiration', row.vip_expiry);
    if (row.api_key_enc) setField(next.fields, 'apiKey', this.box.open(row.api_key_enc));
    await prowlarr.request(`/indexer/${row.prowlarr_id}`, { method: 'PUT', body: next });
    const after = (await this.indexers()).indexers.find((x) => x.id === id)!;
    const applied = [...plan.changes.map((c) => c.field), ...(plan.willSetApiKey ? ['apiKey'] : [])];
    audit(this.stack.db, actor, 'control.indexer.push', row.name, `Prowlarr updated: ${applied.join(', ')}${after.drift.length ? `; still differs: ${after.drift.map((d) => d.field).join(', ')}` : ''}`, after.drift.length === 0);
    return { ok: after.drift.length === 0, applied, remaining: after.drift };
  }

  createIndexer(v: { name: string; baseUrl: string; apiKey: string; priority?: number; apiLimitDay?: number | null; grabLimitDay?: number | null }, actor: string) {
    const now = Date.now();
    const res = this.stack.db
      .prepare('INSERT INTO indexers (prowlarr_id, name, base_url, api_key_enc, enabled, priority, api_limit_day, grab_limit_day, imported_at, updated_at) VALUES (NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?)')
      .run(v.name, v.baseUrl, this.box.seal(v.apiKey), v.priority ?? 25, v.apiLimitDay ?? null, v.grabLimitDay ?? null, now, now);
    audit(this.stack.db, actor, 'control.indexer.create', v.name, 'Saga record only (push to add it to Prowlarr)');
    return Number(res.lastInsertRowid);
  }

  /** Everything, secrets decrypted, for a passphrase-encrypted backup. */
  exportPlain(): string {
    const { db } = this.stack;
    const providers = (db.prepare('SELECT * FROM providers').all() as unknown as ProviderRow[]).map(({ password_enc, ...r }) => ({
      ...r,
      password: password_enc ? this.box.open(password_enc) : null,
    }));
    const indexers = (db.prepare('SELECT * FROM indexers').all() as unknown as IndexerRow[]).map(({ api_key_enc, ...r }) => ({
      ...r,
      apiKey: api_key_enc ? this.box.open(api_key_enc) : null,
    }));
    return JSON.stringify({ exportedAt: new Date().toISOString(), providers, indexers });
  }
}
