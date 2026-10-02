import { promises as fs } from "node:fs";

const architectureMarkup = await fs.readFile(new URL("./architecture.html", import.meta.url), "utf8");
const commercializationMarkup = await fs.readFile(new URL("./commercialization.html", import.meta.url), "utf8");

const architectureStages = [
  {
    name: "内部验证期", tab: "内部验证", scale: "MAU ≤ 20", peak: "< 2 QPS", availability: "人工保障", cost: "约 ¥200–520/月", state: "当前运行",
    note: "全部能力集中在一台 ECS；请求经过 Nginx 后直接进入 Node 单体。",
    mainPath: [["用户", "浏览器 / PWA", "active"], ["Nginx", "HTTPS + 静态文件", "active"], ["Node 主服务器", "2 vCPU / 1.57 GiB 可见", "focus"]],
    supports: [
      ["后台任务", [["进程内任务执行器", "AI 并发 ≤ 20", "active"], ["DeepSeek / 图片服务", "外部供应商", "active"]]],
      ["数据", [["JSON + ESSD", "40 GB", "active"], ["私有 OSS", "附件按量使用", "active"]]],
      ["监控恢复", [["云监控 + 日志", "同机采集", "active"], ["每日备份", "OSS + 恢复演练", "active"]]]
    ],
    layers: [
      ["前端", "Nginx 同机", "静态 HTML/CSS/JS 与 API 同一台机器", "用户少，独立 CDN 收益有限。"],
      ["防火墙", "安全组 + Nginx", "只开放 80/443；SSH 限定来源", "先保证最小公网暴露。"],
      ["流量分发", "暂不需要 ALB", "DNS 直接指向主服务器", "只有一台服务器，无处可分发。"],
      ["主服务器", "Node 单体 · 2 vCPU / 1.57 GiB 可见", "认证、API、AI 调度、静态文件", "使用 2026-09-27 生产只读观测值。"],
      ["后台任务", "同进程任务执行器", "持久任务 + 内存调度、限并发、失败可见", "任务少时先保证正确性。"],
      ["数据", "JSON + 40 GB ESSD", "OSS 存图片和附件", "整文件写入是主要扩容瓶颈。"],
      ["监控", "云监控 + 本机日志", "服务、磁盘、备份和 AI 费用告警", "不需要单独购买监控服务器。"],
      ["备份灾备", "每日快照 + OSS 备份", "定期隔离恢复", "备份成功不等于可以恢复。"]
    ],
    enter: ["先完成正确性", "备份恢复与跨账户隔离必须稳定。"],
    defer: ["不拆微服务", "暂不上 RDS、Redis、消息队列和 Kubernetes。"]
  },
  {
    name: "MVP 内部推送", tab: "MVP 推送", scale: "DAU 100 · MAU 400", peak: "5–10 QPS", availability: "99.5% 内部目标", cost: "约 ¥1.7k–4.5k/月", state: "规划",
    note: "前端独立发布，API 与 Worker 分机；PostgreSQL 接管正式数据和任务。",
    mainPath: [["用户", "浏览器 / PWA", "active"], ["CDN", "静态文件", "active"], ["WAF / Nginx", "基础防护", "active"], ["API 主服务器", "1 × 2C4G", "focus"]],
    supports: [
      ["后台任务", [["PG 任务表", "租约 / 重试", "active"], ["Worker 服务器", "1 × 2C4G", "focus"], ["AI 供应商", "模型 / 图片", "active"]]],
      ["数据", [["RDS PostgreSQL", "2C4G · 100 GB", "focus"], ["私有 OSS", "100–500 GB", "active"]]],
      ["监控恢复", [["SLS + 云监控", "集中日志", "active"], ["PITR + OSS 版本", "月度恢复", "active"]]]
    ],
    layers: [
      ["前端", "OSS + CDN", "静态前端独立构建发布", "前端更新不再重启 API。"],
      ["防火墙", "WAF 基础规则", "安全组与 VPC 白名单", "数据库和 Worker 不暴露公网。"],
      ["流量分发", "Nginx 单入口", "暂不购买多实例 ALB", "API 仍只有一个实例。"],
      ["主服务器", "API ECS · 1 × 2C4G", "模块化单体与 /api/v1", "只处理快速请求。"],
      ["后台任务", "Worker ECS · 1 × 2C4G", "AI、图片、索引和定时任务", "慢任务不占住 API。"],
      ["数据", "RDS PG · 2C4G / 100GB", "事务、版本与账户隔离", "JSON 只保留为迁移恢复点。"],
      ["监控", "SLS + 云监控", "汇总 API、Worker、RDS 与任务终态", "使用托管服务，不自建监控机。"],
      ["备份灾备", "RDS PITR + OSS 版本", "月度恢复演练", "目标是可恢复，不是多区域。"]
    ],
    enter: ["先迁移数据底座", "OpenAPI、幂等和 3 份真实快照 dry-run 通过。"],
    defer: ["不做多实例", "暂不上读副本、分片和跨区域。"]
  },
  {
    name: "快速上升期", tab: "快速上升", scale: "DAU 1 万 · MAU 4 万", peak: "20–80 QPS", availability: "99.9% 设计目标", cost: "约 ¥62k–150k/月", state: "规划",
    note: "ALB 把请求分给无状态 API 池；消息队列把慢任务交给弹性 Worker 池。",
    mainPath: [["用户", "浏览器 / PWA", "active"], ["CDN", "全国静态节点", "active"], ["WAF", "入口防火墙", "active"], ["ALB", "健康分发", "focus"], ["API 服务器池", "2–4 × 4C8G", "focus"]],
    supports: [
      ["后台任务", [["MNS / RocketMQ", "削峰 / 死信", "active"], ["Worker 池", "4–12 × 4C8G", "focus"], ["AI 网关", "配额 / 重试", "active"]]],
      ["数据", [["RDS PG HA", "8C32G · 500 GB", "focus"], ["Redis HA", "2–4 GB", "active"], ["OSS + CDN", "2 TB / 3–10 TB流量", "active"]]],
      ["监控恢复", [["SLS + ARMS", "链路 / SLO / 成本", "active"], ["PITR + 跨区备份", "月度自动恢复", "active"]]]
    ],
    layers: [
      ["前端", "CDN 全国节点", "静态资源、附件缓存与版本发布", "降低源站带宽和访问延迟。"],
      ["防火墙", "WAF + 安全组", "限速、Bot 和常见 Web 攻击", "公网只到 ALB，内部走 VPC。"],
      ["流量分发", "ALB", "TLS、健康检查、轮询分发", "任一 API 故障会被自动绕开。"],
      ["主服务器", "API 池 · 2–4 × 4C8G", "自动伸缩上限约 6 台", "实例无状态，配置和会话共享。"],
      ["后台任务", "Worker 池 · 4–12 × 4C8G", "消息队列、死信、优先级", "按排队时长和供应商配额扩缩。"],
      ["数据", "RDS HA + Redis + OSS", "8C32G / 500GB；Redis 2–4GB", "Redis 只存缓存、限流和短租约。"],
      ["监控", "SLS + ARMS/APM", "黄金信号、队列、Token 与成本", "监控不进入业务主路径。"],
      ["备份灾备", "PITR + 跨区备份", "月度自动、季度人工恢复", "先实现单区域高可靠。"]
    ],
    enter: ["单机指标触顶", "CPU >70% 或事件循环 P95 >100ms，并通过峰值 5 倍压测。"],
    defer: ["不做跨区双写", "暂不分片，也不引入独立向量库。"]
  },
  {
    name: "影响力期", tab: "影响力", scale: "DAU 2.5 万 · MAU 10 万", peak: "80–200 QPS", availability: "99.9% · RPO 5m", cost: "约 ¥150k–380k/月", state: "规划",
    note: "多可用区 API 和 Worker 自动扩缩；数据库、缓存、队列与监控均消除单点。",
    mainPath: [["用户", "浏览器 / PWA", "active"], ["CDN + WAF", "边缘缓存与防护", "active"], ["ALB 标准版", "多可用区", "focus"], ["API 弹性池", "4–10 × 8C16G", "focus"]],
    supports: [
      ["后台任务", [["托管 MQ", "优先级 / 背压", "active"], ["Worker 弹性池", "8–24 × 8C16G", "focus"], ["AI 网关", "熔断 / 降级", "active"]]],
      ["数据", [["PG 集群", "16C64G · 1 TB", "focus"], ["只读副本", "读瓶颈后启用", "active"], ["Redis 集群", "8–16 GB", "active"]]],
      ["监控恢复", [["SLS + ARMS + 大盘", "SLO / 容量预测", "active"], ["跨区备份", "RTO 60m 设计目标", "active"]]]
    ],
    layers: [
      ["前端", "CDN + WAF", "HTTPS、静态缓存与边缘防护", "入口承受突发流量。"],
      ["防火墙", "WAF + 云防火墙", "公网区、应用区、数据区隔离", "统一安全策略和出口控制。"],
      ["流量分发", "ALB 标准版", "多可用区与 LCU 弹性", "按健康与权重分发。"],
      ["主服务器", "API 池 · 4–10 × 8C16G", "跨可用区自动扩缩", "滚动发布时至少保留 2 个实例。"],
      ["后台任务", "Worker 池 · 8–24 × 8C16G", "AI、图片、索引独立队列", "防止一种任务拖垮全部任务。"],
      ["数据", "PG 16C64G / 1TB", "读副本 + Redis 8–16GB", "读副本只在读 CPU 成瓶颈后启用。"],
      ["监控", "SLS + ARMS + Grafana", "SLO、追踪、成本与容量预测", "可有独立大盘，无需自建监控主机。"],
      ["备份灾备", "跨区备份 + 自动恢复验证", "RPO≤5m、RTO≤60m 设计目标", "实测达标后才能承诺。"]
    ],
    enter: ["共享资源触顶", "连接池 >70% 或最老任务等待 >30 秒。"],
    defer: ["不默认多活", "无容量证据时不拆微服务、不跨区写入。"]
  },
  {
    name: "市场占有期", tab: "市场占有", scale: "DAU 4.6 万 · MAU 18.4 万", peak: "150–400 QPS", availability: "99.95% 内部目标", cost: "约 ¥290k–730k/月", state: "规划",
    note: "GTM 在主区域和温备区域之间切换；区域内仍是相同的 API、Worker、数据与监控闭环。",
    mainPath: [["用户", "全国访问", "active"], ["CDN / ESA", "边缘加速", "active"], ["GTM + WAF", "区域切换与防护", "focus"], ["区域 ALB", "区内分发", "active"], ["主区 API 池", "6–16 × 8C16G", "focus"]],
    supports: [
      ["后台任务", [["区域队列", "背压 / 配额", "active"], ["Worker 池", "12–40 × 8C16G", "focus"], ["AI 网关", "供应商路由 / 降级", "active"]]],
      ["数据", [["PG 集群", "32C128G · 2 TB", "focus"], ["1–2 读副本", "分析 / 导出", "active"], ["异地温备", "DTS / PITR / OSS CRR", "active"]]],
      ["监控恢复", [["跨区监控", "独立告警通道", "active"], ["季度切换演练", "切换 / 回切 / 校验", "active"]]]
    ],
    layers: [
      ["前端", "CDN / ESA 全国边缘", "静态与动态加速、防护", "避免所有流量直达主区。"],
      ["防火墙", "WAF + 云防火墙 + Anti-DDoS", "区域入口、VPC 分段和出口控制", "安全策略集中管理。"],
      ["流量分发", "GTM → 区域 ALB", "主区承载，灾备区健康待命", "故障时按演练流程切区。"],
      ["主服务器", "主区 API · 6–16 × 8C16G", "温备区维持 30%–50% 容量", "区域内无状态自动扩缩。"],
      ["后台任务", "Worker · 12–40 × 8C16G", "区域队列 + AI 网关", "统一模型配额、熔断和成本预算。"],
      ["数据", "PG 32C128G / 2TB", "读副本、Redis 16–32GB、OSS CRR", "单库优化后仍触顶才按账户分片。"],
      ["监控", "跨区 SLS/ARMS", "独立于主区的告警通道", "主区故障时仍必须能告警。"],
      ["备份灾备", "异地温备 PG + OSS CRR", "季度切换、回切和一致性校验", "默认异步复制并明确 RPO。"]
    ],
    enter: ["恢复能力不足", "单库接近容量或存在地域合规要求。"],
    defer: ["不跨区双写", "账户数量本身不是分片理由。"]
  }
];

