import type { DB } from '../db.ts';
import type { ActivityEntry } from '../../shared/types.ts';

/** Every action Saga takes against another system goes through here. */
export function audit(db: DB, actor: string, action: string, target: string | null, detail: string | null = null, ok = true): void {
  db.prepare('INSERT INTO audit_log (ts, actor, action, target, detail, ok) VALUES (?, ?, ?, ?, ?, ?)').run(
    Date.now(),
    actor,
    action,
    target,
    detail ? detail.slice(0, 2000) : null,
    ok ? 1 : 0,
  );
}

export function recentActivity(db: DB, limit = 200, before?: number): ActivityEntry[] {
  const rows = db
    .prepare('SELECT id, ts, actor, action, target, detail, ok FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?')
    .all(before ?? Number.MAX_SAFE_INTEGER, limit) as any[];
  return rows.map((r) => ({ ...r, ok: !!r.ok }));
}
