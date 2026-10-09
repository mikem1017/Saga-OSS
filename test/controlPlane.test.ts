import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '../src/server/db.ts';
import { ControlPlane } from '../src/server/services/controlPlane.ts';
import { SecretBox } from '../src/server/crypto.ts';
import type { Stack } from '../src/server/stack.ts';

function fakeSab(servers: Record<string, any>[]) {
  const calls: { keyword: string; values: Record<string, string | number> }[] = [];
  return {
    calls,
    getConfig: async () => ({ servers: structuredClone(servers) }),
    serverStats: async () => ({ total: 0, month: 0, week: 0, day: 0, servers: {} }),
    setServer: async (keyword: string, values: Record<string, string | number>) => {
      calls.push({ keyword, values });
      const s = servers.find((x) => x.name === keyword);
      const mapped = { ...values, enable: values.enable, retention: values.retention };
      if (s) Object.assign(s, mapped);
      else servers.push({ ...mapped, name: keyword });
      return { status: true };
    },
  };
}

const live = { name: 'news.example.com', displayname: 'Example', host: 'news.example.com', port: 563, ssl: 1, connections: 50, priority: 0, retention: 0, enable: 1, optional: 0, username: 'me', password: '**********' };

function setup() {
  const db = openMemoryDb();
  const sab = fakeSab([{ ...live }]);
  const stack = { db, sab, config: {} } as unknown as Stack;
  const box = new SecretBox('k'.repeat(44));
  return { db, sab, cp: new ControlPlane(stack, box), box };
}

describe('control plane push', () => {
  it('imports without the masked password, and a no-op push changes nothing but still snapshots', async () => {
    const { cp, sab, db } = setup();
    await cp.importLive('admin');
    const [p] = (await cp.providers()).providers;
    expect(p!.hasPassword).toBe(false);
    expect(p!.drift).toEqual([]);
    const res = await cp.pushProvider(p!.id, 'admin');
    expect(res.applied).toEqual([]);
    expect(sab.calls).toHaveLength(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM config_snapshots').get() as { n: number }).n).toBe(1);
  });

  it('pushes only Saga-recorded values; the password only when Saga holds one', async () => {
    const { cp, sab } = setup();
    await cp.importLive('admin');
    const [p] = (await cp.providers()).providers;
    cp.updateProvider(p!.id, { connections: 30 }, 'admin');
    expect((await cp.providerPlan(p!.id)).changes).toEqual([{ field: 'connections', saga: 30, live: 50 }]);
    const res = await cp.pushProvider(p!.id, 'admin');
    expect(res.ok).toBe(true);
    expect(sab.calls[0]!.values.connections).toBe(30);
    expect('password' in sab.calls[0]!.values).toBe(false);
    cp.updateProvider(p!.id, { password: 's3cret' }, 'admin');
    await cp.pushProvider(p!.id, 'admin');
    expect(sab.calls[1]!.values.password).toBe('s3cret');
  });

  it('creates a new server in SAB from a Saga record', async () => {
    const { cp, sab } = setup();
    const id = cp.createProvider({ displayName: 'Backup', host: 'news.backup.test', port: 563, ssl: true, connections: 10, priority: 2, username: 'u', password: 'p' }, 'admin');
    const plan = await cp.providerPlan(id);
    expect(plan.creates).toBe(true);
    await cp.pushProvider(id, 'admin');
    expect(sab.calls[0]).toMatchObject({ keyword: 'news.backup.test', values: { host: 'news.backup.test', connections: 10, password: 'p' } });
  });

  it('never returns secrets from the provider list', async () => {
    const { cp } = setup();
    const id = cp.createProvider({ displayName: 'B', host: 'h.test', port: 563, ssl: true, connections: 1, priority: 0, password: 'topsecret' }, 'admin');
    const json = JSON.stringify(await cp.providers());
    expect(json).not.toContain('topsecret');
    expect((await cp.providers()).providers.find((p) => p.id === id)!.hasPassword).toBe(true);
  });
});
