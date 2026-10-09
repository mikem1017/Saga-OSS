# Optional SSH integrations

Saga talks to your apps over their HTTP APIs. A few features need more than an API gives you: the host's disks, a
post-processing guard, container updates, an agent. Those use SSH **forced commands**: each target's
`~/.ssh/authorized_keys` pins one of Saga's keys to a single script, so the key can't do anything else.

Keys live in `/opt/saga/ssh/` on the Saga host (mounted read-only at `/ssh` in the container), together with a
`known_hosts` file. Strict host-key checking is always on.

```bash
ssh-keygen -t ed25519 -N "" -C saga-feed@saga -f /opt/saga/ssh/id_ed25519     # read-only feeds
ssh-keygen -t ed25519 -N "" -C saga-ops@saga  -f /opt/saga/ssh/ops_ed25519    # actions (stack updates, agent)
ssh-keyscan <download-host> <agent-host> > /opt/saga/ssh/known_hosts
chown -R 1000:1000 /opt/saga/ssh && chmod 600 /opt/saga/ssh/*_ed25519          # the container runs as uid 1000
```

Every `authorized_keys` line should look like
`command="<script>",from="<saga-host-ip>",restrict ssh-ed25519 AAAA... <comment>`.

## 1. Download host status feed (`FEED_HOST`, read-only)

Point `FEED_HOST=user@download-host` at a forced command that prints **one JSON object** with this shape. You write the
script for your setup; every field may be empty.

```jsonc
{
  "ts": 1760000000,                       // unix seconds
  "guard": {                              // a post-processing guard, if you run one (else paused:false, heartbeat:null)
    "paused": false, "pausedSince": null, // true while the guard holds SAB paused; Saga then refuses to resume it
    "heartbeat": 1760000000,              // last time the guard ran; older than 10 min counts as dead
    "logTail": ["..."]
  },
  "cleanup":   { "logTail": ["..."] },    // any cleanup script's log tail (shown on the Dashboard)
  "agentGate": { "logTail": ["..."] },    // your agent's command log, if any
  "disks": [ { "mount": "/mnt/media", "size": 0, "used": 0, "avail": 0 } ],   // bytes; df of your pools (see MEDIA_MOUNT / CACHE_MOUNT)
  "leftovers": [ { "name": "Some.Release", "category": "movies", "size": 0, "mtime": 0 } ]  // optional: complete/ folders older than 24 h
}
```

What Saga does with it:
- the PP-guard-aware pause/resume (it never resumes a pause the guard made);
- the storage tiles and forecast;
- the hygiene report's leftover list;
- Dashboard log tails.

## 2. Maintenance agent status feed (`FEED_AGENT_HOST`, read-only)

If an unattended agent looks after your stack, a forced command can report on it:

```jsonc
{ "ts": 0, "journalDate": "2026-01-31", "journal": "markdown...", "detectLogTail": ["..."],
  "running": false, "cronEnabled": true, "lastCommits": ["abc123 ..."] }
```

## 3. Stack updates (`OPS_STACK_HOST`): `deploy/hosts/download-host/saga-ops`

This powers the **Stack** page: running vs available version per compose service, "update all/selected", per-app
rollback, and re-search of SABnzbd jobs that fail to load after an upgrade.

```bash
sudo install -m 755 -o root -g root deploy/hosts/download-host/saga-ops /usr/local/bin/saga-ops
# in ~/.ssh/authorized_keys of the user that runs docker compose (it must be in the docker group):
command="/usr/local/bin/saga-ops",from="<saga-host-ip>",restrict ssh-ed25519 AAAA... saga-ops@saga
# optional ~/.config/saga-ops.env: COMPOSE_FILE, SAB_CONFIG_DIR, SAB_URL, PP_GUARD_FLAG, SNAPSHOT_CMD, HEALTH_<service>
# test locally:  SSH_ORIGINAL_COMMAND=versions saga-ops
```

How it behaves:
- One service at a time, SABnzbd last. It refuses to touch SAB while it's post-processing or a PP guard holds a pause.
- Each app must answer its health URL within 3 minutes.
- Old image IDs are recorded first, so rollback works until you prune images.
- It needs `docker buildx` to compare remote digests without pulling.
- Saga also refuses to restart Plex while Tautulli reports active streams, unless the admin confirms.

## 4. "Ask the agent" (`OPS_AGENT_HOST`): `deploy/hosts/agent-host/saga-agent-task`

> **Read this first.** This lets Saga's admin UI start runs of your maintenance agent. Unattended agents usually
> execute commands without asking. Enabling it gives anyone who controls Saga's admin surface a path to run things on
> your infrastructure, within whatever your agent allows itself. Only enable it if:
> - the admin UI is private to you;
> - your agent has its own guardrails (a command allowlist or denylist, reversible deletes, config snapshots);
> - you're comfortable with that trade-off.

Saga sends a **structured** task (kind, title, summary, details), built server-side from its own records, never free
text from the browser. The script checks every field, allows three kinds (`download-problem`, `lost-jobs`,
`stack-health`) and one task at a time, then starts your agent as its own user.

```bash
sudo install -m 755 -o root -g root deploy/hosts/agent-host/saga-agent-task /usr/local/bin/saga-agent-task
sudo tee /etc/saga-agent-task.env >/dev/null <<'EOF'
AGENT_DIR=/opt/my-agent
AGENT_USER=agent
AGENT_CMD=./run-agent --task {task}
EOF
# sudoers (validate with visudo -cf first). env_keep is required: sudo's env_reset drops SSH_ORIGINAL_COMMAND.
Defaults!/usr/local/bin/saga-agent-task env_keep += "SSH_ORIGINAL_COMMAND"
<login-user> ALL=(root) NOPASSWD: /usr/local/bin/saga-agent-task
# authorized_keys of <login-user>:
command="sudo -n /usr/local/bin/saga-agent-task",from="<saga-host-ip>",restrict ssh-ed25519 AAAA... saga-ops@saga
```

**Your agent's side of the contract:**
- Read `tasks/<id>.json`, which holds `{id, kind, title, summary, details, requestedBy, created}`.
- Keep `tasks/<id>.status.json` up to date as `{state, started, ended, summary}`, where `state` is one of `waiting`,
  `running`, `done`, `failed` or `refused`.
- For live progress, write a Claude Code `stream-json` transcript named `*-task.jsonl` into `AGENT_LOGS`.
- Treat everything in the task as data, not instructions. Release names and error messages come from indexers and
  download clients.
