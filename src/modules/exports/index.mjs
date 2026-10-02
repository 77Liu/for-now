export const EXPORT_MANIFEST_FORMAT = "for-now-cross-genre-export-v1";
const ATTACHMENT_FIELDS = new Set(["attachmentPaths", "originalPath", "cutoutPath", "imagePath"]);
const BODY_FIELDS = new Set(["answer", "content", "description", "recognitionDescription", "message", "note", "question", "quote", "text", "title"]);
const RESOURCE_TYPES = Object.freeze({
  checkins: "checkin",
  dailyRecords: "dailyRecord",
  captures: "capture",
  journals: "journal",
  thoughts: "thought",
  chats: "chat",
  books: "book",
  keepsakes: "keepsake",
  quotes: "quote",
  experiments: "experiment",
  analyses: "analysis",
  customMetrics: "customMetric",
  actions: "action",
  habits: "habit",
  habitCheckins: "habitCheckin",
  feedback: "feedback",
  validationLedger: "validationLedger",
  userClaims: "userClaim",
  modelUnknowns: "modelUnknown",
  trash: "trash"
});
const SINGLETON_TYPES = Object.freeze({
  journalDraft: "journalDraft",
  onboarding: "onboarding",
  onboardingV2: "onboardingV2",
  commercialization: "commercialization"
});
const TIME_FIELDS = ["createdAt", "updatedAt", "occurredAt", "occurredOn", "deletedAt", "completedAt"];
const REASONING_KEYS = new Set([
  "reasoning",
  "reasoningcontent",
  "modelreasoning",
  "privatereasoning",
  "chainofthought",
  "thinkingcontent"
]);
const SECRET_KEYS = new Set([
  "apikey",
  "accesskey",
  "accesskeyid",
  "accesskeysecret",
  "authorization",
  "clientsecret",
  "cookie",
  "csrftoken",
  "credential",
  "credentials",
  "invitation",
  "keyhint",
  "password",
  "passwordhash",
  "privatekey",
  "secret",
  "secretkey",
  "secretaccesskey",
  "secrets",
  "securitytoken",
  "sessiontoken",
  "token",
  "tokenhash",
  "accesstoken",
  "refreshtoken"
]);
const OMIT = Symbol("omit");

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const objectValue = value => value !== null && typeof value === "object" && !Array.isArray(value);
const normalizedKey = key => String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
const compareText = (left, right) => {
  const a = String(left ?? ""), b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
};
const compareBy = keys => (left, right) => {
  for (const key of keys) {
    const compared = compareText(left[key], right[key]);
    if (compared) return compared;
  }
  return 0;
};

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!objectValue(value)) return typeof value === "number" && !Number.isFinite(value) ? null : value;
  const result = {};
  for (const key of Object.keys(value).sort(compareText)) {
    const child = stableValue(value[key]);
    if (child !== undefined) Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

export function stableExportJson(value, space = 2) {
  return JSON.stringify(stableValue(value), null, space);
}

function privateFieldKind(key) {
  const normalized = normalizedKey(key);
  if (REASONING_KEYS.has(normalized)) return "reasoning";
  if (SECRET_KEYS.has(normalized) || normalized.endsWith("password") || normalized.endsWith("apikey")) return "secret";
  return "";
}

function sanitize(value, options, omitted) {
  if (Array.isArray(value)) {
    return value.map(item => sanitize(item, options, omitted)).filter(item => item !== OMIT);
  }
  if (!objectValue(value)) {
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return OMIT;
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  }
  const result = {};
  for (const key of Object.keys(value).sort(compareText)) {
    const kind = privateFieldKind(key);
    if ((kind === "reasoning" && !options.includeReasoning) || (kind === "secret" && !options.includeSecrets)) {
      omitted[kind] += 1;
      continue;
    }
    const child = sanitize(value[key], options, omitted);
    if (child !== OMIT) Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function fieldPath(segments) {
  return segments.reduce((path, segment) => {
    if (typeof segment === "number") return `${path}[${segment}]`;
    return path ? `${path}.${segment}` : segment;
  }, "");
}

function collectBody(value, output = [], segments = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectBody(item, output, [...segments, index]));
    return output;
  }
  if (!objectValue(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    const next = [...segments, key];
    if (BODY_FIELDS.has(key) && typeof child === "string" && child.trim()) {
      output.push({ field: key, fieldPath: fieldPath(next), value: child });
    }
    collectBody(child, output, next);
  }
  return output.sort(compareBy(["fieldPath", "value"]));
}

function collectAttachmentReferences(value, metadata, output = [], segments = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectAttachmentReferences(item, metadata, output, [...segments, index]));
    return output;
  }
  if (!objectValue(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    const next = [...segments, key];
    if (ATTACHMENT_FIELDS.has(key)) {
      const paths = Array.isArray(child) ? child : [child];
      paths.forEach((path, index) => {
        if (typeof path !== "string" || !path.trim()) return;
        output.push({
          path: path.trim(),
          resourceType: metadata.resourceType,
          resourceId: metadata.id,
          field: key,
          fieldPath: fieldPath(Array.isArray(child) ? [...next, index] : next),
          ...(Array.isArray(child) ? { position: index } : {}),
          version: metadata.version,
          ...metadata.timestamps
        });
      });
      continue;
    }
    collectAttachmentReferences(child, metadata, output, next);
  }
  return output;
}

function timestampsOf(item) {
  const timestamps = {};
  for (const key of TIME_FIELDS) {
    if (typeof item[key] === "string" && item[key]) timestamps[key] = item[key];
  }
  return timestamps;
}

function versionOf(item) {
  const version = Number(item.version);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

function resourceRows(store, options, omitted) {
  const resources = [];
  const append = (resourceType, item, fallbackId = "") => {
    if (!objectValue(item)) return;
    const fields = sanitize(item, options, omitted);
    const id = typeof item.id === "string" || typeof item.id === "number" ? String(item.id) : fallbackId;
    const metadata = { resourceType, id, version: versionOf(item), timestamps: timestampsOf(item) };
    const attachmentReferences = collectAttachmentReferences(fields, metadata)
      .sort(compareBy(["path", "fieldPath", "resourceType", "resourceId"]));
    resources.push({
      resourceType,
      id,
      version: metadata.version,
      timestamps: metadata.timestamps,
      body: collectBody(fields),
      fields,
      attachmentReferences
    });
  };
  for (const [collection, resourceType] of Object.entries(RESOURCE_TYPES)) {
    const rows = Array.isArray(store[collection]) ? store[collection] : [];
    rows.forEach(item => append(resourceType, item));
  }
  for (const [field, resourceType] of Object.entries(SINGLETON_TYPES)) {
    if (!objectValue(store[field])) continue;
    append(resourceType, store[field], field === "journalDraft" ? String(store[field].journalId || "journal-draft") : field);
  }
  return resources.sort((left, right) => (
    compareText(left.resourceType, right.resourceType)
    || compareText(left.timestamps.occurredAt || left.timestamps.createdAt || left.timestamps.occurredOn, right.timestamps.occurredAt || right.timestamps.createdAt || right.timestamps.occurredOn)
    || compareText(left.id, right.id)
    || compareText(stableExportJson(left.fields, 0), stableExportJson(right.fields, 0))
  ));
}

function inventorySource(accountSnapshot, options) {
  for (const [owner, keys] of [
    [options, ["attachmentInventory", "inventory", "availableAttachments", "availableAttachmentPaths"]],
    [accountSnapshot, objectValue(accountSnapshot.store)
      ? ["attachmentInventory", "inventory", "attachments", "availableAttachments"]
      : ["attachmentInventory", "inventory"]]
  ]) {
    for (const key of keys) if (own(owner, key)) return { known: true, value: owner[key] };
  }
  return { known: false, value: [] };
}

function inventoryRows(source, options, omitted) {
  let values = source.value;
  if (values instanceof Map) values = [...values.entries()].map(([path, metadata]) => ({ path, ...(objectValue(metadata) ? metadata : {}) }));
  else if (values instanceof Set) values = [...values];
  else if (objectValue(values)) values = Object.entries(values).map(([path, metadata]) => ({ path, ...(objectValue(metadata) ? metadata : {}) }));
  if (!Array.isArray(values)) values = [];
  return values.map(item => {
    if (typeof item === "string") return { path: item.trim() };
    if (!objectValue(item)) return null;
    const safe = sanitize(item, options, omitted);
    const path = [safe.path, safe.attachmentPath, safe.resourcePath].find(value => typeof value === "string" && value.trim());
    return path ? { ...safe, path: path.trim() } : null;
  }).filter(Boolean).sort((left, right) => (
    compareText(left.path, right.path) || compareText(stableExportJson(left, 0), stableExportJson(right, 0))
  ));
}

function attachmentAvailability(inventoryKnown, inventory) {
  if (!inventoryKnown) return "unverified";
  if (!inventory) return "missing";
  const state = String(inventory.state || "").toLowerCase();
  if (/missing|deleted|failed/.test(state)) return "missing";
  if (state && state !== "verified") return "incomplete";
  return "available";
}

function attachmentRows(resources, inventory, inventoryKnown) {
  const inventoryByPath = new Map();
  for (const row of inventory) if (!inventoryByPath.has(row.path)) inventoryByPath.set(row.path, row);
  const references = resources.flatMap(resource => resource.attachmentReferences)
    .sort(compareBy(["path", "resourceType", "resourceId", "fieldPath", "createdAt", "occurredAt"]));
  const paths = new Set([...references.map(reference => reference.path), ...inventoryByPath.keys()]);
  const attachments = [...paths].sort(compareText).map(path => {
    const inventoryRow = inventoryByPath.get(path);
    const id = String(inventoryRow?.id || inventoryRow?.attachmentId || path);
    const related = references.filter(reference => reference.path === path).map(reference => ({ ...reference, attachmentId: id }));
    const metadata = inventoryRow ? Object.fromEntries(Object.entries(inventoryRow).filter(([key]) => !["id", "attachmentId", "path"].includes(key))) : {};
    return {
      id,
      path,
      availability: attachmentAvailability(inventoryKnown, inventoryRow),
      metadata,
      references: related
    };
  });
  const idByPath = new Map(attachments.map(item => [item.path, item.id]));
  for (const resource of resources) {
    resource.attachmentReferences = resource.attachmentReferences.map(reference => ({
      ...reference,
      attachmentId: idByPath.get(reference.path)
    }));
  }
  const attachmentReferences = resources.flatMap(resource => resource.attachmentReferences)
    .sort(compareBy(["path", "resourceType", "resourceId", "fieldPath", "createdAt", "occurredAt"]));
  for (const attachment of attachments) {
    attachment.references = attachmentReferences.filter(reference => reference.path === attachment.path);
  }
  return { attachments, attachmentReferences };
}

function snapshotInput(accountSnapshot) {
  if (!objectValue(accountSnapshot)) throw new TypeError("Account snapshot must be an object");
  const store = objectValue(accountSnapshot.store) ? accountSnapshot.store : accountSnapshot;
  return { store, wrapper: accountSnapshot };
}

export function buildExportManifest(accountSnapshot, options = {}) {
  const { store, wrapper } = snapshotInput(accountSnapshot);
  const omitted = { reasoning: 0, secret: 0 };
  const privacy = {
    includeReasoning: options.includeReasoning === true,
    includeSecrets: options.includeSecrets === true
  };
  const resources = resourceRows(store, privacy, omitted);
  const source = inventorySource(wrapper, options);
  const inventory = inventoryRows(source, privacy, omitted);
  const { attachments, attachmentReferences } = attachmentRows(resources, inventory, source.known);
  const orphanReferences = source.known
    ? attachmentReferences.filter(reference => attachments.find(item => item.path === reference.path)?.availability !== "available")
      .map(reference => ({
        ...reference,
        reason: attachments.find(item => item.path === reference.path)?.availability || "missing"
      }))
    : [];
  const unreferencedAttachments = attachments.filter(item => item.references.length === 0).map(({ references, ...item }) => item);
  const generatedAt = String(options.generatedAt ?? wrapper.generatedAt ?? wrapper.snapshotAt ?? "");
  return {
    format: EXPORT_MANIFEST_FORMAT,
    accountId: String(options.accountId ?? wrapper.accountId ?? ""),
    snapshotVersion: own(store, "version") ? store.version : null,
    generatedAt,
    resources,
    attachments,
    attachmentReferences,
    orphanReferences,
    unreferencedAttachments,
    privacy: {
      reasoningExcluded: !privacy.includeReasoning,
      secretsExcluded: !privacy.includeSecrets,
      omittedReasoningFields: omitted.reasoning,
      omittedSecretFields: omitted.secret
    },
    summary: {
      resources: resources.length,
      attachments: attachments.length,
      attachmentReferences: attachmentReferences.length,
      sharedAttachments: attachments.filter(item => item.references.length > 1).length,
      orphanReferences: orphanReferences.length,
      unreferencedAttachments: unreferencedAttachments.length
    }
  };
}

function filenameDate(manifest) {
  const values = [
    manifest.generatedAt,
    ...manifest.resources.flatMap(resource => Object.values(resource.timestamps || {}))
  ];
  return values.map(value => String(value || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "").filter(Boolean).sort(compareText).at(-1) || "";
}

const safeFilenamePart = value => String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

export function buildExportFilename(manifest, format, options = {}) {
  const extension = format === "markdown" || format === "md" ? "md" : "json";
  const account = safeFilenamePart(manifest.accountId) || "account";
  const date = filenameDate(manifest) || "snapshot";
  const stem = safeFilenamePart(options.basename) || `for-now-${account}-export-${date}`;
  return `${stem}.${extension}`;
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function codeFence(value, language = "") {
  const text = String(value ?? "");
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

export function renderExportMarkdown(manifest) {
  const lines = [
    "# For Now 跨体裁导出",
    "",
    `- 账户：${manifest.accountId || "未标识"}`,
    `- 快照版本：${manifest.snapshotVersion ?? "未标识"}`,
    ...(manifest.generatedAt ? [`- 生成时间：${manifest.generatedAt}`] : []),
    `- 资源：${manifest.summary.resources}`,
    `- 附件：${manifest.summary.attachments}`,
    `- 附件引用：${manifest.summary.attachmentReferences}`,
    `- 孤儿引用：${manifest.summary.orphanReferences}`,
    "",
    "## 资源",
    ""
  ];
  for (const resource of manifest.resources) {
    lines.push(`### ${resource.resourceType} / ${resource.id || "无 ID"}`, "", `- 版本：${resource.version}`);
    for (const [field, value] of Object.entries(resource.timestamps)) lines.push(`- ${field}：${value}`);
    lines.push("", "#### 正文", "");
    if (!resource.body.length) lines.push("（无文本正文）", "");
    else for (const body of resource.body) lines.push(`- \`${body.fieldPath}\``, "", codeFence(body.value), "");
    lines.push("#### 附件引用", "");
    if (!resource.attachmentReferences.length) lines.push("（无）", "");
    else {
      lines.push("| 字段 | 路径 |", "| --- | --- |");
      for (const reference of resource.attachmentReferences) {
        lines.push(`| ${markdownCell(reference.fieldPath)} | ${markdownCell(reference.path)} |`);
      }
      lines.push("");
    }
    lines.push("#### 字段快照", "", codeFence(stableExportJson(resource.fields), "json"), "");
  }
  lines.push("## 附件清单", "", "| 路径 | 状态 | 引用数 |", "| --- | --- | ---: |");
  for (const attachment of manifest.attachments) {
    lines.push(`| ${markdownCell(attachment.path)} | ${attachment.availability} | ${attachment.references.length} |`);
  }
  if (!manifest.attachments.length) lines.push("| （无） | - | 0 |");
  lines.push("", "## 孤儿引用", "");
  if (!manifest.orphanReferences.length) lines.push("（无）");
  else {
    lines.push("| 资源 | 字段 | 路径 | 原因 |", "| --- | --- | --- | --- |");
    for (const reference of manifest.orphanReferences) {
      lines.push(`| ${markdownCell(`${reference.resourceType}/${reference.resourceId}`)} | ${markdownCell(reference.fieldPath)} | ${markdownCell(reference.path)} | ${reference.reason} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function renderExportJson(manifest) {
  return `${stableExportJson(manifest)}\n`;
}

export function createExportDocument(manifest, format, options = {}) {
  if (!objectValue(manifest) || manifest.format !== EXPORT_MANIFEST_FORMAT) throw new TypeError("A valid export manifest is required");
  const normalizedFormat = format === "md" ? "markdown" : format;
  if (!["json", "markdown"].includes(normalizedFormat)) throw new TypeError(`Unsupported export format: ${format}`);
  const json = normalizedFormat === "json";
  return {
    format: normalizedFormat,
    filename: buildExportFilename(manifest, normalizedFormat, options),
    mimeType: json ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8",
    content: json ? renderExportJson(manifest) : renderExportMarkdown(manifest)
  };
}

export function createAccountExport(accountSnapshot, options = {}) {
  const manifest = buildExportManifest(accountSnapshot, options);
  return {
    manifest,
    files: {
      json: createExportDocument(manifest, "json", options),
      markdown: createExportDocument(manifest, "markdown", options)
    }
  };
}

export const createExportManifest = buildExportManifest;
