# Saga

**A self-hosted control plane, discovery hub and request portal for your *arr + Plex media stack.**

Saga sits on top of Radarr, Sonarr, Lidarr, Prowlarr, SABnzbd, Plex and Tautulli. It gives you one place to:
- discover and add anything;
- watch your downloads honestly;
- fix what breaks;
- keep the stack updated;
- let a few invited people request titles, with limits.

It started as a replacement for Overseerr/Jellyseerr. Their main limitation was that you could only request what you'd
already found, with no way to browse and bulk-add the way Radarr's own lists do. Saga grew into a dashboard for the whole stack.

> Status: used daily on one homelab. Expect rough edges; issues and PRs are welcome.

## Features

**Discover and add**
- TMDB rails, plus Browse with filters: genre, decade, language, studio/network, streaming provider, keywords.
  Also people, collections, and lists (IMDb, Letterboxd, MDBList, Trakt).
- Live library badges on every poster: in library (with quality), downloading (%/ETA), queued (position), requested, missing.
- **Smart add** with ordered rules that pick the profile and root folder. Bulk add shows the size and time before you commit.
  Includes "add the missing films of this collection".
- Paste any IMDb/TMDB/TVDB/Trakt/Letterboxd link to find a title.
- Optional natural-language discover ("90s heist films I don't have") via the Claude API.

**Downloads and the dashboard**
- The SABnzbd queue joined to Radarr/Sonarr, with **honest ETAs** from real throughput and queue position.
- Bump, priority, move, timed pause/resume, and cancel. Cancel goes through the *arr so it isn't treated as a failed grab.
- Throughput stats, health of every app, Plex now-playing, a release calendar with an iCal feed, and an activity log of
  every action Saga takes.
- **Problems panel:**
  - It shows downloads stuck in Radarr/Sonarr, *and* SAB failures that no *arr is tracking any more. Nothing re-searches
    those by itself.
  - One-click fixes: blocklist & search again, pick a specific release (grabbed through the *arr so it stays tracked),
    retry in SAB, dismiss.
- **Insights:**
  - upgrade finder;
  - storage forecast;
  - library hygiene report;
  - "because you watched" (Tautulli);
  - release-aware auto-bump.

**Providers and indexers**
- Usenet providers and indexers are stored encrypted. Saga pushes changes to SABnzbd and Prowlarr after showing a diff,
  and snapshots their config first.
- It tracks renewals, block balances and indexer API limits.

**Request portal (optional, separate container)**
- Invite-only: sign in with Plex (optionally only your Plex friends) or with an emailed magic link.
- Per-guest limits (films per week, seasons per week, GB per month, rating cap), auto-approve rules, and an approval queue.
- Duplicate requests merge into one.
- Live status for guests ("queued #212, about 3 h"), "coming soon" and status pages, and watchlist sync within limits.
- Notifications by web push and email.
- Import users and requests from Overseerr/Jellyseerr.

**Optional SSH integrations** (see [docs/integrations.md](docs/integrations.md))
- **Stack page:** running vs available version of every container, "update all", one app at a time with health checks,
  rollback, and automatic re-search of SABnzbd jobs that fail to load after an upgrade.
- Status feeds from the download host (post-processing guard, disks, leftovers) and from a maintenance agent.
- **Ask the agent:** hand a problem to your own unattended maintenance agent (e.g. Claude Code) and watch it work.

## How it's built

TypeScript end to end: a Hono API on Node 24 (run with `tsx`), SQLite via `node:sqlite`, and a React 19 + TanStack
Query + Tailwind PWA.

One image serves two surfaces:

```
LAN / VPN ──► saga (admin)  :3000   all features, holds every API key, SQLite
                   ▲ internal API :3001 (compose network only, shared secret)
internet  ──► saga-portal   :3000   guest portal only: no database, no upstream keys, no admin routes
```

The browser never receives an upstream API key. `SAGA_SURFACE=portal` registers no admin routes, and the tests check
that. See [docs/security.md](docs/security.md).

## Quick start (Docker Compose)

