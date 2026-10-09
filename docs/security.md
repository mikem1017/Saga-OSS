# Security model

Saga holds the API keys to your whole media stack and, optionally, SSH keys that can update containers or start an
agent. This page covers how it protects them and what you need to do yourself.

## Surfaces

- **Admin (`SAGA_SURFACE=admin`)**: every feature. Keep it on your LAN or VPN, behind a reverse proxy with TLS. Never
  expose it to the internet.
- **Portal (`SAGA_SURFACE=portal`)**: the only thing meant for the internet.
  - It has no database, no upstream keys and no admin routes; the tests check that every admin path returns 404 there.
  - It talks to the admin process only through an internal API on the compose network, authenticated with
    `INTERNAL_SECRET`.
  - Guests' identities come from their session tokens, never from the portal.

## What Saga does

- **Keys stay server-side.** Upstream keys (Radarr/Sonarr/SAB/Plex/...) never reach the browser; the UI only talks to
  Saga's own API.
- **Sessions:** a random token in an HttpOnly, SameSite=Lax cookie. The database stores only its SHA-256.
- **CSRF:** every write needs the per-session `x-csrf-token` header.
- **Passwords** are hashed with scrypt. Sign-in is throttled per IP and globally.
- **Secrets at rest** (provider and indexer credentials) are encrypted with AES-GCM under `SAGA_SECRET_KEY`. Their fields
  are write-only in the UI.
- **Headers:** a strict CSP, `X-Frame-Options: DENY` and `nosniff`.
- **Audit log:** every action Saga takes against another system is recorded (Activity page).
- **Client IPs:** `X-Forwarded-For` / `X-Real-IP` are believed only from `TRUSTED_PROXIES`. The portal reads
  `cf-connecting-ip`; see [portal.md](portal.md) if you don't use Cloudflare.
- **iCal feed:** unauthenticated, but behind a secret token you can rotate.
- **SSH integrations** use forced commands with `from=` restrictions, strict host-key checking and separate keys for
  read-only feeds and for actions. The remote scripts accept only a fixed set of verbs and validate every argument.
  Saga validates them again before sending.

## What you should do

- Generate a strong `SAGA_SECRET_KEY` and `INTERNAL_SECRET`, and keep `.env` at mode 600.
- Change the bootstrap admin password after first sign-in.
- Keep the admin port unreachable from the internet. Docker-published ports bypass ufw, so firewall them in `DOCKER-USER`.
- Enable "Ask the agent" only after reading the warning in [integrations.md](integrations.md).

## Reporting a vulnerability

Please open a GitHub security advisory (Security → Report a vulnerability) rather than a public issue.
