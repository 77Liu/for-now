# Cloud deployment

The cloud service is the canonical data source. Code is deployed from Gitee;
runtime data lives only in `/srv/for-now/data`; OSS receives consistent backup
archives. Never synchronize a live data directory in both directions.

## Access model

- Nginx keeps the existing application at `/`.
- `/apps/` is a small application router.
- `/now/` proxies to this Node service.
- `/now/` only accepts Tailscale client addresses.
- The application still requires an invited account after entering the private
  network.

Tailscale is the encrypted private network layer. Install it on the ECS and
each computer or phone that should open the application. The browser then uses
the ECS Tailscale IP, for example `http://100.x.y.z/now/`. Port 80 can remain in
use by the existing Nginx process; no second public port is needed.

## Initial server setup

1. Install Node.js 20 or newer, Git, Nginx, Tailscale, and ossutil 2.
2. Attach an ECS RAM role that can write only to
   `acs:oss:*:*:for-now/for-now-backups/*` and list the `for-now` bucket.
3. Run `sudo deploy/prepare-server.sh`.
4. Add the printed public key to Gitee as a read-only deploy key.
5. Set `INVITE_CODE_HASH` in `/etc/for-now.env`. Store only the SHA-256 digest,
   not the invitation plaintext.
6. Add `include /etc/nginx/snippets/for-now.conf;` inside the existing
   port-80 `server` block, then run `sudo nginx -t && sudo systemctl reload nginx`.
7. Run `sudo for-now-deploy`.
8. Before the first account is registered, migrate the existing local data with
   `deploy/migrate-data.sh user@server`.
9. Verify `sudo /usr/local/sbin/for-now-backup`, then enable the timer with
   `sudo systemctl enable --now for-now-backup.timer`.

ossutil uses `--mode EcsRamRole` and the Beijing internal endpoint from
`/etc/for-now.env`; no long-lived AccessKey is stored on disk.

## Deploy updates

Push code to the `main` branch, then run:

```bash
sudo for-now-deploy
```

The deploy command builds an immutable release directory, validates JavaScript,
switches the active symlink, restarts systemd, checks `/readyz`, and restores the
previous release if the health check fails.

For local UI development against canonical cloud data:

```bash
UPSTREAM_ORIGIN=http://100.x.y.z/now ./启动.command
```

The local Node process serves local frontend files and proxies API, session, SSE,
and attachment traffic to the cloud.
