// Admin CLI, run inside the container:
//   docker compose exec saga node_modules/.bin/tsx src/server/cli.ts reset-password <user>
//   docker compose exec saga node_modules/.bin/tsx src/server/cli.ts create-admin <user>
//   docker compose exec saga node_modules/.bin/tsx src/server/cli.ts delete-user <user>
//   docker compose exec saga node_modules/.bin/tsx src/server/cli.ts list-users
//   docker compose exec saga node_modules/.bin/tsx src/server/cli.ts guest-session <name> [kid]   (test/support: prints a portal session token)
//   docker compose exec saga node_modules/.bin/tsx src/server/cli.ts delete-guest <name>
// New passwords are random and printed once.
import { randomBytes } from 'node:crypto';
import { openDb } from './db.ts';
import { hashPassword } from './auth.ts';
import { createGuestSession } from './portal/guests.ts';

const [cmd, user] = process.argv.slice(2);
const db = openDb(process.env.DATA_DIR ?? './data');
const newPassword = () => randomBytes(18).toString('base64url');

switch (cmd) {
  case 'list-users':
    for (const u of db.prepare('SELECT username, role, created_at FROM users').all() as any[]) console.log(`${u.username}\t${u.role}\t${new Date(u.created_at).toISOString()}`);
    break;
  case 'create-admin': {
    if (!user) throw new Error('usage: create-admin <user>');
    const pw = newPassword();
    db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(user, hashPassword(pw), 'admin', Date.now());
    console.log(pw);
    break;
  }
  case 'reset-password': {
    if (!user) throw new Error('usage: reset-password <user>');
    const pw = newPassword();
    const res = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hashPassword(pw), user);
    if (!res.changes) throw new Error(`no user ${user}`);
    db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(user);
    console.log(pw);
    break;
  }
  case 'delete-user': {
    const res = db.prepare('DELETE FROM users WHERE username = ?').run(user ?? '');
    console.log(res.changes ? `deleted ${user}` : `no user ${user}`);
    break;
  }
  case 'guest-session': {
    // A portal session for a named guest (created if missing, never linked to Plex). For testing the portal
    // as a guest, or seeing what a guest sees; delete it afterwards with delete-guest.
    if (!user) throw new Error('usage: guest-session <name> [kid]');
    let row = db.prepare('SELECT id FROM guests WHERE username = ? AND plex_id IS NULL').get(user) as { id: number } | undefined;
    if (!row) {
      const now = Date.now();
      const res = db.prepare('INSERT INTO guests (username, role, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run(user, process.argv[4] === 'kid' ? 'kid' : 'guest', now, now);
      row = { id: Number(res.lastInsertRowid) };
    }
    console.log(createGuestSession(db, row.id, 'cli').token);
    break;
  }
  case 'delete-guest': {
    const g = db.prepare('SELECT id FROM guests WHERE username = ? AND plex_id IS NULL').get(user ?? '') as { id: number } | undefined;
    if (!g) {
      console.log(`no unlinked guest ${user}`);
      break;
    }
    for (const t of ['guest_sessions', 'push_subscriptions', 'notifications']) {
      try {
        db.prepare(`DELETE FROM ${t} WHERE guest_id = ?`).run(g.id);
      } catch {
        /* table may not exist */
      }
    }
    db.prepare('DELETE FROM guests WHERE id = ?').run(g.id);
    console.log(`deleted guest ${user}`);
    break;
  }
  default:
    console.error('commands: list-users | create-admin <user> | reset-password <user> | delete-user <user> | guest-session <name> [kid] | delete-guest <name>');
    process.exit(1);
}
db.close();
