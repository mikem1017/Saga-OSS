# Deploying Saga

Saga runs as a Docker Compose project: the admin app (`saga`), plus an optional public request portal
(`saga-portal`) and Cloudflare Tunnel connector (`cloudflared`).

## Layout on the host

```
/opt/saga/
  app/                 the repository (built into the image)
  docker-compose.yml   copy of deploy/docker-compose.yml
  .env                 your configuration (chmod 600): see .env.example
  data/                SQLite database (back this up). Must be owned by uid 1000, the container's user
  ssh/                 optional: keys + known_hosts for the SSH integrations (mounted read-only at /ssh)
```

`deploy/deploy.sh user@host [/opt/saga]` syncs a checkout to that layout over SSH and rebuilds. It runs the
typecheck and tests first.

The README's quick start creates this layout. If `data/` is owned by root (Docker creates missing bind-mount
folders as root), Saga can't open its database: run `sudo chown 1000:1000 data`.

## First start

1. Fill in `.env`. The minimum is `SAGA_SECRET_KEY` (`openssl rand -base64 32`), `SAGA_ADMIN_PASSWORD` and `TMDB_API_KEY`,
   plus the URL and API key of each app you use. Saga needs network access to them. If they're on the same Docker host,
   either put Saga on their network or use the host's LAN address.
2. `docker compose up -d --build saga`
3. Open `http://<host>:8080` and sign in. The admin account is only created on first start; change its password under
   Settings. If you're locked out:
   `docker compose exec saga node_modules/.bin/tsx src/server/cli.ts reset-password admin`.

## Keep the admin UI private

The admin surface can add and delete media, change download priorities, and (with the optional integrations) update
containers or start agent runs. Treat it like your *arr UIs:

- Reach it only from your LAN or a VPN (WireGuard, Tailscale, ...). Don't port-forward it.
- Put it behind a reverse proxy with TLS, and list the proxy's address in `TRUSTED_PROXIES` so Saga sees real client
  IPs for its sign-in throttling.
- Docker-published ports bypass most host firewalls (ufw included). If other machines on your LAN shouldn't reach port
  8080, add a rule in the `DOCKER-USER` iptables chain that only allows your proxy.

## The request portal (optional)

The portal is a separate container with **no database and no upstream keys**. It reaches the admin process only through
an internal API on the compose network, authenticated with `INTERNAL_SECRET`. Details and the Cloudflare setup are in
[portal.md](portal.md).

```bash
# in .env: INTERNAL_SECRET, PORTAL_PUBLIC_URL, and optionally VAPID_*, RESEND_API_KEY, MAIL_FROM
docker compose --profile portal up -d                 # portal only (bring your own exposure)
docker compose --profile tunnel up -d                 # portal + Cloudflare Tunnel connector (CLOUDFLARE_TUNNEL_TOKEN)
```

## Backups

- `data/saga.db`: users, rules, requests, guests, audit log, and the encrypted provider/indexer secrets. Back it up with
  `sqlite3 data/saga.db ".backup saga-backup.db"`, or stop the container and copy the file.
- `.env`. Without `SAGA_SECRET_KEY` the stored provider/indexer secrets can't be decrypted. The Providers page also
  offers a passphrase-encrypted export.

## Updating Saga

`git pull`, then `docker compose up -d --build`. Database migrations run automatically on start and are append-only.
