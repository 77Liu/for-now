# PostgreSQL 本机验证历史与环境诊断

2026-10-17 从系统测试正文迁出的原始说明。以下“当前”、通过/失败和版本均指原记录时点，保留其差异，不代表新候选状态。操作前按[当前 PostgreSQL 测试入口](../testing/postgres.md)核验实际工具；旧结果不能覆盖新失败。

## 真实 PostgreSQL 专项

修改映射、schema、导入或数据库 repository 时，除默认 `test:backend` 中的映射回归外，必须运行 `npm run test:postgres`。该命令是独立数据库环境门禁，不以 mock 通过代替，也不静默跳过缺失环境。

项目级稳定入口为：

```bash
npm run test:postgres:preflight
npm run test:postgres:stable
```

预检按以下优先级选择工具链：

1. 当前命令显式传入的 `PG_TEST_BIN`。
2. 项目忽略目录 `data/pg-integration-tools/postgresql-16.14/bin`。
3. 已验证的临时兼容构建 `/tmp/for-now-postgresql-16.14/bin`。
4. `@embedded-postgres` 的当前平台二进制。

预检要求 `postgres`、`initdb`、`pg_ctl` 均可执行且主版本为 16。预检失败时
不得启动业务验收，也不得重复尝试已经确认会失败的 locale、PID 清理或同一
二进制启动方案；应先恢复上述固定工具链。`test:postgres` 保留为显式指定
`PG_TEST_BIN` 后的底层入口，自动化和人工执行优先使用 `test:postgres:stable`。

项目内工具链目录只保存本机测试环境，受 `.gitignore` 保护，不进入提交、
发布制品或生产环境。它必须来自下文已核验源码和构建参数，不能以修改
PostgreSQL 业务保护逻辑或连接现存生产数据库代替。

测试始终自行创建本机临时集群、随机端口和随机密码，仅监听 `127.0.0.1`；忽略 `DATABASE_URL`，不连接已有数据库。用管理角色建表，再用 `NOSUPERUSER / NOBYPASSRLS` 且不拥有表的角色导入。成功或失败后关闭集群、删除临时数据。它验证功能正确性，不是压测。

已有 PostgreSQL 时指定 `PG_TEST_BIN=/absolute/path/to/bin`。当前 macOS arm64 验证使用 PostgreSQL 16.14，二进制包固定为 `@embedded-postgres/darwin-arm64@16.14.0-beta.17`，只安装在被忽略的 `data/pg-integration-tools` 下，不加入应用依赖：

```bash
npm install --prefix data/pg-integration-tools --no-audit --no-fund @embedded-postgres/darwin-arm64@16.14.0-beta.17
npm run test:postgres
```

其他平台提供该平台的 PostgreSQL `bin` 目录即可；脚本要求 `postgres`、`initdb`、`pg_ctl` 可执行。普通 `test:system` 不自动下载或安装数据库。`postgres-runtime-checks.mjs` 由该专项执行，启动真实 HTTP 应用，覆盖原子注册、数据/认证角色分离、跨连接并发、断连回滚、多次 commit、设置、附件上传/清理/中断恢复、进程重启、目录与数据库单写保护、只读恢复角色导出和第二数据库启动。任务专项使用本地模拟模型验证并发创建、回答/任务/通知共同保存、批注对话、未读与账户隔离、只恢复 queued，以及新数据库恢复后终态不重放。生产全账户快照、真实 OSS、云端备份与正式切换需在发布阶段另验。

macOS 文件沙箱可能遗漏依赖包的 dylib 符号链接。若 `postgres --version` 报 `Library not loaded`，依据包内 `native/pg-symlinks.json` 修复该隔离安装目录：已有软链接可替换为清单指定源库的普通文件副本，再运行测试。仅操作忽略目录 `data/pg-integration-tools`；不得因此修改系统库或跳过真实数据库验证。

