import { sanitizeAnalysisRecord } from "./model.mjs";

const noop = () => {};

export function createReviewOperations({
  data,
  view,
  platform,
  getRoot,
  createTicket,
  isCurrent,
  isSameSession,
  render
} = {}) {
  let paginationFlight = null;
  const detailFlights = new Map();
  const writeFlights = new Map();
  const requestIds = new Map();

  const query = selector => getRoot()?.querySelector?.(selector) || null;
  const requestId = key => {
    if (!requestIds.has(key)) requestIds.set(key, platform.createRequestId());
    return requestIds.get(key);
  };
  const applyQueued = (record, ticket) => (
    isSameSession(ticket) ? data.applyPendingProjection(record) : false
  );
  const refreshLater = (domains, ticket, failureMessage) => {
    void data.refresh(domains).catch(error => {
      if (isCurrent(ticket)) {
        view.showToast(`${failureMessage}：${error.message}`, "error");
      }
    });
  };

  function syncControls() {
    const root = getRoot();
    if (!root) return;
    const generation = root.querySelector?.("#run-analysis");
    if (generation) generation.disabled = writeFlights.has("analysis:create");
    const experiment = root.querySelector?.("#experiment-form button[type='submit']");
    if (experiment) experiment.disabled = writeFlights.has("experiment:create");
    const metric = root.querySelector?.("#metric-form button[type='submit']");
    if (metric) metric.disabled = writeFlights.has("metric:create");
    const more = root.querySelector?.("#analysis-load-more");
    if (more) more.disabled = Boolean(paginationFlight);
    for (const button of root.querySelectorAll?.(
      "[data-experiment-delete],[data-analysis-delete]"
    ) || []) {
      const type = button.dataset.experimentDelete ? "experiment" : "analysis";
      const id = button.dataset.experimentDelete || button.dataset.analysisDelete;
      button.disabled = writeFlights.has(`${type}:delete:${id}`);
    }
  }

  function runWrite(key, operation) {
    if (writeFlights.has(key)) return writeFlights.get(key);
    const pending = Promise.resolve().then(operation);
    writeFlights.set(key, pending);
    syncControls();
    const release = () => {
      if (writeFlights.get(key) === pending) writeFlights.delete(key);
      syncControls();
    };
    void pending.then(release, release);
    return pending;
  }

  async function loadAnalysisDetail(id) {
    const item = (data.getSnapshot().analyses || [])
      .find(value => value.id === id);
    if (!item?.contentTruncated) return true;
    if (detailFlights.has(id)) return detailFlights.get(id);
    const ticket = createTicket();
    const status = query(
      `[data-analysis-id="${view.escapeSelector(id)}"] [data-analysis-load-status]`
    );
    if (status) status.textContent = "正在载入完整复盘…";
    const pending = (async () => {
      try {
        const result = await data.requestV1(
          `/api/v1/analyses/${encodeURIComponent(id)}`
        );
        if (!isCurrent(ticket)) return false;
        const snapshot = data.getSnapshot();
        snapshot.analyses = (snapshot.analyses || []).map(value => (
          value.id === id ? sanitizeAnalysisRecord(result.data) : value
        ));
        render();
        return true;
      } catch (error) {
        if (isCurrent(ticket) && status?.isConnected !== false) {
          status.textContent = `完整复盘载入失败：${error.message}`;
        }
        return false;
      }
    })();
    detailFlights.set(id, pending);
    const release = () => {
      if (detailFlights.get(id) === pending) detailFlights.delete(id);
    };
    void pending.then(release, release);
    return pending;
  }

  async function loadMoreAnalyses() {
    if (paginationFlight) return paginationFlight;
    const snapshot = data.getSnapshot();
    const cursor = snapshot.analysisPage?.nextCursor;
    if (!cursor) return false;
    const ticket = createTicket();
    const status = query("#analysis-pagination-status");
    if (status) status.textContent = "正在加载…";
    const pending = (async () => {
      try {
        const result = await data.requestV1(
          `/api/v1/route-state?view=review&cursor=${encodeURIComponent(cursor)}`
        );
        if (!isCurrent(ticket)) return false;
        const page = result.data || {};
        const current = data.getSnapshot();
        const known = new Set((current.analyses || []).map(item => item.id));
        current.analyses = [
          ...(current.analyses || []),
          ...(page.analyses || []).filter(item => !known.has(item.id))
        ];
        current.analysisPage = {
          ...(current.analysisPage || {}),
          ...(page.analysisPage || {})
        };
        render();
        return true;
      } catch (error) {
        if (isCurrent(ticket) && status) {
          status.textContent = `继续加载失败：${error.message}`;
        }
        return false;
      }
    })();
    paginationFlight = pending;
    syncControls();
    const release = () => {
      if (paginationFlight === pending) paginationFlight = null;
      syncControls();
    };
    void pending.then(release, release);
    return pending;
  }

  function generateAnalysis() {
    return runWrite("analysis:create", async () => {
      const ticket = createTicket();
      const status = query("#analysis-status");
      const key = "analysis:create";
      if (status) {
        status.textContent = "正在比较模型草稿与你最终保留的回答，以及你保留、舍弃和长期缺席的主题…";
      }
      try {
        await data.requestV1(
          "/api/v1/analyses",
          {
            method: "POST",
            headers: { "idempotency-key": requestId(key) },
            body: "{}"
          },
          { domains: ["analyses"] }
        );
        requestIds.delete(key);
        if (!isCurrent(ticket)) return false;
        if (status) status.textContent = "";
        refreshLater("review", ticket, "复盘已生成，但页面刷新失败");
        view.showToast("认知复盘已生成");
        return true;
      } catch (error) {
        if (!isCurrent(ticket)) return false;
        if (error.syncStatus === "pending") {
          if (status) status.textContent = "认知复盘已进入待同步队列。";
          view.showToast("认知复盘已进入待同步队列");
        } else if (status) {
          status.textContent = error.message;
        }
        return false;
      }
    });
  }

  function submitExperiment(form, payload) {
    return runWrite("experiment:create", async () => {
      const ticket = createTicket();
      const key = "experiment:create";
      form.dataset.requestId ||= requestId(key);
      try {
        await data.requestV1(
          "/api/v1/experiments",
          {
            method: "POST",
            headers: { "idempotency-key": form.dataset.requestId },
            body: JSON.stringify(payload)
          },
          {
            domains: ["experiments"],
            onQueued: record => applyQueued(record, ticket)
          }
        );
        requestIds.delete(key);
        if (!isCurrent(ticket)) return false;
        delete form.dataset.requestId;
        delete form.dataset.pendingAccepted;
        form.reset();
        refreshLater("review", ticket, "实验已保存，但页面刷新失败");
        return true;
      } catch (error) {
        if (!isCurrent(ticket)) return false;
        if (error.syncStatus === "pending") {
          form.dataset.pendingAccepted = "true";
          form.reset();
          view.showToast("实验已进入待同步队列");
        } else {
          view.showToast(error.message, "error");
        }
        return false;
      }
    });
  }

  function submitMetric(form, payload) {
    return runWrite("metric:create", async () => {
      const ticket = createTicket();
      const key = "metric:create";
      form.dataset.requestId ||= requestId(key);
      try {
        await data.requestV1(
          "/api/v1/custom-metrics",
          {
            method: "POST",
            headers: { "idempotency-key": form.dataset.requestId },
            body: JSON.stringify(payload)
          },
          {
            domains: ["customMetrics"],
            onQueued: record => applyQueued(record, ticket)
          }
        );
        requestIds.delete(key);
        if (!isCurrent(ticket)) return false;
        delete form.dataset.requestId;
        delete form.dataset.pendingAccepted;
        form.reset();
        refreshLater(["review", "checkins"], ticket, "指标已保存，但页面刷新失败");
        return true;
      } catch (error) {
        if (!isCurrent(ticket)) return false;
        if (error.syncStatus === "pending") {
          form.dataset.pendingAccepted = "true";
          form.reset();
          view.showToast("指标已进入待同步队列");
        } else {
          view.showToast(error.message, "error");
        }
        return false;
      }
    });
  }

  function remove(kind, id) {
    const key = `${kind}:delete:${id}`;
    if (writeFlights.has(key)) return writeFlights.get(key);
    const definition = kind === "experiment"
      ? {
        collection: "experiments",
        path: "experiments",
        domains: ["experiments", "review"],
        label: "实验"
      }
      : {
        collection: "analyses",
        path: "analyses",
        domains: ["analyses", "review"],
        label: "复盘"
      };
    const item = (data.getSnapshot()[definition.collection] || [])
      .find(value => value.id === id);
    if (!item || !platform.confirm(`将这条${definition.label}移入回收站？`)) {
      return Promise.resolve(false);
    }
    return runWrite(key, async () => {
      const ticket = createTicket();
      try {
        await data.requestV1(
          `/api/v1/${definition.path}/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
            headers: {
              "if-match": `"${item.version || 1}"`,
              "idempotency-key": requestId(key)
            }
          },
          {
            domains: definition.domains,
            resource: `/api/v1/${definition.path}/${id}`,
            recoverCommitted: true,
            projection: {
              kind: "record.delete",
              domain: definition.collection,
              id
            },
            onQueued: record => applyQueued(record, ticket)
          }
        );
        requestIds.delete(key);
        if (!isCurrent(ticket)) return false;
        refreshLater(
          definition.domains,
          ticket,
          `${definition.label}已移除，但列表刷新失败`
        );
        view.showToast(`${definition.label}已移入回收站`);
        return true;
      } catch (error) {
        if (!isCurrent(ticket)) return false;
        if (error.syncStatus === "pending") {
          view.showToast(`${definition.label}将在网络恢复后移入回收站`);
        } else {
          await data.refresh(definition.domains).catch(noop);
          if (isCurrent(ticket)) view.showToast(error.message, "error");
        }
        return false;
      }
    });
  }

  function releasePendingForm(form) {
    if (form?.dataset?.pendingAccepted !== "true") return false;
    const key = form.id === "experiment-form" ? "experiment:create" : "metric:create";
    if (writeFlights.has(key)) return false;
    delete form.dataset.pendingAccepted;
    delete form.dataset.requestId;
    requestIds.delete(key);
    return true;
  }

  return Object.freeze({
    loadAnalysisDetail,
    loadMoreAnalyses,
    generateAnalysis,
    submitExperiment,
    submitMetric,
    remove,
    releasePendingForm,
    syncControls,
    releaseRoute() {
      paginationFlight = null;
      detailFlights.clear();
    },
    resetSession() {
      paginationFlight = null;
      detailFlights.clear();
      writeFlights.clear();
      requestIds.clear();
    }
  });
}
