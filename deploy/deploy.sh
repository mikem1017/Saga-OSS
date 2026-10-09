#!/usr/bin/env bash
# Sync the working tree to a Docker host and rebuild there.
# Usage: deploy/deploy.sh user@host [remote-dir]     (remote-dir defaults to /opt/saga)
# The remote dir holds docker-compose.yml, .env, data/ and ssh/; the code goes to <remote-dir>/app.
set -euo pipefail
HOST="${1:?usage: deploy/deploy.sh user@host [remote-dir]}"
DIR="${2:-/opt/saga}"
cd "$(dirname "$0")/.."
npm run typecheck
npm test
rsync -az --delete --exclude node_modules --exclude dist --exclude data --exclude .env --exclude .git --exclude .claude ./ "$HOST:$DIR/app/"
rsync -az deploy/docker-compose.yml "$HOST:$DIR/docker-compose.yml"
ssh "$HOST" "cd $DIR && docker compose up -d --build && docker image prune -f >/dev/null && sleep 5 && docker compose ps && docker compose logs --tail 20 saga"
