# Online Preview deployment

The online Preview is an isolated release lane at
`https://77liu.top/preview/`. It runs on `127.0.0.1:4175` and must not reuse
production code, configuration, service state, credentials, or data.

| Resource | Preview value |
| --- | --- |
| Active code symlink | `/opt/for-now-preview/app` |
| Bare mirror | `/opt/for-now-preview/repository.git` |
| Immutable releases | `/opt/for-now-preview/releases` |
| Runtime data | `/srv/for-now-preview/data` |
| Environment | `/etc/for-now-preview.env` |
| systemd unit | `for-now-preview.service` |
| Nginx snippet | `/etc/nginx/snippets/for-now-preview.conf` |
| Installed deployer | `/usr/local/sbin/for-now-preview-deploy` |

`/opt/for-now-preview/app` is the Preview `current` pointer. The deployer also
maintains `/opt/for-now-preview/previous` for an explicit rollback.

## Isolation contract

- Only a `preview/*` branch can be deployed.
- The runtime user is `for-now-preview`, not the production `for-now` user.
- Preview uses its own read-only deploy key and bare mirror.
- Preview always uses JSON persistence and local attachments under
  `/srv/for-now-preview/data`.
- Preview uses `MemoryHigh=384M` and `MemoryMax=512M`; do not raise it to the
  production 768 MiB ceiling on the current 1608 MiB, no-Swap host.
- The deployer never reads, writes, restarts, enables, or disables
  `/opt/for-now/app`, `/etc/for-now.env`, `for-now.service`, or
  `/srv/for-now/data`.
- No production data copy or database connection belongs in Preview.
- Provider credentials are opt-in Preview credentials. They are never imported
  from `/etc/for-now.env`.

The environment parser rejects unknown keys, duplicates, malformed lines, and
all occurrences of `DATABASE_URL`, `AUTH_DATABASE_URL`,
`AI_BUDGET_DATABASE_URL`, and `UPSTREAM_ORIGIN`. These values are mandatory:

```text
NODE_ENV=production
PORT=4175
DATA_DIR=/srv/for-now-preview/data
APP_BASE_PATH=/preview
PERSISTENCE_BACKEND=json
ATTACHMENT_STORAGE=local
AUTH_REQUIRED=1
COOKIE_SECURE=1
```

`INVITE_CODE_HASH` must be a Preview-only lowercase SHA-256 digest. Supported
DeepSeek, Volcengine, and Alibaba Cloud keys are explicitly allowlisted.
Endpoint overrides, when present, must equal the reviewed official endpoints.
OSS attachment keys, monitoring webhooks, platform tokens, local-test controls,
and arbitrary Node options are not accepted.

## One-time installation

Perform these steps from a reviewed checkout. They are server instructions, not
evidence that this repository has been deployed.

1. Create the isolated account, directories, and deploy key:

   ```bash
   sudo useradd --system --create-home --home-dir /home/for-now-preview \
     --shell /usr/sbin/nologin for-now-preview
   sudo install -d -o root -g for-now-preview -m 0750 \
     /opt/for-now-preview /opt/for-now-preview/releases
   sudo install -d -o for-now-preview -g for-now-preview -m 0700 \
     /opt/for-now-preview/repository.git /srv/for-now-preview/data \
     /home/for-now-preview/.ssh
   sudo -u for-now-preview ssh-keygen -q -t ed25519 -N "" \
     -C "for-now-preview-server-deploy" \
     -f /home/for-now-preview/.ssh/gitee_deploy
   ```

2. Register only the printed Preview public key as a read-only Gitee deploy
   key. Do not reuse the production private key.

3. Install and edit the Preview environment:

   ```bash
   sudo install -o root -g root -m 0600 \
     deploy/for-now-preview.env.example /etc/for-now-preview.env
   sudoedit /etc/for-now-preview.env
   ```