**You need:**
- a Linux host with Docker and the Compose plugin that can reach your *arr apps, SABnzbd and Plex;
- a free [TMDB API key](https://www.themoviedb.org/settings/api);
- the API key of each app you want to connect (Settings → General in Radarr, Sonarr, Lidarr, Prowlarr and SABnzbd), plus your
  [Plex token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/).

**1. Get the code and set up the folder layout**

```bash
sudo mkdir -p /opt/saga && sudo chown "$USER" /opt/saga && cd /opt/saga
git clone https://github.com/mikem1017/Saga-OSS.git app
cp app/deploy/docker-compose.yml .
cp app/.env.example .env && chmod 600 .env
mkdir -p data ssh && sudo chown 1000:1000 data   # the container runs as uid 1000 and must own data/
```

**2. Configure `.env`.** At a minimum, set:
- `SAGA_SECRET_KEY` (generate it with `openssl rand -base64 32`);
- `SAGA_ADMIN_PASSWORD`;
- `TMDB_API_KEY`;
- the `*_URL` and `*_API_KEY` of each app you use.

Every connector is optional, and features turn on for whatever you configure. The URLs must be reachable from inside the
container: either use the host's LAN address (`http://192.168.1.10:7878`), or put Saga on the same Docker network as
your stack and use the container names (`http://radarr:7878`).

**3. Start it**

```bash
docker compose up -d --build saga
docker compose logs -f saga    # the startup line lists which connectors were found
```

Open `http://<host>:8080` and sign in with `SAGA_ADMIN_USER` (default `admin`) and `SAGA_ADMIN_PASSWORD`. The admin
account is created on first start, so change its password under Settings afterwards. **Keep the admin UI on your LAN or
VPN**, since it holds the keys to your whole stack.

**Next steps:**
- [docs/deployment.md](docs/deployment.md): reverse proxy, firewall, backups, updating.
- [docs/portal.md](docs/portal.md): the public request portal for invited guests.
- [docs/integrations.md](docs/integrations.md): the optional SSH features (Stack updates, status feeds, Ask the agent).
- [docs/security.md](docs/security.md): what Saga protects and what you should do yourself.

**Updating:** `cd /opt/saga/app && git pull && cd .. && docker compose up -d --build`. Database migrations run
automatically.

## Configuration

Everything is set in `.env`. Nothing about your servers is hard-coded. [`.env.example`](.env.example) lists every
setting with a comment. Blank means off.

| Group | Settings |
|---|---|
| Core | `PUBLIC_URL`, `SAGA_SECRET_KEY`, `SAGA_ADMIN_USER`, `SAGA_ADMIN_PASSWORD`, `TRUSTED_PROXIES` |
| Media stack (URL + key each) | `RADARR_*`, `SONARR_*`, `LIDARR_*`, `PROWLARR_*`, `SAB_*`, `PLEX_URL` + `PLEX_TOKEN`, `TAUTULLI_*`, `SEERR_*` (import only) |
| Add defaults | `DEFAULT_MOVIE_PROFILE`, `DEFAULT_TV_PROFILE` (else the most tuned profile), `SAB_MIN_FREE_GB` |
| Discovery | `TMDB_API_KEY` (required for Discover), `TRAKT_CLIENT_ID`, `WATCH_REGION`, `ANTHROPIC_API_KEY` + `NL_MODEL` (natural-language search) |
| Request portal | `INTERNAL_SECRET`, `PORTAL_PUBLIC_URL`, `VAPID_*` (web push), `RESEND_API_KEY` + `MAIL_FROM` (email), `CLOUDFLARE_TUNNEL_TOKEN` |
| SSH integrations | `FEED_HOST`, `FEED_AGENT_HOST`, `OPS_STACK_HOST`, `OPS_AGENT_HOST`, `*_SSH_KEY`, `MEDIA_MOUNT`, `CACHE_MOUNT` |

The optional host scripts read their own small config files. Those are described in
[docs/integrations.md](docs/integrations.md).

## Development

Requires Node 24+.

```bash
npm ci
cp .env.example .env    # then fill in at least SAGA_SECRET_KEY and TMDB_API_KEY
set -a; . ./.env; set +a
npm run dev:server      # API on :3000 (tsx watch)
npm run dev:web         # Vite on :5173, proxies /api
npm run typecheck && npm test && npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for layout and the rules that must not regress.

## License

[MIT](LICENSE)