const architectureTerms = {
  worker: ["Worker", "后台工作进程", "不接网页请求，专门执行 AI、图片、索引、通知和定时任务。", "公司的后厨", "MVP 开始持久化慢任务时"],
  pg: ["PG", "PostgreSQL 数据库", "保存账户、记录、任务和版本；事务保证一组操作全部成功或全部失败。", "正式总账", "替换 JSON 数据源时"],
  cdn: ["CDN", "内容分发网络", "把前端文件和图片缓存到离用户更近的节点，减少源站流量和等待。", "全国前置仓", "出现异地用户或静态流量时"],
  waf: ["WAF", "Web 应用防火墙", "检查 HTTP 请求，拦截常见攻击、恶意扫描、Bot 和异常频率。", "入口安检", "公开邀请用户前"],
  alb: ["ALB", "应用负载均衡", "检查 API 服务器健康状态，把请求分给可用实例，并绕开故障实例。", "银行取号分柜台", "API 增加到两台时"],
  queue: ["MQ", "消息队列", "可靠保存待执行任务，削平高峰，并支持重试、优先级和死信。", "待办传送带", "任务积压或突发明显时"],
  redis: ["Redis", "高速临时数据服务", "保存缓存、共享限流和短租约；正式数据仍必须在 PostgreSQL。", "高速便签板", "多 API 实例共享状态时"],
  oss: ["OSS", "对象存储", "保存图片、附件和备份；数据库只保存对象编号、大小和引用。", "文件仓库", "当前阶段已经适用"],
  vpc: ["VPC", "云内私有网络", "让数据库、Redis 和 Worker 只通过内网访问，不直接暴露公网。", "园区内部道路", "引入托管数据服务时"],
  monitor: ["SLS / ARMS", "日志与应用监控", "收集延迟、流量、错误、CPU、队列、Token 和费用并触发告警。", "值班室", "从 Demo 就需要基础版本"],
  pitr: ["PITR", "时间点恢复", "利用数据库日志把数据恢复到故障或误操作发生前的某个时间。", "录像回放", "迁移 PostgreSQL 后"],
  rpo: ["RPO / RTO", "恢复目标", "RPO 是最多能丢多久的数据；RTO 是系统多久必须恢复。", "保险赔付标准", "准备对外承诺可靠性时"]
};

