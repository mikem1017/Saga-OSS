# Contributing

Issues and pull requests are welcome. For anything big, open an issue first so we can agree on the approach.

## Commands

- `npm run dev:server` (tsx watch, :3000) and `npm run dev:web` (Vite, proxies `/api`). Export a `.env` first (see `.env.example`).
- `npm run typecheck` · `npm test` (vitest, `test/`) · `npm run build` (web → `dist/web`, portal → `dist/portal`).

## Layout

- `src/server/connectors/`: one thin client per upstream app. Radarr/Sonarr/Lidarr/Prowlarr share `ArrClient`.
  `feeds.ts` holds the SSH forced-command clients.
- `src/server/services/`:
  - problems (failed/stuck downloads), stackUpdates (saga-ops), agentTasks;
  - library mirror, downloads join + ETAs (`eta.ts` is pure);
  - discover, add + rules, lists, resolve (paste-a-link);
  - throughput, health, calendar/iCal, queue control, audit.
- `src/server/portal/`: the request portal: guests, requests, notifications, and the internal API.
- `src/server/extras/`: insights (upgrades, hygiene, forecast, for-you, natural-language discover).
- `src/server/app.ts`: every admin route. `SAGA_SURFACE=portal` registers none of them (tested).
- `src/shared/types.ts`: API shapes shared with the web app. `src/web/`: React SPA. `deploy/`: compose, deploy script, host scripts.

## Rules that must not regress

- Never resume a SABnzbd pause that a post-processing guard made. Refuse when the guard's state can't be read.
- Never set SAB's Force priority: it ignores pauses. Bump = High + move to index 0.
- Saga's own pauses are always timed (`set_pause`).
- Cancel goes through the *arr (`removeFromClient`) when it tracks the job, so it isn't treated as a failed grab.
- A grab or search from the Problems panel always goes through Radarr/Sonarr, so they track it. Never add an NZB to SAB directly.
- The browser never receives an upstream key. Every new write action goes through `audit()`.
- Judge whether imports are flowing from *arr history, not SAB history (SAB archives finished jobs).
- SSH integrations: fixed verbs only. Validate service names, run IDs and task IDs on both sides.
  Agent tasks are built server-side from Saga's own records, never from free text sent by the browser.
- Database migrations are append-only; never edit a shipped one.
