const ROUTE = "/api/v1/owner/ai-budget";

const invalidCommand = () => Object.assign(new Error(
  "AI budget command must be addTemporaryBudget or recover"
), {
  statusCode: 400,
  code: "AI_BUDGET_COMMAND_INVALID"
});

export function createAiBudgetHttp({ budget, bodyJson, getActorId }) {
  if (!budget
    || typeof budget.status !== "function"
    || typeof budget.ownerAddTemporaryBudget !== "function"
    || typeof budget.ownerRecover !== "function") {
    throw new TypeError("AI budget HTTP requires the budget status and Owner commands");
  }
  if (typeof bodyJson !== "function" || typeof getActorId !== "function") {
    throw new TypeError("AI budget HTTP requires bodyJson and getActorId");
  }

  async function handleV1(req, res, url, v1) {
    if (url.pathname !== ROUTE || !["GET", "PATCH"].includes(req.method)) return false;
    res.setHeader("cache-control", "no-store");

    if (req.method === "GET") {
      const status = await budget.status();
      return v1.success(res, 200, status, {
        etag: v1.versionEtag(status.controlVersion)
      });
    }

    const expectedVersion = v1.expectedVersion(req);
    const input = await bodyJson(req);
    if (!["addTemporaryBudget", "recover"].includes(input.command)) throw invalidCommand();
    const actorId = await getActorId();
    const common = {
      scope: input.scope,
      actorId,
      reason: input.reason,
      expectedVersion
    };
    const result = input.command === "addTemporaryBudget"
      ? await budget.ownerAddTemporaryBudget({ ...common, amountCny: input.amountCny })
      : await budget.ownerRecover(common);
    return v1.success(res, 200, result.status, {
      etag: v1.versionEtag(result.status.controlVersion)
    });
  }

  return { handleV1 };
}