const commercialTagPattern = /^(?:商业|商业化|创业|创业点子|变现)$/u;
const commercialKeywordPattern = /(?:有偿用户|付费用户|商业化变现|订阅|成本核算|预期收益|愿付费)/u;
const commercialPaymentFactPattern = /(?:用户.{0,6}(?:已付款|已付费)|实际收入|收到.{0,4}元收入|完成收款|付费成交|用户续费|订阅成功)/u;
const commercialModelKeys = ["validation", "subscription", "delivery", "usagePack"];
const commercialProfileKeys = ["low", "medium", "high", "full"];
const commercialStages = [
  { name: "内部验证期", rationale: "验证需求与成本口径，不以规模或利润为目标。" },
  { name: "MVP 内部推送", rationale: "控制在可人工兜底的范围，验证留存、付费与交付标准化。" },
  { name: "快速上升期", rationale: "以 DAU 1 万为量级门槛，开始按团队、基础设施和获客效率核算。" },
  { name: "影响力期", rationale: "以 MAU 10 万、DAU 2.5 万为参考，要求自动化运营和稳定成本护栏。" },
  { name: "市场占有期", rationale: "按 1.84 亿 AI 生活助手用户中的 1% 可服务人群，再取得其中 10%：约 18.4 万 MAU。" }
];
const commercialStageScales = {
  validation: ["5 名定向体验者", "20 名邀请体验者", "100 名分批研究样本", "300 名多批次样本", "1,000 名长期研究样本"],
  subscription: ["DAU 5 · MAU 20", "DAU 100 · MAU 400", "DAU 1 万 · MAU 4 万", "DAU 2.5 万 · MAU 10 万", "DAU 4.6 万 · MAU 18.4 万"],
  delivery: ["4 单/月", "30 单/月", "800 单/月", "5,000 单/月", "15,000 单/月"],
  usagePack: ["10 名购买者/月", "80 名购买者/月", "4,000 名购买者/月", "15,000 名购买者/月", "36,800 名购买者/月"]
};

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
})[character]);
const formatCny = value => {
  const number = Number(value) || 0;
  const absolute = Math.abs(number);
  const digits = absolute === 0 ? 2 : absolute >= 100 ? 0 : absolute >= 10 ? 1 : absolute >= 1 ? 2 : absolute >= 0.1 ? 3 : absolute >= 0.01 ? 4 : 6;
  return `${number < 0 ? "-" : ""}¥${absolute.toFixed(digits)}`;
};
const formatInteger = value => Math.round(Number(value) || 0).toLocaleString("zh-CN");
const preview = value => String(value || "").replace(/[#*_`>[\]()]/g, " ").replace(/\s+/g, " ").trim();
const occurredAt = item => item?.occurredAt || item?.createdAt || "";
const dateOf = value => String(value || "").slice(0, 10);
const emptyEvidence = () => '<div class="content-state empty"><strong>还没有能确认的商业化原始记录。</strong></div>';
const kpiMarkup = items => items.map(([label, value, note, tone]) => `<article class="${escapeHtml(tone || "")}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`).join("");
const costRowsMarkup = rows => rows.map(([label, basis, amount, type]) => `<tr class="${escapeHtml(type || "")}"><td>${escapeHtml(label)}</td><td>${escapeHtml(basis)}</td><td>${escapeHtml(formatCny(amount))}</td></tr>`).join("");
const unitMarkup = items => items.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");

function commercialEvidence(store = {}) {
  const items = [];
  const add = (type, view, id, title, content, tags, date) => {
    const text = [title, content, ...(tags || [])].join(" ");
    if (!(tags || []).some(tag => commercialTagPattern.test(tag)) && !commercialKeywordPattern.test(text)) return;
    items.push({
      type,
      view,
      id,
      title: preview(title).slice(0, 80) || type,
      content: preview(content || title).slice(0, 320),
      tags: Array.isArray(tags) ? tags : [],
      date: date || ""
    });
  };
  for (const item of store.captures || []) add("捕念", "captures", item.id, preview(item.content).slice(0, 48), item.content, item.tags, occurredAt(item));
  for (const item of store.journals || []) add("日记", "journals", item.id, item.title || `${dateOf(occurredAt(item))} 日记`, item.content, item.tags, occurredAt(item));
  const roots = (store.thoughts || []).filter(item => item.type === "question");
  for (const root of roots) {
    const children = (store.thoughts || []).filter(item => item.relatedTo === root.id && item.authorType !== "ai" && ["idea", "record", "answer"].includes(item.type));
    add("思绪", "thoughts", root.id, root.content, [root.content, ...children.map(item => item.content)].filter(Boolean).join("\n"), [...(root.tags || []), ...children.flatMap(item => item.tags || [])], occurredAt(root));
  }
  for (const item of store.chats || []) add("共参", "together", item.id, item.message, item.message, [], occurredAt(item));
  for (const book of store.books || []) {
    for (const note of book.notes || []) add("书间", "books", book.id, book.title, note.content, [], occurredAt(note));
  }
  return items.sort((left, right) => String(right.date).localeCompare(String(left.date)));
}

function commercialAiBasis(assumptions, statistics) {
  const summary = statistics?.ai?.summary;
  const calls = Number(summary?.calls) || 0;
  const unknownCostCalls = Math.min(calls, Number(summary?.costUnknownCalls) || 0);
  const knownCalls = Math.max(0, calls - unknownCostCalls);
  const totalUsd = Number(summary?.costsUsd?.total) || 0;
  const totalCny = Number(summary?.costCny) || 0;
  const observed = knownCalls ? (totalUsd * Number(assumptions.common.usdCny) + totalCny) / knownCalls : 0;
  const floor = Number(assumptions.common.aiCostFloorPerCallCny) || 0;
  return { calls, knownCalls, unknownCostCalls, observed, unit: Math.max(observed, floor) };
}

function commercialUsageEconomics(assumptions, ai) {
  const profiles = commercialProfileKeys.map(key => {
    const item = assumptions.usageProfiles?.[key] || {};
    const activeDays = Number(item.activeDaysPerMonth) || 0;
    const foregroundCalls = activeDays * (Number(item.foregroundAiCallsPerActiveDay) || 0);
    const backgroundCalls = activeDays * (Number(item.backgroundAiCallsPerActiveDay) || 0);
    const imageCalls = Number(item.imageCallsPerMonth) || 0;
    const aiCost = (foregroundCalls + backgroundCalls) * ai.unit;
    const imageCost = imageCalls * (Number(assumptions.common.segmentationCostPerImageCny) || 0);
    return {
      key,
      share: Number(item.sharePct) || 0,
      requests: activeDays * (Number(item.requestsPerActiveDay) || 0),
      foregroundCalls,
      backgroundCalls,
      imageCalls,
      aiCost,
      imageCost,
      cost: aiCost + imageCost
    };
  });
  const shareTotal = profiles.reduce((sum, profile) => sum + profile.share, 0);
  const weighted = key => shareTotal ? profiles.reduce((sum, profile) => sum + profile[key] * profile.share / shareTotal, 0) : 0;
  return {
    profiles,
    shareTotal,
    requests: weighted("requests"),
    foregroundCalls: weighted("foregroundCalls"),
    backgroundCalls: weighted("backgroundCalls"),
    aiCalls: weighted("foregroundCalls") + weighted("backgroundCalls"),
    imageCalls: weighted("imageCalls"),
    aiCost: weighted("aiCost"),
    imageCost: weighted("imageCost"),
    cost: weighted("cost")
  };
}

function usageView(assumptions, ai, statistics) {
  const usage = commercialUsageEconomics(assumptions, ai);
  const calibration = statistics?.ai?.calibration || {};
  const service = statistics?.service || {};
  const contextRisk = ai.calls
    ? `实测平均输入 ${formatInteger(calibration.averageInputTokens)} Token、最大 ${formatInteger(calibration.maxInputTokens)} Token。当前按记录条数截断，不会随总记录数无限线性增长；但单条长文和完整回答链仍可把请求推到高位。应补统一 Token 硬预算、分层摘要、按需检索和超限告警。`
    : "当前按记录条数截断，不会随总记录数无限线性增长；但单条长文和完整回答链仍可能推高请求。上线前应补统一 Token 硬预算、分层摘要、按需检索和超限告警。";
  return {
    usage,
    shareStatus: `人群占比合计 ${usage.shareTotal.toFixed(1)}%${Math.abs(usage.shareTotal - 100) > 0.01 ? "，已归一化计算" : ""}`,
    shareWarning: Math.abs(usage.shareTotal - 100) > 0.01,
    profileCosts: Object.fromEntries(usage.profiles.map(profile => [profile.key, formatCny(profile.cost)])),
    profileSummary: kpiMarkup([
      ["加权请求", `${usage.requests.toFixed(1)} 次/人/月`, "用于 API、队列与日志容量"],
      ["加权 AI", `${usage.aiCalls.toFixed(1)} 次/人/月`, `其中后台 ${usage.backgroundCalls.toFixed(1)} 次`],
      ["加权图片", `${usage.imageCalls.toFixed(1)} 张/人/月`, "按图片分割单价"],
      ["资源单位成本", `${formatCny(usage.cost)}/人/月`, `AI ${formatCny(usage.aiCost)} · 图片 ${formatCny(usage.imageCost)}`]
    ]),
    observedUsage: [
      ["AI 活跃日", `${formatInteger(calibration.activeDays)} 天`],
      ["AI 调用强度", `${(Number(calibration.averageCallsPerActiveDay) || 0).toFixed(1)} 次/活跃日`],
      ["单次成本", `均值 ${formatCny(ai.observed)} · P90 ${formatCny(calibration.p90CostCny)}`],
      ["输入 Token", `均值 ${formatInteger(calibration.averageInputTokens)} · 最大 ${formatInteger(calibration.maxInputTokens)}`],
      ["完成写操作", `${formatInteger(service.completedWrites)} 次`],
      ["图片分割请求", `${formatInteger(service.segmentationRequests)} 次`]
    ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join(""),
    contextRisk
  };
}

function validationModel(assumptions, ai) {
  const item = assumptions.validation, common = assumptions.common, participants = Number(item.participants) || 0;
  const rewards = participants * item.rewardPerParticipantCny;
  const modelCost = participants * item.aiCallsPerParticipant * ai.unit;
  const imageCost = participants * item.imageCallsPerParticipant * common.segmentationCostPerImageCny;
  const cashCost = rewards + modelCost + imageCost;
  const interviewHours = participants * item.interviewMinutesPerParticipant / 60;
  const interviewCost = interviewHours * common.laborHourlyCny;
  const developmentCost = item.developmentHoursTotal * common.laborHourlyCny;
  const fullCost = cashCost + interviewCost + developmentCost;
  const tasks = participants * item.tasksPerParticipant;
  const suggestions = participants * item.validSuggestionsPerParticipant;
  return {
    kpis: kpiMarkup([
      ["现金支出", formatCny(cashCost), `${participants} 人 × ${formatCny(item.rewardPerParticipantCny)} 报酬`],
      ["访谈成本", formatCny(interviewCost), `${interviewHours.toFixed(1)} 小时 × ${formatCny(common.laborHourlyCny)}/小时`],
      ["开发成本", formatCny(developmentCost), `${item.developmentHoursTotal} 小时 × ${formatCny(common.laborHourlyCny)}/小时`],
      ["完整投入", formatCny(fullCost), "现金、访谈与开发"]
    ]),
    breakdownTitle: "有偿体验研究账",
    costRows: costRowsMarkup([
      ["体验者报酬", `${participants} 人 × ${formatCny(item.rewardPerParticipantCny)}/人`, -rewards],
      ["AI 调用", `${participants * item.aiCallsPerParticipant} 次 × ${formatCny(ai.unit)}`, -modelCost],
      ["图片分割", `${participants * item.imageCallsPerParticipant} 张 × ${formatCny(common.segmentationCostPerImageCny)}/张`, -imageCost],
      ["访谈工时", `${interviewHours.toFixed(1)} 小时 × ${formatCny(common.laborHourlyCny)}/小时`, -interviewCost, "labor"],
      ["开发工时", `${item.developmentHoursTotal} 小时 × ${formatCny(common.laborHourlyCny)}/小时`, -developmentCost, "labor"]
    ]),
    costTotal: `<tr><th colspan="2">完整研究投入</th><td class="negative">${escapeHtml(formatCny(fullCost))}</td></tr>`,
    unitEconomics: unitMarkup([
      ["体验任务目标", `${tasks} 项`],
      ["有效建议目标", `${suggestions} 条`],
      ["单条建议成本", suggestions ? `${formatCny(fullCost / suggestions)}/条` : "—"],
      ["单人完整成本", participants ? `${formatCny(fullCost / participants)}/人` : "—"]
    ]),
    methodNote: `体验周期为 ${item.testDays} 天。该模型只有投入与学习产出，不计算收入；有效建议需满足可复现、可行动或能改变优先级。`,
    cashflow: null
  };
}

function subscriptionProjection(item, common, usage) {
  const rows = [], months = Math.max(1, Math.round(item.simulationMonths) || 1), churn = item.monthlyChurnPct / 100;
  let users = Number(item.payingUsers) || 0;
  const activePerPaying = users > 0 ? Math.max(1, (Number(item.monthlyActiveUsers) || 0) / users) : 1;
  for (let index = 0; index < months; index += 1) {
    if (index) users = Math.max(0, users * (1 - churn) + item.newPaidUsersPerMonth);
    const activeUsers = index || Number(item.payingUsers) ? users * activePerPaying : Number(item.monthlyActiveUsers) || 0;
    const revenue = users * item.monthlyPriceCny;
    const modelCost = activeUsers * usage.aiCost, imageCost = activeUsers * usage.imageCost;
    const paymentCost = revenue * item.paymentFeePct / 100, refundCost = revenue * item.refundPct / 100;
    const acquisition = item.newPaidUsersPerMonth * item.acquisitionCostPerNewUserCny;
    const cashSpend = modelCost + imageCost + paymentCost + refundCost + item.fixedMonthlyCostCny + acquisition;
    const cashFlow = revenue - cashSpend;
    const laborHours = item.operationsHoursPerMonth + item.developmentHoursPerMonth;
    const laborCost = laborHours * common.laborHourlyCny;
    rows.push({ index, users, activeUsers, revenue, modelCost, imageCost, paymentCost, refundCost, acquisition, cashSpend, cashFlow, laborHours, laborCost, fullProfit: cashFlow - laborCost });
  }
  return rows;
}

function subscriptionModel(assumptions, ai, usage, currentDate) {
  const item = assumptions.subscription, common = assumptions.common, rows = subscriptionProjection(item, common, usage), first = rows[0];
  const totals = rows.reduce((sum, row) => {
    sum.revenue += row.revenue;
    sum.cashSpend += row.cashSpend;
    sum.cashFlow += row.cashFlow;
    sum.laborCost += row.laborCost;
    sum.fullProfit += row.fullProfit;
    return sum;
  }, { revenue: 0, cashSpend: 0, cashFlow: 0, laborCost: 0, fullProfit: 0 });
  const activePerPaying = item.payingUsers ? Math.max(1, item.monthlyActiveUsers / item.payingUsers) : 1;
  const perPayingVariable = activePerPaying * usage.cost + item.monthlyPriceCny * (item.paymentFeePct + item.refundPct) / 100;
  const contribution = item.monthlyPriceCny - perPayingVariable;
  const cashBreakEven = contribution > 0 ? Math.ceil((item.fixedMonthlyCostCny + item.newPaidUsersPerMonth * item.acquisitionCostPerNewUserCny) / contribution) : null;
  const fullBreakEven = contribution > 0 ? Math.ceil((item.fixedMonthlyCostCny + item.newPaidUsersPerMonth * item.acquisitionCostPerNewUserCny + (item.operationsHoursPerMonth + item.developmentHoursPerMonth) * common.laborHourlyCny) / contribution) : null;
  const ltv = item.monthlyChurnPct > 0 ? contribution / (item.monthlyChurnPct / 100) : null;
  const ltvCac = ltv != null && item.acquisitionCostPerNewUserCny > 0 ? ltv / item.acquisitionCostPerNewUserCny : null;
  const fullMargin = totals.revenue ? totals.fullProfit / totals.revenue * 100 : 0;
  const start = new Date(`${currentDate}T12:00:00`);
  const monthLabel = index => {
    const date = new Date(start.getFullYear(), start.getMonth() + index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  };
  return {
    kpis: kpiMarkup([
      [`${rows.length} 月累计收入`, formatCny(totals.revenue), `首月 ${first.users.toFixed(1)} 名付费用户`],
      [`${rows.length} 月净现金流`, formatCny(totals.cashFlow), "不计个人工时", totals.cashFlow >= 0 ? "positive" : "negative"],
      ["首月活跃规模", `${item.dailyActiveUsers.toLocaleString("zh-CN")} DAU`, `${item.monthlyActiveUsers.toLocaleString("zh-CN")} MAU`],
      [`${rows.length} 月完整结余`, formatCny(totals.fullProfit), `${fullMargin.toFixed(1)}% 完整利润率`, totals.fullProfit >= 0 ? "positive" : "negative"]
    ]),
    breakdownTitle: "首月订阅经营账",
    costRows: costRowsMarkup([
      ["订阅收入", `${first.users.toFixed(1)} 人 × ${formatCny(item.monthlyPriceCny)}/人/月`, first.revenue, "revenue"],
      ["AI 调用", `${Math.round(first.activeUsers * usage.aiCalls).toLocaleString("zh-CN")} 次 · 含后台任务`, -first.modelCost],
      ["图片分割", `${Math.round(first.activeUsers * usage.imageCalls).toLocaleString("zh-CN")} 张 × ${formatCny(common.segmentationCostPerImageCny)}/张`, -first.imageCost],
      ["支付费", `${item.paymentFeePct}%/收入`, -first.paymentCost],
      ["退款", `${item.refundPct}%/收入`, -first.refundCost],
      ["固定现金成本", `${formatCny(item.fixedMonthlyCostCny)}/月`, -item.fixedMonthlyCostCny],
      ["新增用户获客", `${item.newPaidUsersPerMonth} 人/月 × ${formatCny(item.acquisitionCostPerNewUserCny)}/人`, -first.acquisition],
      ["经营工时", `${item.operationsHoursPerMonth} 小时/月 × ${formatCny(common.laborHourlyCny)}/小时`, -item.operationsHoursPerMonth * common.laborHourlyCny, "labor"],
      ["研发工时", `${item.developmentHoursPerMonth} 小时/月 × ${formatCny(common.laborHourlyCny)}/小时`, -item.developmentHoursPerMonth * common.laborHourlyCny, "labor"]
    ]),
    costTotal: `<tr><th colspan="2">首月完整结余</th><td class="${first.fullProfit >= 0 ? "positive" : "negative"}">${escapeHtml(formatCny(first.fullProfit))}</td></tr>`,
    unitEconomics: unitMarkup([
      ["单付费用户月贡献", formatCny(contribution)],
      ["现金盈亏平衡", cashBreakEven == null ? "不可达" : `${cashBreakEven} 人`],
      ["完整盈亏平衡", fullBreakEven == null ? "不可达" : `${fullBreakEven} 人`],
      ["LTV / CAC", ltvCac == null ? "—" : `${ltvCac.toFixed(1)}×`]
    ]),
    methodNote: `首月 ${item.monthlyActiveUsers.toLocaleString("zh-CN")} MAU 中有 ${item.payingUsers.toLocaleString("zh-CN")} 名付费用户；免费与付费用户都按四类画像产生资源成本。第 2 月起保持首月 MAU/付费比，按流失与新增推演。LTV 不含固定成本和人工。`,
    cashflow: {
      range: `统计 ${monthLabel(0)} 至 ${monthLabel(rows.length - 1)}，共 ${rows.length} 个月；工时单价 ${formatCny(common.laborHourlyCny)}/小时`,
      rows: rows.map(row => `<tr><td>${monthLabel(row.index)}</td><td>${row.users.toFixed(1)}</td><td>${formatCny(row.revenue)}</td><td>${formatCny(row.cashSpend)}</td><td class="${row.cashFlow >= 0 ? "positive" : "negative"}">${formatCny(row.cashFlow)}</td><td>${item.developmentHoursPerMonth.toFixed(1)}</td><td>${formatCny(row.laborCost)}</td><td class="${row.fullProfit >= 0 ? "positive" : "negative"}">${formatCny(row.fullProfit)}</td></tr>`).join(""),
      total: `<tr><th>合计</th><td>—</td><td>${formatCny(totals.revenue)}</td><td>${formatCny(totals.cashSpend)}</td><td class="${totals.cashFlow >= 0 ? "positive" : "negative"}">${formatCny(totals.cashFlow)}</td><td>${(item.developmentHoursPerMonth * rows.length).toFixed(1)}</td><td>${formatCny(totals.laborCost)}</td><td class="${totals.fullProfit >= 0 ? "positive" : "negative"}">${formatCny(totals.fullProfit)}</td></tr>`
    }
  };
}

function deliveryModel(assumptions) {
  const item = assumptions.delivery, common = assumptions.common, orders = Number(item.ordersPerMonth) || 0;
  const hostedOrders = orders * (1 - item.byokPct / 100), byokOrders = orders - hostedOrders;
  const serviceRevenue = orders * item.serviceFeePerOrderCny, prepaidPrincipal = hostedOrders * item.hostedPrepaidPerOrderCny;
  const prepaidCash = prepaidPrincipal * (1 + item.maintenanceMarkupPct / 100), usedPrincipal = prepaidPrincipal * item.prepaidUtilizationPct / 100;
  const recognizedHostedRevenue = usedPrincipal * (1 + item.maintenanceMarkupPct / 100), liabilityIncrease = Math.max(0, prepaidCash - recognizedHostedRevenue);
  const cashInflow = serviceRevenue + prepaidCash, earnedRevenue = serviceRevenue + recognizedHostedRevenue;
  const paymentCost = cashInflow * item.paymentFeePct / 100, refundCost = cashInflow * item.refundPct / 100;
  const acquisition = orders * item.acquisitionCostPerOrderCny, cashFlow = cashInflow - usedPrincipal - paymentCost - refundCost - acquisition;
  const deliveryHours = orders * item.deliveryHoursPerOrder, supportHours = orders * item.supportHoursPerOrder;
  const laborCost = (deliveryHours + supportHours + item.developmentHoursPerMonth) * common.laborHourlyCny;
  const fullProfit = earnedRevenue - usedPrincipal - paymentCost - refundCost - acquisition - laborCost;
  return {
    kpis: kpiMarkup([
      ["月现金流入", formatCny(cashInflow), "服务费 + 托管预存"],
      ["净现金流", formatCny(cashFlow), "未扣个人工时", cashFlow >= 0 ? "positive" : "negative"],
      ["新增合同负债", formatCny(liabilityIncrease), "预存余额与未赚维护费"],
      ["完整利润", formatCny(fullProfit), "计入全部工时", fullProfit >= 0 ? "positive" : "negative"]
    ]),
    breakdownTitle: "一次性交付与托管预存账",
    costRows: costRowsMarkup([
      ["系统服务费", `${orders} 单/月 × ${formatCny(item.serviceFeePerOrderCny)}/单`, serviceRevenue, "revenue"],
      ["托管预存流入", `${hostedOrders.toFixed(1)} 单 × 本金 ${formatCny(item.hostedPrepaidPerOrderCny)} × (1 + ${item.maintenanceMarkupPct}%)`, prepaidCash, "revenue"],
      ["调用成本", `托管本金 × ${item.prepaidUtilizationPct}% 已消耗`, -usedPrincipal],
      ["未消耗预存", "留作后续履约，不计利润", -liabilityIncrease, "liability"],
      ["支付费", `${item.paymentFeePct}%/现金流入`, -paymentCost],
      ["退款", `${item.refundPct}%/现金流入`, -refundCost],
      ["获客", `${orders} 单/月 × ${formatCny(item.acquisitionCostPerOrderCny)}/单`, -acquisition],
      ["交付工时", `${deliveryHours.toFixed(1)} 小时/月 × ${formatCny(common.laborHourlyCny)}/小时`, -deliveryHours * common.laborHourlyCny, "labor"],
      ["支持工时", `${supportHours.toFixed(1)} 小时/月 × ${formatCny(common.laborHourlyCny)}/小时`, -supportHours * common.laborHourlyCny, "labor"],
      ["研发工时", `${item.developmentHoursPerMonth} 小时/月 × ${formatCny(common.laborHourlyCny)}/小时`, -item.developmentHoursPerMonth * common.laborHourlyCny, "labor"]
    ]),
    costTotal: `<tr><th colspan="2">月度完整利润</th><td class="${fullProfit >= 0 ? "positive" : "negative"}">${escapeHtml(formatCny(fullProfit))}</td></tr>`,
    unitEconomics: unitMarkup([
      ["BYOK / 托管", `${byokOrders.toFixed(1)} / ${hostedOrders.toFixed(1)} 单`],
      ["当月确认收入", formatCny(earnedRevenue)],
      ["单笔完整利润", orders ? `${formatCny(fullProfit / orders)}/单` : "—"],
      ["服务与支持", `${(item.deliveryHoursPerOrder + item.supportHoursPerOrder).toFixed(2)} 小时/单`]
    ]),
    methodNote: `BYOK 用户自行承担模型费用；托管用户预存调用本金并按实际消耗支付 ${item.maintenanceMarkupPct}% 维护费。未消耗的本金和对应维护费作为合同负债，不计入当期利润。`,
    cashflow: null
  };
}

function usagePackModel(assumptions, ai) {
  const item = assumptions.usagePack, common = assumptions.common, buyers = Number(item.buyersPerMonth) || 0;
  const packs = buyers * item.packsPerBuyer, revenue = packs * item.pricePerPackCny, utilization = item.utilizationPct / 100;
  const aiCalls = packs * item.includedAiCallsPerPack * utilization, imageCalls = packs * item.includedImageCallsPerPack * utilization;
  const modelCost = aiCalls * ai.unit, imageCost = imageCalls * common.segmentationCostPerImageCny;
  const paymentCost = revenue * item.paymentFeePct / 100, refundCost = revenue * item.refundPct / 100;
  const acquisition = buyers * item.acquisitionCostPerBuyerCny;
  const cashProfit = revenue - modelCost - imageCost - paymentCost - refundCost - acquisition;
  const laborCost = item.supportHoursPerMonth * common.laborHourlyCny, fullProfit = cashProfit - laborCost;
  const variablePerPack = packs ? (modelCost + imageCost + paymentCost + refundCost) / packs : 0;
  return {
    kpis: kpiMarkup([
      ["月度收入", formatCny(revenue), `${packs.toFixed(1)} 包/月 × ${formatCny(item.pricePerPackCny)}/包`],
      ["实际资源成本", formatCny(modelCost + imageCost), `${item.utilizationPct}% 额度使用率`],
      ["净现金流", formatCny(cashProfit), "含获客与退款", cashProfit >= 0 ? "positive" : "negative"],
      ["完整利润", formatCny(fullProfit), "计入支持工时", fullProfit >= 0 ? "positive" : "negative"]
    ]),
    breakdownTitle: "用量增值包月度账",
    costRows: costRowsMarkup([
      ["用量包收入", `${packs.toFixed(1)} 包/月 × ${formatCny(item.pricePerPackCny)}/包`, revenue, "revenue"],
      ["AI 调用", `${Math.round(aiCalls)} 次/月 × ${formatCny(ai.unit)}/次`, -modelCost],
      ["图片分割", `${Math.round(imageCalls)} 张/月 × ${formatCny(common.segmentationCostPerImageCny)}/张`, -imageCost],
      ["支付费", `${item.paymentFeePct}%/收入`, -paymentCost],
      ["退款", `${item.refundPct}%/收入`, -refundCost],
      ["获客", `${buyers} 人/月 × ${formatCny(item.acquisitionCostPerBuyerCny)}/人`, -acquisition],
      ["支持工时", `${item.supportHoursPerMonth} 小时/月 × ${formatCny(common.laborHourlyCny)}/小时`, -laborCost, "labor"]
    ]),
    costTotal: `<tr><th colspan="2">月度完整利润</th><td class="${fullProfit >= 0 ? "positive" : "negative"}">${escapeHtml(formatCny(fullProfit))}</td></tr>`,
    unitEconomics: unitMarkup([
      ["单包变量成本", `${formatCny(variablePerPack)}/包`],
      ["单包现金贡献", packs ? `${formatCny((revenue - modelCost - imageCost - paymentCost - refundCost) / packs)}/包` : "—"],
      ["额度使用率", `${item.utilizationPct}%`],
      ["实际消耗", `${Math.round(aiCalls)} 次 AI · ${Math.round(imageCalls)} 张图`]
    ]),
    methodNote: "用量包用于覆盖高强度 AI 与图片调用，不应把基础记录能力切碎收费；使用率越高，未使用额度带来的缓冲越小。",
    cashflow: null
  };
}

export function architectureOwnerSurface() {
  return {
    surface: "architecture",
    markup: architectureMarkup,
    kpis: [
      { label: "阶段", key: "name", note: "当前产品路线" },
      { label: "用户规模", key: "scale", note: "规划容量" },
      { label: "峰值流量", key: "peak", note: "压测假设" },
      { label: "可靠性", key: "availability", note: "内部目标" }
    ],
    stages: structuredClone(architectureStages),
    terms: Object.entries(architectureTerms).map(([key, [code, name, description, analogy, timing]]) => ({ key, code, name, description, analogy, timing }))
  };
}

export function commercializationOwnerSurface({
  report,
  store = {},
  statistics = {},
  mode = "validation",
  currentDate
}) {
  if (!report?.assumptions) throw new TypeError("Commercialization owner surface requires normalized assumptions");
  const activeMode = commercialModelKeys.includes(mode) ? mode : commercialModelKeys[0];
  const assumptions = structuredClone(report.assumptions);
  const ai = commercialAiBasis(assumptions, statistics);
  const usage = usageView(assumptions, ai, statistics);
  const evidence = commercialEvidence(store);
  const paidFacts = evidence.filter(item => commercialPaymentFactPattern.test(`${item.title} ${item.content}`));
  const stageIndex = Math.max(0, Math.min(commercialStages.length - 1, Number(assumptions.stageByModel?.[activeMode]) || 0));
  const stage = commercialStages[stageIndex];
  const model = activeMode === "validation"
    ? validationModel(assumptions, ai)
    : activeMode === "subscription"
      ? subscriptionModel(assumptions, ai, usage.usage, currentDate || dateOf(new Date().toISOString()))
      : activeMode === "delivery"
        ? deliveryModel(assumptions)
        : usagePackModel(assumptions, ai);
  const p90 = Number(statistics?.ai?.calibration?.p90CostCny) || 0;
  const sampleNote = ai.calls
    ? `近 30 天已知费用均值 ${formatCny(ai.observed)}/次、P90 ${formatCny(p90)}/次，共 ${ai.calls} 次${ai.unknownCostCalls ? `，其中 ${ai.unknownCostCalls} 次费用待账单` : ""}；估算采用已知均值与保守底线中的较高值 ${formatCny(ai.unit)}/次。`
    : `近 30 天没有 AI 成本样本，暂按 ${formatCny(ai.unit)}/次。`;
  const updatedAt = report.updatedAt
    ? `参数更新于 ${new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(report.updatedAt))}`
    : "使用示例假设";
  const evidenceMarkup = evidence.length ? evidence.map(item => `<article><header><span>${escapeHtml(item.type)}</span><time>${escapeHtml(dateOf(item.date))}</time></header><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.content)}</p>${item.tags.length ? `<div>${item.tags.map(tag => `<span>#${escapeHtml(tag)}</span>`).join("")}</div>` : ""}<button type="button" data-commercial-source-view="${escapeHtml(item.view)}" data-commercial-source-id="${escapeHtml(item.id)}" data-commercial-source-date="${escapeHtml(item.date)}">查看原记录</button></article>`).join("") : emptyEvidence();
  return {
    surface: "commercialization",
    markup: commercializationMarkup,
    report: {
      version: report.version,
      updatedAt: report.updatedAt || "",
      legacyV2: Boolean(report.legacyV2),
      assumptions
    },
    mode: activeMode,
    view: {
      stageIndex,
      text: {
        "commercial-stage": paidFacts.length ? "用户付费验证中" : "有偿调研准备",
        "commercial-updated-at": `${updatedAt}${report.legacyV2 ? " · 已保留旧版参数供核对" : ""}`,
        "commercial-verdict-title": paidFacts.length ? "已经出现用户付费事实，继续核对交付成本与第 7 天留存。" : "先付费招募体验者，换取完成任务、有效建议和结构化访谈。",
        "commercial-verdict-copy": paidFacts.length ? `已从用户原文识别 ${paidFacts.length} 条完成态付费线索；仍需逐条核对金额、是否补贴以及付款后的持续使用。` : "这笔支出是产品研究成本，不是收入。访谈与研发工时分别核算，后续再用无补贴场景验证用户是否愿意付款。",
        "commercial-evidence-count": `${evidence.length} 条`,
        "commercial-paid-evidence": paidFacts.length ? `${paidFacts.length} 条` : "待记录",
        "commercial-ai-sample": ai.calls ? (ai.unknownCostCalls ? `${ai.knownCalls} / ${ai.calls} 次` : `${ai.calls} 次`) : "暂无",
        "commercial-model-basis": ai.calls ? (ai.unknownCostCalls ? "已知费用下限 + 保守底线" : "实际账本 + 保守底线") : "假设",
        "commercial-stage-name": stage.name,
        "commercial-stage-scale": commercialStageScales[activeMode][stageIndex],
        "commercial-stage-rationale": stage.rationale,
        "commercial-profile-share-status": usage.shareStatus,
        "commercial-context-risk": usage.contextRisk,
        "commercial-breakdown-title": model.breakdownTitle,
        "commercial-method-note": `${model.methodNote} ${sampleNote}`,
        "commercial-cashflow-range": model.cashflow?.range || "",
        "commercial-evidence-summary": `${evidence.length} 条用户原文 · 应答未计入`
      },
      html: {
        "commercial-profile-summary": usage.profileSummary,
        "commercial-observed-usage": usage.observedUsage,
        "commercial-kpis": model.kpis,
        "commercial-cost-rows": model.costRows,
        "commercial-cost-total": model.costTotal,
        "commercial-unit-economics": model.unitEconomics,
        "commercial-cashflow-rows": model.cashflow?.rows || "",
        "commercial-cashflow-total": model.cashflow?.total || "",
        "commercial-evidence-list": evidenceMarkup
      },
      profileCosts: usage.profileCosts,
      shareWarning: usage.shareWarning,
      cashflowHidden: !model.cashflow
    }
  };
}