专项脚本为数据库子进程固定 `LC_ALL=C`、`LANG=C`、`TZ=UTC`，并在 macOS 上将现有相邻 `lib` 目录传入 `DYLD_LIBRARY_PATH`，兼容沙箱重定位二进制；启动失败输出 PostgreSQL 日志后再清理临时簇。

2026-09-29 当前结论：原有 EDB PostgreSQL 16.14 和未修改的 `scripts/postgres-integration.mjs` 已在 Codex 获准的本机执行环境完整通过（退出码 0），覆盖现有脚本全部断言，包括账户文档/成本并发隔离、版本化删除恢复、附件清理失败及重启、新数据库恢复。机器可读结果和三个测试脚本/数据库二进制 SHA-256 见 `docs/versions/v0.2.0/evidence/postgres-validation.json`。真实数据库启动不再阻塞当前脚本验收；S3 其余工作与 G 准入按唯一协调控制面执行。

同日 G1 复验中，当前受限执行环境内的 `npm run test:postgres` 与下述绝对 Node 命令均在业务断言前再次报 `postmaster became multithreaded during startup`。本段未修改 schema、映射或 repository，因此保留上述 40 项通过证据作为 S2 基线，不把本次环境失败记为业务回归通过；后续一旦修改持久化边界，仍须回到获准本机执行环境重跑。

S3-10 集成后又按约束单次执行 `npm run test:postgres`，仍在临时集群启动阶段命中相同错误，未进入业务断言。本轮只迁移状态/健康记录、前端无业务共享能力和 OpenAPI 分片，未修改 schema、映射或 repository；因此继续引用同日 40 项基线，但机器可读 S3-10 证据明确记为环境失败而非通过。S3-11/12 收口后再次单次复验，仍为相同的启动前环境失败；完整功能系统测试为 38/38 阶段通过（165661 ms）。

G2/I 集成将 Store 升至 v15，并新增行动、习惯、习惯打卡、反馈、验证台账对象及来源/父子关系映射，因此旧 40 项真实 PostgreSQL 基线不能替代本轮验收。2026-09-29 单次复验仍在任何业务断言前报 `postmaster became multithreaded during startup`，虽然 43/43 功能系统阶段通过，G2 正式门仍须在先前可用的获准本机环境重跑并取得新证据后才能关闭。详情见 `../docs/versions/v0.2.0/evidence/g2-i-integration.json`。

G2 R3 又新增持久幂等账本、生命周期/tombstone 元数据和跨体裁图片原文任务关系。2026-09-29 分别执行 `npm run test:postgres` 与 `node scripts/persistence-ledger-postgres-regression.mjs`，两者仍在任何业务断言前由 PostgreSQL 16.14 报 `postmaster became multithreaded during startup`；脚本已固定 `LC_ALL=C`、`LANG=C`、`TZ=UTC`，追加 `OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES` 复跑仍失败。因此本轮 JSON、映射和功能系统证据可用于代码验收，但不能替代 P0-16/P0-26 的最新真实 PostgreSQL 运行证据。

2026-09-30 G2 R4 解阻：macOS 26.6.2 上的最小原生 C 进程在进入应用代码前即返回
`pthread_is_threaded_np()=1`，原嵌入式 PostgreSQL 和官方源码默认构建都会因此
触发同一保护。仅用于隔离本地测试时，使用官方 PostgreSQL 16.14 源码并在
configure 探测阶段声明该 API 不可用；不得把此构建用于生产。源码包
SHA-256 为 `f6d077142737920858ce958ccdb75c6ee137a63b5b0853c70693d401ac7e3471`：

```bash
curl -fsSL https://ftp.postgresql.org/pub/source/v16.14/postgresql-16.14.tar.bz2 -o /tmp/postgresql-16.14.tar.bz2
printf '%s  %s\n' \
  f6d077142737920858ce958ccdb75c6ee137a63b5b0853c70693d401ac7e3471 \
  /tmp/postgresql-16.14.tar.bz2 | shasum -a 256 -c -
tar -xjf /tmp/postgresql-16.14.tar.bz2 -C /tmp
cd /tmp/postgresql-16.14
ac_cv_func_pthread_is_threaded_np=no ./configure \
  --prefix=/tmp/for-now-postgresql-16.14 \
  --without-icu --without-readline --without-zlib
make -j8
make install
cd -
PG_TEST_BIN=/tmp/for-now-postgresql-16.14/bin npm run test:postgres
```

