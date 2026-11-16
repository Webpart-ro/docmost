# n.webpart.ro auto-deploy (homeserver)

Merging a PR into `webpart` builds `ghcr.io/webpart-ro/docmost:<sha>` and `:latest`
(`.github/workflows/webpart-image.yml`). On homeserver, `docmost-autodeploy.timer`
checks every 2 minutes. When `:latest` carries a new commit SHA, it pins
`/srv/apps/docmost/compose.yml` to it, restarts the app, waits for `/api/health`, and
rolls back to `compose.yml.previous` if the check fails. A SHA that failed is recorded in
`/srv/apps/docmost/.autodeploy-failed` and skipped until the next merge.

The server pulls; GitHub never gets access to it (this fork is public, so it doesn't
use the self-hosted runner).

## Install / update (as root, from a checkout of a merged `webpart`)

```sh
install -m 755 deploy/homeserver/docmost-autodeploy.sh /usr/local/bin/docmost-autodeploy.sh
install -m 644 deploy/homeserver/docmost-autodeploy.service deploy/homeserver/docmost-autodeploy.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now docmost-autodeploy.timer
```

## Operate

```sh
journalctl -u docmost-autodeploy -n 50     # what it did
systemctl start docmost-autodeploy          # deploy now instead of waiting
systemctl disable --now docmost-autodeploy.timer   # pause auto-deploys
```

Manual rollback: `cp compose.yml.previous compose.yml && docker compose up -d` in
`/srv/apps/docmost`. Startup migrations are not reverted by a rollback.
