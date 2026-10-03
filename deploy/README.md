# Cloud deployment

The cloud service is the canonical data source. Code is deployed from Gitee;
runtime data lives only in `/srv/for-now/data`; OSS receives consistent backup
archives. Never synchronize a live data directory in both directions.

The isolated online Preview has separate code, service, environment, and data
boundaries. Its installation, deploy, rollback, and verification procedure is
documented in [`README-preview.md`](README-preview.md).

The current production backend is PostgreSQL 16.15. This candidate requires
separate data/auth/AI-budget/recovery roles, offline export, and a protected
single-write boundary documented in
[`knowledge/postgres-migration.md`](../knowledge/postgres-migration.md).
Generic deploy rollback rejects a PostgreSQL configuration if either candidate
or previous code lacks the runtime adapter. PostgreSQL backups require
`PG_BACKUP_DATABASE_URL`; the cloud restore drill validates the exported logical
JSON and attachments, while a fresh-database restore remains a separate gate.

The `for_now` database contains the migrated production state. Existing
schema-admin, migration, runtime-data, runtime-auth, and read-only recovery
logins have passed production privilege checks. This candidate additionally
requires a runtime-budget login and `AI_BUDGET_DATABASE_URL`; provision and
verify them before deployment. Credentials remain only in root-owned
`0700/0600` server files and connection URLs in `/etc/for-now.env`. PostgreSQL
starts automatically, and `/srv/for-now/data/.persistence-mode.json` prevents
direct reuse of the stale JSON write source. Cutover and recovery evidence is
recorded in
[`reports/v0.2.1-production-cutover-2026-09-30.json`](../reports/v0.2.1-production-cutover-2026-09-30.json).

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
   Keep `INCREMENTAL_SYNC_ENABLED=1` for the normal client cursor-polling path.
   Set it to `0` only as a temporary frontend rollback: durable writes continue
   to use the same API and server-side sync ledger, while the browser falls back
   to the existing write-followed-by-refresh behavior. After changing it,
   restart the application and verify that “我的 → 同步状态” reports that
   incremental sync is disabled before admitting traffic.
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

`prepare-server.sh` does not install or provision PostgreSQL. Before the v0.2.0
cutover, choose a PostgreSQL 16 host, verify its capacity and network/TLS
boundary, and create the separate schema-admin, migration, runtime-data,
runtime-auth, and read-only recovery roles described in
[`knowledge/postgres-migration.md`](../knowledge/postgres-migration.md). Do not
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

## Historical keepsake media migration

Legacy keepsakes are never rewritten during application startup. Stop the
application before applying a migration, load the same environment used by the
service, and first generate a read-only plan:

```bash
sudo -u for-now /bin/bash -c '
  set -a
  source /etc/for-now.env
  set +a
  npm run migrate:keepsake-media -- --dry-run
'
```

Review the per-account blocked count and retain the printed `planSha256`. Apply
only that exact plan:

```bash
sudo -u for-now /bin/bash -c '
  set -a
  source /etc/for-now.env
  set +a
  npm run migrate:keepsake-media -- --apply \
    --expected-plan-sha256 REVIEWED_SHA256
'
```

For OSS, dry-run requires both the original and legacy cutout in primary object
storage; a local fallback does not count as migration evidence. Apply creates
the four WebP derivatives and updates the record only if its paths and versions
still match the reviewed plan. It preserves the old `cutoutPath` and object for
rollback. Final deletion requires a later backup, restore drill, observation
window, and separate approval.

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
healthy application restart. JSON mode reads account usage files; PostgreSQL
mode requires `PG_BACKUP_DATABASE_URL` and reads usage through that cross-schema
SELECT-only role. A PostgreSQL read failure fails the monitor run instead of
silently reporting zero cost. Test the Feishu channel without printing its
webhook or secret:

```bash
sudo /bin/bash -c '
  set -a
  source /etc/for-now.env
  set +a
  release=$(readlink -f /opt/for-now/app)
  cd "$release"
  exec runuser --preserve-environment -u for-now -- \
    /usr/local/bin/node scripts/monitor-health.mjs --test-alert
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
JavaScript and the versioned prompt catalog, then runs a read-only PostgreSQL
runtime preflight when `PERSISTENCE_BACKEND=postgres`. The preflight verifies
that data, auth and AI-budget connections use distinct compatible roles, that
the budget singleton exists, and that each role has exactly its permitted
privileges. Only then does deployment mark the immutable release ready, switch
the active symlink, restart systemd, and check `/readyz`. Re-running the same
commit never runs `npm ci` inside the active release. Failure after configuration
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
