# Cloud deployment

The cloud service is the canonical data source. Code is deployed from Gitee;
runtime data lives only in `/srv/for-now/data`; OSS receives consistent backup
archives. Never synchronize a live data directory in both directions.

## Access model

- Nginx keeps the existing application at `/`.
- `/apps/` is a small application router.
- HTTP `/now/` redirects to `https://123.57.140.24/now/`.
- HTTPS `/now/` proxies to this Node service and requires an invited account.

Let's Encrypt issues a short-lived certificate directly for the public IPv4
address. Certbot renews it automatically. The ECS security group must allow
inbound TCP 80 and 443.

## Initial server setup

1. Install Node.js 20 or newer, Git, Nginx, Certbot 5.4 or newer, and ossutil 2.
2. Attach an ECS RAM role that can write only to
   `acs:oss:*:*:for-now/for-now-backups/*` and list the `for-now` bucket.
3. Run `sudo deploy/prepare-server.sh`.
4. Add the printed public key to Gitee as a read-only deploy key.
5. Set `INVITE_CODE_HASH` in `/etc/for-now.env`. Store only the SHA-256 digest,
   not the invitation plaintext, and keep `COOKIE_SECURE=1`.
6. Include `/etc/nginx/snippets/acme-challenge.conf` in the port-80 server,
   reload Nginx, then issue the IP certificate:

   ```bash
   sudo certbot certonly --webroot -w /var/www/letsencrypt \
     --ip-address 123.57.140.24 --preferred-profile shortlived \
     --non-interactive --agree-tos --register-unsafely-without-email \
     --deploy-hook "systemctl reload nginx"
   ```

7. Install `deploy/nginx-dysf.conf` as `/etc/nginx/sites-available/dysf`, then
   run `sudo nginx -t && sudo systemctl reload nginx`.
8. Run `sudo for-now-deploy`.
9. Before the first account is registered, migrate the existing local data with
   `deploy/migrate-data.sh user@server`.
10. Verify `sudo /usr/local/sbin/for-now-backup`, then enable the timer with
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
UPSTREAM_ORIGIN=https://123.57.140.24/now ./启动.command
```

The local Node process serves local frontend files and proxies API, session, SSE,
and attachment traffic to the cloud.
