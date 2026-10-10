#!/usr/bin/env bash
# Deploy herdr-office on this machine:
#   - installs/restarts a systemd *user* service (it needs the host's herdr socket, so it is not containerised)
#   - renders the nginx vhost from deploy/nginx.conf.template and reloads nginx   (skip with SKIP_NGINX=1)
# Configure once:  cp deploy/deploy.env.example deploy/deploy.env && $EDITOR deploy/deploy.env
# Usage:           bash tools/deploy.sh
set -euo pipefail

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
UNIT=herdr-office.service
cd "$PROJ"

[ -f deploy/deploy.env ] || { echo "missing deploy/deploy.env (copy deploy/deploy.env.example)"; exit 1; }
set -a; . deploy/deploy.env; set +a
: "${DOMAIN:?set DOMAIN in deploy/deploy.env}"
[ -s .env ] && grep -q '^OFFICE_TOKEN=.\+' .env || { echo "missing OFFICE_TOKEN in .env (refusing to deploy an open office)"; exit 1; }
PORT=$(grep -E '^PORT=' .env | cut -d= -f2- || true); PORT=${PORT:-4747}

node --check server/index.js
node --test test/*.test.js >/dev/null && echo "tests ok"

render() { # render <template> : replace the __PLACEHOLDERS__
  sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__UPSTREAM__|${UPSTREAM:-127.0.0.1:$PORT}|g" \
      -e "s|__SSL_CERT__|${SSL_CERT:-}|g" -e "s|__SSL_KEY__|${SSL_KEY:-}|g" \
      -e "s|__PROJECT_DIR__|$PROJ|g" -e "s|__NODE__|$(command -v node)|g" "$1"
}

mkdir -p ~/.config/systemd/user
render deploy/herdr-office.service.template > ~/.config/systemd/user/$UNIT
systemctl --user daemon-reload
systemctl --user enable $UNIT >/dev/null 2>&1 || true
systemctl --user restart $UNIT

if [ "${SKIP_NGINX:-0}" != 1 ]; then
  : "${NGINX_CONF_DIR:?set NGINX_CONF_DIR in deploy/deploy.env}"
  render deploy/nginx.conf.template > "$NGINX_CONF_DIR/$DOMAIN.conf"
  eval "${NGINX_TEST_CMD:-nginx -t}"
  eval "${NGINX_RELOAD_CMD:-nginx -s reload}"
fi

sleep 2
systemctl --user is-active $UNIT
curl -s -o /dev/null -w "health   : HTTP %{http_code}\n" --max-time 10 "http://127.0.0.1:$PORT/healthz"
[ "${SKIP_NGINX:-0}" = 1 ] || curl -s -o /dev/null -w "via nginx: HTTP %{http_code} (expect 303 -> /login)\n" -k --max-time 10 \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/"
echo "deployed -> https://$DOMAIN"
