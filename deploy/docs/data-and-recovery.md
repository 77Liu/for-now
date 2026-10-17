# 生产媒体迁移、监控与恢复

从受审仓库根目录执行文中的相对路径命令；服务器命令须在已有授权覆盖范围内执行。返回[部署地图](../README.md)。

## Historical keepsake media migration

Legacy keepsakes are never rewritten during application startup. Stop the
application before applying a migration, load the same environment used by the
service, and first generate a read-only plan:

```bash
sudo -u for-now /bin/bash -c '
  set -a
  source /etc/for-now.env
  set +a
  cd /opt/for-now/app
  /usr/local/bin/npm run migrate:keepsake-media -- --dry-run
'
```

Review the per-account blocked count and retain the printed `planSha256`. Apply
only that exact plan:

```bash
sudo -u for-now /bin/bash -c '
  set -a
  source /etc/for-now.env
  set +a
  cd /opt/for-now/app
  /usr/local/bin/npm run migrate:keepsake-media -- --apply \
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

Actual thresholds come from the service environment and monitor implementation. Current capacity and restore evidence are referenced by the control plane; operational procedures are indexed in [operations](../../knowledge/operations-capacity.md).
