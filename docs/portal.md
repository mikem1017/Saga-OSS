# The request portal

An invite-only site where friends and family request films and shows. Guests sign in with Plex, or with an emailed
link for invited addresses. There is no open sign-up.

## How it's put together

```
internet → (Cloudflare WAF / rate limit) → tunnel → cloudflared
        → saga-portal (:3000, not published)  ──INTERNAL_SECRET──►  saga internal API (:3001, compose network only)
                                                                    (all request logic, DB, *arr writes)
```

- **`saga-portal`** (`src/server/portal-main.ts`, `src/server/portal/app.ts`) serves the guest SPA (`dist/portal`) and
  forwards `/api/portal/*` to the admin process's internal API.
  - It has no database and no upstream keys. Compose gives it only `INTERNAL_URL`, `INTERNAL_SECRET` and
    `PORTAL_PUBLIC_URL`, and it refuses to start if an admin secret is in its environment.
  - Its route table is `/healthz`, `/api/portal/*` and static files; `test/portal.test.ts` checks that admin routes 404.
- **Internal API** (`src/server/portal/internal.ts`) runs inside the admin process on `INTERNAL_PORT`.
  - Every call needs the shared secret.
  - The guest's identity comes from their session token, which the portal forwards. The portal is never trusted to name
    the guest.
  - Guest views are sanitised: no other requesters, file paths, profiles or queue internals beyond position and ETA.
- **Requests** (`src/server/portal/requests.ts`):
  - Limits are enforced server-side: films per week, seasons per week, GB per month, and a content-rating cap for kid
    profiles.
  - Duplicates merge: one request, many requesters.
  - Auto-approve can be set per guest; everything else goes to the admin's approval queue.
  - Approving adds the title with the same rules as an admin add. Approved titles become **available** when the files
    land, and every requester is notified.
- **Notifications** (`notify.ts`): in-app, plus web push (`VAPID_*`) and email via Resend (`RESEND_API_KEY`, `MAIL_FROM`
  on a domain you've verified with Resend).
- **Admin side:**
  - **Requests**: approve, decline, problems, filter by requester.
  - **Guests**: per-guest limits and roles, invites, portal defaults, status posts, and an Overseerr/Jellyseerr import
    with a dry-run preview.

## Exposing it with Cloudflare Tunnel (one way to do it)

1. In Cloudflare Zero Trust, create a remotely managed tunnel. Give it a public hostname (e.g. `requests.example.com`)
   pointing to `http://saga-portal:3000`.
2. Put the tunnel token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`, then run `docker compose --profile tunnel up -d`.
3. Recommended: a WAF custom rule that blocks every path on that hostname except `/`, the SPA routes, `/assets/*`,
   `/api/portal/*`, `/manifest.webmanifest`, `/sw.js`, `/icon.svg` and `/healthz`. Add a rate-limit rule on
   `/api/portal/auth/*`. The app also throttles failed sign-ins per IP (it reads `cf-connecting-ip`).
4. Until the connector runs, the hostname returns an error, so nothing is exposed early.

Any other reverse proxy works too. Expose only `saga-portal`, never `saga`. **Caveat:** the portal takes the client IP
from `cf-connecting-ip` for its sign-in throttle. Behind a different proxy, make sure the proxy overwrites that header
(or strips it); otherwise a client can send its own value and dodge the per-IP throttle.