该路径实际通过 PostgreSQL 16.14 全门禁和独立持久幂等专项。主门禁现覆盖
Store v18（含证据/许可/感知事件与日压缩摘要）新领域、元数据顺序与扩展字段、JSON `null` 幂等响应、旧表从账户
快照精确升级、全量关系恢复对比、自动回答默认关闭、设置并发、治理中台
PostgreSQL 脱敏快照和小物派生路径；机器证据见
`../docs/versions/v0.2.0/evidence/g2-r4-postgres.json`。生产仍必须
使用受支持的标准 PostgreSQL 构建，本地兼容构建不构成生产配置或切换证据。

2026-10-06 V0.5.8 G4 复验：目标工作树默认发现路径未命中，但显式设置
`PG_TEST_BIN=./data/pg-integration-tools/postgresql-16.14/bin`
后预检通过，版本为 PostgreSQL 16.14。随后 `test:postgres:stable` 在真实
数据库业务阶段以退出码 1 停止：AI budget 的 3 项检查通过，
`postgres-integration.mjs` 因当前 Node 进程与 `sharp` 原生模块 Team ID
不同而得到 `IMAGE_PROCESSOR_UNAVAILABLE`，ledger 专项因 `&&` 短路未运行。
25 个 PostgreSQL 相关文件的 manifest 前后均为
`bf9cf4886b09b90bb349d3c7b2ae9d65d92b1474f69aa19988db0b86faf90116`；
未连接生产且临时集群已清理。该结果证明工具路径可用，但不能关闭 G4；后续应
使用现有 ad-hoc 签名 Node 隔离入口消除 `sharp` 环境冲突后，对固定候选重跑
完整 stable 门，不修改业务断言或阈值。

同日按上述既有 `scripts/test-node-binary.mjs` 方案，将当前 Node 复制到系统临时
目录并 ad-hoc 签名，再把该目录中的 `node` 置于 `PATH` 首位，使用相同
`PG_TEST_BIN` 重跑 `npm run test:postgres:stable`，退出码为 0。AI budget
PostgreSQL 3 项、主 PostgreSQL 集成 46 项及 lifecycle/idempotency 的精确重放、
冲突、永久清理、重启和跨进程序列化均通过；临时 Node 与数据库集群已清理。
因此 V0.5.8 的 G4 PostgreSQL stable 子门可关闭。该证据绑定上述 25 文件
manifest；F4.2 同期只修改浏览器模块和测试，不改变数据库候选。

复现命令（macOS Terminal 中运行，或在 Codex 中批准本机端口访问后执行）：

```bash
cd "$(git rev-parse --show-toplevel)"
node scripts/postgres-integration.mjs
```

Node.js 20+ 和 npm 必须在 `PATH` 中；也可直接运行 `npm run test:postgres`。测试自建临时数据库、随机密码和随机端口，结束后自动关闭并清理，不使用生产连接。除上述 macOS 26 本地兼容构建外，不得修改数据库保护检查或接入现有数据库。

历史诊断边界：此前 Trae 执行环境中的多线程退出已由 `data/s3-postgres-clean-process-retry.log` 等日志确认；固定 locale、显式 arm64、清理残留项目进程均未解决。此次 Codex 默认沙箱先报 `listen EPERM 127.0.0.1`，获准执行后原测试成功。两种错误不能混为一谈；现有证据证明有可用执行路径，但尚未定位 Trae 内创建线程的具体库/机制，不能声称已修复 Trae 本身。后续若 Trae 仍失败，直接使用上述获准路径完成专项验证，不再重复改 locale/PID。不得扫描现存 postmaster 自动跳过启动；任何未来外部数据库模式必须显式验证测试用途、版本、权限与隔离并清理本次资源。
