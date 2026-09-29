# Cloud deployment

The cloud service is the canonical data source. Code is deployed from Gitee;
runtime data lives only in `/srv/for-now/data`; OSS receives consistent backup
archives. Never synchronize a live data directory in both directions.

The default and current production backend is JSON. The v0.2.0 PostgreSQL runtime,
separate data/auth/recovery roles, offline export, and cutover boundaries are
documented in [`knowledge/postgres-migration.md`](../knowledge/postgres-migration.md).
Deploy database-capable code while still using JSON before the separately approved
offline database cutover. Generic deploy rollback rejects a PostgreSQL configuration
if either candidate or previous code lacks the runtime adapter. PostgreSQL backups
require `PG_BACKUP_DATABASE_URL`; the existing cloud restore drill checks logical
JSON compatibility only, while a fresh-database restore remains a separate gate.

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
   `/usr/local/bin/npm`, plus Git, Nginx, Certbot 5.4 or newer, and ossutil 2.
2. Attach an ECS RAM role with separate least-privilege access to
   `for-now-backups/*` and `for-now-attachments/*`. The exact attachment policy
   is documented in `knowledge/operations-capacity.md`.
3. Run `sudo deploy/prepare-server.sh`.
4. Add the printed public key to Gitee as a read-only deploy key.
5. Set `INVITE_CODE_HASH`, `PLATFORM_SERVICE_TOKEN_HASH`, OSS attachment settings and
   `FEISHU_ALERT_WEBHOOK` in `/etc/for-now.env`. Store only the invitation
   and platform-token SHA-256 digests, not their plaintext values, and keep
   `COOKIE_SECURE=1`. The matching platform token plaintext belongs only in
   `/etc/for-now-platform.env`. Keep
   `ATTACHMENT_STORAGE=local` until the migration sequence below succeeds.
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
8. Run `sudo for-now-deploy`.
9. Before the first account is registered, migrate the existing local data with
   `deploy/migrate-data.sh user@server`.
10. Verify `sudo /usr/local/sbin/for-now-backup`, then enable the timer with
   `sudo systemctl enable --now for-now-backup.timer`.
11. Complete the private attachment migration below, run
   `sudo /usr/local/sbin/for-now-restore-drill`, and send one real Feishu test
   alert before enabling invitations.

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

## Private attachment migration

The OSS bucket must remain private. After the RAM role can list, put, get and
delete only under `for-now-attachments/*`, run a harmless object probe, then
copy existing local images while writes are stopped:

```bash
sudo /bin/bash -c '
  set -a
  source /etc/for-now.env
  set +a
  exec runuser --preserve-environment -u for-now -- \
    /usr/local/bin/node /opt/for-now/app/scripts/oss-attachment-smoke.mjs
'
sudo systemctl stop for-now.service
sudo /usr/local/sbin/for-now-migrate-attachments
sudo sed -i 's/^ATTACHMENT_STORAGE=.*/ATTACHMENT_STORAGE=oss/' /etc/for-now.env
sudo systemctl start for-now.service
curl -fsS http://127.0.0.1:4173/readyz
```

Do not delete the local attachment directories during this release. They are
the rollback copy and the application can read them when an old object is not
yet present. Verify authenticated upload/read, record pages, and a restore drill
before scheduling any cleanup.

## Monitoring and restore

`for-now-monitor.timer` checks the service, disk, backup age, consecutive AI
failures and daily AI cost every five minutes. The deployment enables it after a
healthy application restart. Test the Feishu channel without printing its
webhook or secret:

```bash
sudo /bin/bash -c '
  set -a
  source /etc/for-now.env
  set +a
  exec runuser --preserve-environment -u for-now -- \
    /usr/local/bin/node /opt/for-now/app/scripts/monitor-health.mjs --test-alert
'
sudo /usr/local/sbin/for-now-restore-drill
```

Thresholds, test expectations, current production capacity and the last real
restore result are maintained in `knowledge/operations-capacity.md`.

## Deploy updates

Push code to the `main` branch, then run:

```bash
sudo for-now-deploy
```

The deploy script rejects both `explore/*` and `checkpoint/*`; an intermediate
checkpoint must first pass the release review and be promoted through an
authorized release branch.

The deploy command builds dependencies in a new candidate directory, validates
JavaScript and the versioned prompt catalog, marks that immutable release ready, switches the active symlink,
restarts systemd, and checks `/readyz`. Re-running the same commit never runs
`npm ci` inside the active release. Failure after configuration
installation restores the previous code, managed service/Nginx files, deployment
tools, and `/etc/for-now.env` (including `APP_VERSION`). An unhealthy recovery is
reported explicitly; the deployment remains failed. Data is not rolled back by
this script. Take and verify a data backup before a release with migrations.

`PROMPT_CATALOG_VERSION` may pin any immutable version included under
`prompts/versions/`; leave it empty to use `prompts/manifest.json` `activeVersion`.
Changing the pin requires a service restart, and a missing or modified catalog
causes startup and candidate validation to fail rather than falling back.

An older installed deployer may lack dependency installation or still check the
removed root `logging.mjs` and `attachment-storage.mjs`. It cannot update itself
until a release succeeds. Before deploying the modularized application, verify
that the installed deployer checks `src/` and `public/frontend/`; if it still
requires those removed files, bootstrap it from the reviewed, pushed commit.
Merely pushing the new script is insufficient:

```bash
# Replace with the reviewed full commit ID; do not export uncommitted files.
release_commit=REVIEWED_COMMIT_ID
git show "$release_commit:deploy/deploy.sh" > /tmp/for-now-deploy-reviewed
scp -i .secrets/for-now-deploy /tmp/for-now-deploy-reviewed \
  root@123.57.140.24:/tmp/for-now-deploy-reviewed
ssh -i .secrets/for-now-deploy root@123.57.140.24 \
  'install -o root -g root -m 0755 /tmp/for-now-deploy-reviewed /usr/local/sbin/for-now-deploy'
```

Then run the usual deploy command after checking that `main` still points to the
reviewed commit. These are future release instructions, not evidence of a
deployment. Local rollback control flow is covered by `npm run test:deploy`;
real systemd/Nginx recovery still requires target-environment validation.
Production RAM credentials have completed a real
`SegmentHDCommonImage → GetAsyncJobResult → PNG download` smoke test.

Log locations, retention, privacy and remaining operational checks are maintained
in `knowledge/observability.md`.

For local UI development against canonical cloud data:

```bash
UPSTREAM_ORIGIN=https://77liu.top/now ./启动.command
```

The local Node process serves local frontend files and proxies API, session, SSE,
and attachment traffic to the cloud.
