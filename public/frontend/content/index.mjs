const cleanText = (value, limit = 240) => (
  String(value ?? "").trim().slice(0, limit)
);

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
    retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? retryAfterMs
      : null
  });
};

const classifyError = (error, { publicValidation = false } = {}) => {
  const status = errorStatus(error);
  const code = cleanText(error?.code, 120).toUpperCase();
  const name = cleanText(error?.name, 80);
  const syncStatus = cleanText(error?.syncStatus, 80).toLowerCase();

  if (publicValidation) return "validation";
  if (status === 401
      || /AUTH_REQUIRED|AUTH_STORAGE|SESSION|TOKEN_EXPIRED|LOGIN_REQUIRED|UNAUTHENTICATED/.test(code)) {
    return "auth";
  }
  if (status === 403 || /FORBIDDEN|PERMISSION|ACCESS_DENIED|NOT_ALLOWED/.test(code)) {
    return "permission";
  }
  if (status === 404 || /NOT_FOUND|NO_SUCH/.test(code)) return "not_found";
  if ([409, 412].includes(status)
      || syncStatus === "conflict"
      || /CONFLICT|PRECONDITION|VERSION|IDEMPOTENCY_KEY_REUSED|STALE/.test(code)) {
    return "conflict";
  }
  if (status === 429 || /RATE|QUOTA|(?:^|_)LIMIT(?:_|$)/.test(code)) {
    return "rate_limit";
  }
  if ([400, 422].includes(status)
      || /VALIDATION|INVALID|REQUIRED|BAD_REQUEST|TOO_(?:LARGE|MANY)|UNSUPPORTED/.test(code)) {
    return "validation";
  }
  if (status >= 500
      || /PROVIDER|WORKER|PROCESS|OCR|ASR|TRANSCR|SEGMENT|DERIV|MEDIA.*FAILED|STORAGE.*FAILED/.test(code)) {
    return "processing";
  }
  if (
    ["TypeError", "AbortError"].includes(name)
    || syncStatus === "pending"
    || [408, 425].includes(status)
    || /NETWORK|OFFLINE|FETCH|ECONN|ENOTFOUND|EAI_AGAIN|TIMEOUT/.test(code)
  ) {
    return "network";
  }
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

export const escapeHtml = value => String(value ?? "").replace(/[&<>"]/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
})[character]);

export function createLatexRenderer({
  createAsset,
  getKatex = () => globalThis.katex,
  resolveAssetUrl = value => value
} = {}) {
  let loadPromise = null;
  let assetsReady = false;
  const pendingContainers = new Set();
  const elements = container => [...(container?.querySelectorAll?.("[data-tex]") || [])];
  const fallback = container => {
    for (const element of elements(container)) {
      element.textContent = decodeURIComponent(element.dataset.tex || "");
    }
  };
  const render = (container, katex) => {
    for (const element of elements(container)) {
      try {
        katex.render(decodeURIComponent(element.dataset.tex || ""), element, {
          displayMode: element.classList.contains("latex-display"),
          throwOnError: false,
          strict: "ignore",
          trust: false
        });
      } catch {
        fallback({ querySelectorAll: () => [element] });
      }
    }
  };
  const load = () => {
    if (loadPromise) return loadPromise;
    loadPromise = Promise.all([
      createAsset("link", {
        rel: "stylesheet",
        href: resolveAssetUrl("vendor/katex/katex.min.css")
      }, "stylesheet"),
      createAsset("script", {
        async: true,
        src: resolveAssetUrl("vendor/katex/katex.min.js")
      }, "script")
    ]).then(() => {
      const katex = getKatex();
      if (!katex?.render) throw new Error("LATEX_RENDERER_UNAVAILABLE");
      assetsReady = true;
      for (const container of pendingContainers) render(container, katex);
      pendingContainers.clear();
      return katex;
    }).catch(error => {
      loadPromise = null;
      for (const container of pendingContainers) fallback(container);
      pendingContainers.clear();
      throw error;
    });
    return loadPromise;
  };

  return function renderLatex(container) {
    if (!elements(container).length) return Promise.resolve(false);
    const katex = getKatex();
    if (assetsReady && katex?.render) {
      render(container, katex);
      return Promise.resolve(true);
    }
    pendingContainers.add(container);
    return load().then(() => true, () => false);
  };
}