4. Install the reviewed Preview assets without starting the service:

   ```bash
   sudo install -o root -g root -m 0644 deploy/for-now-preview.service \
     /etc/systemd/system/for-now-preview.service
   sudo install -o root -g root -m 0644 deploy/nginx-for-now-preview.conf \
     /etc/nginx/snippets/for-now-preview.conf
   sudo install -o root -g root -m 0755 deploy/deploy-preview.sh \
     /usr/local/sbin/for-now-preview-deploy
   ```

5. Compare the active Nginx site with `deploy/nginx-dysf.conf`. The only
   Preview integration in the production HTTPS server is:

   ```nginx
   include /etc/nginx/snippets/for-now-preview*.conf;
   ```

   The wildcard keeps production Nginx valid before the Preview snippet exists.
   Install the reviewed site file only after confirming the `/now` upstream is
   still exactly `127.0.0.1:4173`:

   ```bash
   sudo cp -p /etc/nginx/sites-available/dysf \
     /etc/nginx/sites-available/dysf.before-preview
   sudo install -o root -g root -m 0644 deploy/nginx-dysf.conf \
     /etc/nginx/sites-available/dysf
   sudo systemctl daemon-reload
   sudo nginx -t
   sudo systemctl reload nginx
   ```

The snippet returns 404 for `/preview/api/admin/v1/snapshot`, serves
precompressed text assets with `gzip_static`, and adds
`X-Robots-Tag: noindex, nofollow, noarchive` to every Preview location. It does
not alter `/now` or its upstream.

## Deploy

Publish an explicitly reviewed branch under `preview/*`, then run:

```bash
sudo DEPLOY_BRANCH=preview/v0.5.0 for-now-preview-deploy deploy
```

The deployer fetches the independent bare mirror, archives the branch commit
into a new candidate, runs `npm ci --omit=dev`, checks JavaScript and shell
syntax, validates the versioned Prompt catalog, and creates deterministic gzip
files for public text assets. Only a completed immutable candidate receives a
`.preview-deploy-ready` marker.

After candidate validation it snapshots Preview-managed configuration, installs
the Preview unit/snippet/deployer, atomically switches
`/opt/for-now-preview/app`, restarts only `for-now-preview.service`, and polls:

```text
http://127.0.0.1:4175/preview/readyz
```

Nginx reloads only after readiness succeeds. Re-running the same branch commit
reuses the marked immutable release and does not run `npm ci` again.

## Rollback

Roll back to the recorded previous Preview release:

```bash
sudo DEPLOY_BRANCH=preview/v0.5.0 for-now-preview-deploy rollback
```

Or select a completed release by its full 40-character commit:

```bash
sudo DEPLOY_BRANCH=preview/v0.5.0 \
  for-now-preview-deploy rollback REVIEWED_PREVIEW_COMMIT
```

Rollback uses the same atomic switch, restart, and readiness gate. A failed
deploy or failed rollback restores only the former Preview symlink, Preview
environment version, Preview service/snippet/deployer, and prior Preview
service state. If no former Preview release exists, the Preview service is
stopped. Production code, service, environment, and data are never rollback
targets.

## Verification

Run the local simulation before installation:

```bash
npm run test:deploy:preview
```

The regression uses command shims and temporary directories. It performs no
network request, deployment, push, provider call, or remote command. It covers
installation, candidate validation, static gzip, same-commit idempotency,
explicit rollback, health-failure rollback, branch/env rejection, and byte-level
production symlink/service/env/data isolation.

After an authorized real installation, separately verify:

```bash
curl -fsS http://127.0.0.1:4175/preview/readyz
curl -fsSI https://77liu.top/preview/ | grep -i x-robots-tag
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://77liu.top/preview/api/admin/v1/snapshot
sudo systemctl status for-now-preview.service
```

The expected snapshot status is `404`. Real installation and live verification
require a separate deployment authorization.

Run browser journeys against the public Preview URL with the explicit remote
guard. Credentials stay in the process environment and must not be committed:

```bash
E2E_ALLOW_REMOTE_PREVIEW=1 \
E2E_APP_URL=https://77liu.top/preview/ \
E2E_USERNAME=... E2E_PASSWORD=... \
npm run test:journeys:live -- verify
```

The live journey runner accepts no other public origin or path.
