# 生产接入与首次配置

从受审仓库根目录执行文中的相对路径命令；服务器命令须在已有授权覆盖范围内执行。返回[部署地图](../README.md)。

## Access model

- Nginx keeps the existing application at `/`.
- `/apps/` is a small application router.
- HTTP requests and HTTPS requests to the public IP redirect to `https://77liu.top`.
- Domain HTTPS `/now/` proxies to this Node service and requires an invited account.
- Domain HTTPS `/platform/` proxies to the
  independently deployed read-only platform console on `127.0.0.1:4280`.
- `/now/api/admin/v1/snapshot` is blocked at Nginx. Only the local platform
  process can call it with its service token.

Let's Encrypt issues certificates for both `77liu.top` and the public IPv4
address. Nginx uses the domain certificate for the application and retains the
IP certificate for a trusted redirect to the canonical domain. Certbot renews
both automatically. The ECS security group must allow inbound TCP 80 and 443.

The production domain cutover completed on 2026-09-29 as an Nginx-only change.
`https://77liu.top/now/` returned 200 with a matching certificate; domain HTTP
and public-IP HTTPS returned 308 to the canonical domain. `certbot renew
--dry-run` succeeded and the renewal timer was enabled. The pre-change server
configuration is `/etc/nginx/sites-available/dysf.before-domain-20260929-175523`.
No application release or data change was part of that operation.

## Initial server setup

1. Install Node.js 20 or newer and npm at `/usr/local/bin/node` and
   `/usr/local/bin/npm`, plus Git, Nginx, Certbot 5.4 or newer, ossutil 2, and
   FFmpeg at `/usr/bin/ffmpeg`. FFmpeg is required to normalize private M4A
   recordings before ASR; deployment fails closed when it is absent.
2. Attach an ECS RAM role with separate least-privilege access to
   `for-now-backups/*` and `for-now-attachments/*`. Verify the attachment prefix permissions against the actual RAM policy and environment; operational boundaries are documented in `knowledge/operations-capacity.md`.
3. In the reviewed checkout run `npm ci`, then `sudo deploy/prepare-server.sh`; the installer requires the local TypeScript compiler to build monitor helpers.
4. Add the printed public key to Gitee as a read-only deploy key.
5. Set `INVITE_CODE_HASH`, `PLATFORM_SERVICE_TOKEN_HASH`, OSS attachment settings,
   `FEISHU_ALERT_WEBHOOK`, `VOLCENGINE_SPEECH_API_KEY`,
   `VOLCENGINE_ACCESS_KEY_ID`, and `VOLCENGINE_SECRET_ACCESS_KEY` in
   `/etc/for-now.env`. Store only the invitation
   and platform-token SHA-256 digests, not their plaintext values, and keep
   `COOKIE_SECURE=1`. The matching platform token plaintext belongs only in
   `/etc/for-now-platform.env`. Keep
   `ATTACHMENT_STORAGE=local` until the migration sequence below succeeds.
   Use a least-privilege visual-service sub-user instead of a root-account
   Access Key. Detailed service and smoke-test instructions are in
   `knowledge/volcengine-integration.md`.
   Synchronization switch behavior and compatibility limits follow
   [the design contract](../../knowledge/design-contracts.md#记录级同步与缓存);
   changing the switch requires checking the candidate's actual behavior, not assuming bounded recovery.

6. Include `/etc/nginx/snippets/acme-challenge.conf` in the port-80 server,
   reload Nginx, then issue the IP and domain certificates:

   ```bash
   sudo certbot certonly --webroot -w /var/www/letsencrypt \
     --ip-address 123.57.140.24 --preferred-profile shortlived \
     --non-interactive --agree-tos --register-unsafely-without-email \
     --deploy-hook "systemctl reload nginx"
   sudo certbot certonly --webroot -w /var/www/letsencrypt \
     -d 77liu.top --deploy-hook "systemctl reload nginx"
   ```

7. Install `deploy/nginx-dysf.conf` as `/etc/nginx/sites-available/dysf`, then
   run `sudo nginx -t && sudo systemctl reload nginx`.
8. Install the reviewed release guard and issue a production attempt as described in [release execution](../README.md#deploy-updates), then run the deployer with that attempt.
9. Only for a new JSON installation before account registration, migrate local data with `deploy/migrate-data.sh user@server`. Existing PostgreSQL installations use the [database migration/recovery procedure](../../knowledge/postgres-migration.md); do not copy JSON over a running database.
10. Verify `sudo /usr/local/sbin/for-now-backup`, then enable the timer with
   `sudo systemctl enable --now for-now-backup.timer`.
11. Complete the private attachment migration below, run
   `sudo /usr/local/sbin/for-now-restore-drill`, and send one real Feishu test
   alert before enabling invitations.

`prepare-server.sh` does not install or provision PostgreSQL. For a new cutover, choose a PostgreSQL 16 host, verify its capacity and network/TLS
boundary, and create the separate schema-admin, migration, runtime-data,
runtime-auth, and read-only recovery roles described in
[`knowledge/postgres-migration.md`](../../knowledge/postgres-migration.md). Do not
set `PERSISTENCE_BACKEND=postgres` until the latest JSON/OSS snapshot, full
migration, independent restore, and rollback checks have passed.

## Read-only platform console

The platform console is a separate orphan branch (`platform/main`) and systemd
service in the same Gitee repository. Its deployment instructions live in that
branch's `README.md`. The main application exposes one aggregate endpoint for it:

- direct loopback access only, with no `X-Forwarded-For`;
- `Authorization: Bearer ...` checked against
  `PLATFORM_SERVICE_TOKEN_HASH`;
- counts, status, timings and cost only;
- no record content, model prompt/response, attachment body or credential.

Deploy the main application first, then the platform console. Verify that the
public `/now/api/admin/v1/snapshot` path returns 404 before opening
`https://77liu.top/platform/`. Keep `MONITOR_PLATFORM_ENABLED=0` while the
platform service does not exist. After its `/readyz` and public login smoke
tests pass, set the value to `1` and run `for-now-monitor.service` once; only
then leave the five-minute timer enabled for platform monitoring.

ossutil uses `--mode EcsRamRole` and the Beijing internal endpoint from
`/etc/for-now.env`; no long-lived AccessKey is stored on disk.