export function inlineMarkdown(value) {
  const code = [], math = [];
  let source = String(value ?? "")
    .replace(/\\\((.+?)\\\)/g, (_, tex) => {
      const token = `\u0000MATH${math.length}\u0000`;
      math.push(tex);
      return token;
    })
    .replace(/(^|[^\\])\$([^$\n]+)\$/g, (_, prefix, tex) => {
      const token = `\u0000MATH${math.length}\u0000`;
      math.push(tex);
      return `${prefix}${token}`;
    });
  let text = escapeHtml(source).replace(/`([^`\n]+)`/g, (_, content) => {
    const token = `\u0000CODE${code.length}\u0000`;
    code.push(`<code>${content}</code>`);
    return token;
  });
  text = text
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/g, (_, label, url, title) => {
      const decoded = url.replace(/&amp;/g, "&");
      if (!/^(https?:\/\/|mailto:|\/|#)/i.test(decoded)) return label;
      return `<a href="${escapeHtml(decoded)}"${title ? ` title="${escapeHtml(title)}"` : ""}${/^https?:\/\//i.test(decoded) ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  return text
    .replace(/\u0000CODE(\d+)\u0000/g, (_, index) => code[Number(index)] || "")
    .replace(/\u0000MATH(\d+)\u0000/g, (_, index) => `<span class="latex-inline" data-tex="${encodeURIComponent(math[Number(index)] || "")}"></span>`);
}

export function renderMarkdown(value) {
  const displayMath = [];
  const source = String(value ?? "").replace(/\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g, (_, bracket, dollars) => {
    const token = `\n\u0000DISPLAY${displayMath.length}\u0000\n`;
    displayMath.push((bracket ?? dollars ?? "").trim());
    return token;
  });
  const lines = source.replace(/\r\n?/g, "\n").split("\n"), output = [];
  let paragraph = [], listType = "", listItems = [], quote = [], code = [], codeLanguage = "", inCode = false;
  const flushParagraph = () => {
    if (paragraph.length) {
      output.push(`<p>${inlineMarkdown(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems.length) {
      output.push(`<${listType}>${listItems.map(item => `<li>${inlineMarkdown(item)}</li>`).join("")}</${listType}>`);
      listItems = [];
      listType = "";
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      output.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\u0000DISPLAY\d+\u0000$/.test(line)) {
      flushAll();
      output.push(line);
      continue;
    }
    const fence = line.match(/^```\s*([\w-]*)\s*$/);
    if (fence) {
      if (inCode) {
        output.push(`<pre><code${codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        codeLanguage = "";
        inCode = false;
      } else {
        flushAll();
        inCode = true;
        codeLanguage = fence[1] || "";
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const next = lines[index + 1] || "";
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)) {
      flushAll();
      const headers = line.replace(/^\s*\||\|\s*$/g, "").split("|").map(cell => cell.trim()), rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(lines[index].replace(/^\s*\||\|\s*$/g, "").split("|").map(cell => cell.trim()));
        index += 1;
      }
      index -= 1;
      output.push(`<div class="markdown-table-wrap"><table><thead><tr>${headers.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushAll();
      output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushAll();
      output.push("<hr>");
      continue;
    }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/), ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const type = ordered ? "ol" : "ul";
      if (listType && listType !== type) flushList();
      listType = type;
      listItems.push((unordered || ordered)[1]);
      continue;
    }
    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line);
  }
  if (inCode) {
    output.push(`<pre><code${codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
  } else {
    flushAll();
  }
  return output.join("").replace(/\u0000DISPLAY(\d+)\u0000/g, (_, index) => `<div class="latex-display" data-tex="${encodeURIComponent(displayMath[Number(index)] || "")}"></div>`);
}

export function plainPreview(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>#~|]/g, "")
    .replace(/\\[\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
