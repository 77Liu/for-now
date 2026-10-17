# Preview 首次安装

从受审仓库根目录执行文中的相对路径命令；服务器命令须在已有授权覆盖范围内执行。返回[部署地图](../README.md)。

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
   sudo /bin/bash deploy/install-release-fence.sh
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
