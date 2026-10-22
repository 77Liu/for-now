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
- Preview uses `MemoryHigh=384M` and `MemoryMax=512M`; changes require a capacity review against the actual host and production resource usage; do not infer current capacity from old deployment notes.
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
The host must provide `/usr/bin/ffmpeg` so M4A recordings can be normalized
before ASR; Preview deployment fails closed when it is absent.
Endpoint overrides, when present, must equal the reviewed official endpoints.
OSS attachment keys, monitoring webhooks, platform tokens, local-test controls,
and arbitrary Node options are not accepted.

## One-time installation

See [isolated installation](docs/preview-setup.md#one-time-installation).

## Deploy

See [candidate deployment](docs/preview-release.md#deploy); the branch must match the approved SHA.

## Rollback

See [explicit rollback](docs/preview-release.md#rollback). Production code, service, environment, and data are never rollback targets.

## Verification

See [local simulation and authorized live checks](docs/preview-release.md#verification). Test selection and authorization follow the [test matrix](../knowledge/test-impact-matrix.md) and [release policy](../knowledge/release-authorization-policy.md); this map grants neither.
