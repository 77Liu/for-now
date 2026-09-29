# 正式域名 HTTPS 切换记录

- 日期：2026-09-29
- 版本归属：v0.2.0 运维交付
- 生产应用版本：`v0.1.1 / 54a6326f14ca`

## 结论

`77liu.top` 已成为正式公网入口。域名 HTTPS 使用名称匹配的 Let's
Encrypt 证书，域名 HTTP 与公网 IP HTTPS 均返回 308 并跳转到
`https://77liu.top`。本次只更新并平滑重载 Nginx，没有重启 Node、
修改生产数据或发布 v0.2.0 应用代码。

## 原因

DNS 已将 `77liu.top` 解析到 `123.57.140.24`，但切换前 Nginx 只配置
公网 IP 证书。该证书仅包含 `IP Address:123.57.140.24`，不包含
`DNS:77liu.top`，所以浏览器访问域名时返回
`NET::ERR_CERT_COMMON_NAME_INVALID`。

DNS 只负责把域名解析为 IP；浏览器仍会独立核对服务器证书中的名称。
为域名签发证书并由 Nginx 在域名虚拟主机中加载后，浏览器才能同时
确认服务身份、建立加密通道并校验传输完整性。

## 变更

- `deploy/nginx-dysf.conf`：域名 443 使用
  `/etc/letsencrypt/live/77liu.top/fullchain.pem` 与 `privkey.pem`。
- 公网 IP 443 保留原 IP 证书，只负责可信地 308 跳转到正式域名。
- 80 端口保留 ACME challenge，其余请求统一 308 跳转到正式域名 HTTPS。
- `deploy/deploy.sh`：域名和 IP 的证书、公钥文件全部存在时才安装仓库
  中的站点配置，避免后续应用部署破坏已上线的证书路由。
- 默认公网地址、本地上游地址、架构和部署说明统一改为 `77liu.top`。
- `scripts/deploy-regression.mjs`：验证双证书存在时会安装仓库中的域名
  Nginx 配置，并继续覆盖 Nginx 失败后的原子回滚。

## 生产证据

- DNS：`77liu.top -> 123.57.140.24`。
- `https://77liu.top/now/`：HTTP 200，TLS 校验结果为 0。
- `http://77liu.top/now/`：HTTP 308，`Location:
  https://77liu.top/now/`。
- `https://123.57.140.24/now/`：HTTP 308，`Location:
  https://77liu.top/now/`。
- 域名证书：`CN=77liu.top`，SAN 为 `DNS:77liu.top`，签发者为 Let's
  Encrypt `YE1`，有效期为 2026-09-29 至 2026-12-28。
- `certbot renew --dry-run`：成功。
- Certbot 自动续期 timer：已启用。
- `/now/readyz`：仍返回生产应用版本 `54a6326f14ca`。
- 本地 `npm run test:deploy`：通过域名配置安装及既有失败回滚断言。
- 本地 `npm run test:system --silent`：43/43 阶段通过，耗时 156460 ms。

## 回滚与发布边界

- 切换前生产配置备份：
  `/etc/nginx/sites-available/dysf.before-domain-20260929-175523`。
- Nginx 配置变更先通过 `nginx -t`，再执行平滑 reload。
- 域名基础设施已上线，但 v0.2.0 应用仍处于未提交、未推送、未部署状态。
- v0.2.0 正式发布前仍需复核证书有效期、Certbot timer、HTTP/IP 跳转和
  `nginx -t`；其余人工配置、PostgreSQL、备份恢复、Git/Gitee 发布及
  应用观察门禁不因本次域名切换而关闭。
