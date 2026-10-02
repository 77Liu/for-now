const cleanText = (value, limit = 240) => String(value ?? "").trim().slice(0, limit);

const sentence = value => {
  const text = cleanText(value, 600);
  if (!text) return "";
  return /[。！？!?]$/.test(text) ? text : `${text}。`;
};

const errorStatus = error => {
  const value = Number(error?.status ?? error?.statusCode ?? error?.httpStatus);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 0;
};

const diagnosticFor = error => {
  const retryValue = error?.retryAfterMs;
  const retryAfterMs = retryValue == null ? null : Number(retryValue);
  return Object.freeze({
    code: cleanText(error?.code, 120),
    status: errorStatus(error),
    requestId: cleanText(error?.requestId, 200),
    retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null
  });
};

const classifyError = (error, { publicValidation = false } = {}) => {
  const status = errorStatus(error);
  const code = cleanText(error?.code, 120).toUpperCase();
  const name = cleanText(error?.name, 80);
  const syncStatus = cleanText(error?.syncStatus, 80).toLowerCase();

  if (publicValidation) return "validation";
  if (status === 401 || /AUTH_REQUIRED|AUTH_STORAGE|SESSION|TOKEN_EXPIRED|LOGIN_REQUIRED|UNAUTHENTICATED/.test(code)) return "auth";
  if (status === 403 || /FORBIDDEN|PERMISSION|ACCESS_DENIED|NOT_ALLOWED/.test(code)) return "permission";
  if (status === 404 || /NOT_FOUND|NO_SUCH/.test(code)) return "not_found";
  if ([409, 412].includes(status) || syncStatus === "conflict" || /CONFLICT|PRECONDITION|VERSION|IDEMPOTENCY_KEY_REUSED|STALE/.test(code)) return "conflict";
  if (status === 429 || /RATE|QUOTA|(?:^|_)LIMIT(?:_|$)/.test(code)) return "rate_limit";
  if ([400, 422].includes(status) || /VALIDATION|INVALID|REQUIRED|BAD_REQUEST|TOO_(?:LARGE|MANY)|UNSUPPORTED/.test(code)) return "validation";
  if (status >= 500 || /PROVIDER|WORKER|PROCESS|OCR|ASR|TRANSCR|SEGMENT|DERIV|MEDIA.*FAILED|STORAGE.*FAILED/.test(code)) return "processing";
  if (
    ["TypeError", "AbortError"].includes(name)
    || syncStatus === "pending"
    || [408, 425].includes(status)
    || /NETWORK|OFFLINE|FETCH|ECONN|ENOTFOUND|EAI_AGAIN|TIMEOUT/.test(code)
  ) return "network";
  return "unknown";
};

const actionFor = retry => {
  if (!retry) return null;
  if (typeof retry === "string") {
    const label = cleanText(retry, 80);
    return label ? Object.freeze({ label }) : null;
  }
  const label = cleanText(retry.label, 80);
  if (!label) return null;
  const action = { label };
  for (const key of ["command", "focus", "view"]) {
    const value = cleanText(retry[key], 120);
    if (value) action[key] = value;
  }
  return Object.freeze(action);
};

const defaultNext = (kind, diagnostic) => {
  if (kind === "validation") return "请修改后重试";
  if (kind === "network") return "请检查网络后重试";
  if (kind === "auth") return "请重新登录后再试";
  if (kind === "conflict") return "请重新读取后核对两端内容";
  if (kind === "not_found") return "请返回列表重新选择";
  if (kind === "permission") return "请返回可访问页面";
  if (kind === "rate_limit") {
    return diagnostic.retryAfterMs == null
      ? "请稍后再试"
      : `请在 ${Math.max(1, Math.ceil(diagnostic.retryAfterMs / 1000))} 秒后再试`;
  }
  return "请稍后重试";
};

const failureText = (kind, error, context) => {
  if (kind === "validation" && context.publicValidation) {
    const value = cleanText(error?.message, 300);
    if (value) return value;
  }
  if (kind === "network") return `${context.operation}尚未确认`;
  if (kind === "auth") return `登录状态已失效，暂时无法${context.operation}`;
  if (kind === "conflict") return `${context.object}在其他位置已经变化`;
  if (kind === "not_found") return `${context.object}当前不可用`;
  if (kind === "permission") return `当前账户无权访问${context.object}`;
  if (kind === "rate_limit") return `${context.operation}暂时受限`;
  if (kind === "processing") return `${context.phase || context.operation}暂时失败`;
  return `${context.operation}暂时未完成`;
};

export function presentError(error, context = {}) {
  const normalized = {
    operation: cleanText(context.operation, 160),
    object: cleanText(context.object, 160),
    phase: cleanText(context.phase, 160),
    retained: cleanText(context.retained, 300),
    publicValidation: context.publicValidation === true
  };
  for (const key of ["operation", "object", "retained"]) {
    if (!normalized[key]) throw new TypeError(`presentError requires ${key}`);
  }

  const diagnostic = diagnosticFor(error);
  const kind = classifyError(error, normalized);
  const message = [
    failureText(kind, error, normalized),
    normalized.retained,
    defaultNext(kind, diagnostic)
  ].map(sentence).join("");

  return Object.freeze({
    kind,
    message,
    action: actionFor(context.retry),
    diagnostic
  });
}
