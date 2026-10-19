/**
 * Projects supplier reasoning from business records under the server-owned scene contract.
 * Established: 2026-10-19
 * Status: active
 * Boundary: no audit repository access; callers supply their existing domain text limit.
 */
import { invocationSceneContract } from "./invocation-contracts.mjs";

type ReasoningFields = {
  reasoningContent?: string;
  reasoningVisibility?: "user_viewable";
};

/** Normalizes actual reasoning for a durable business result using its domain policy. @since unreleased */
export function businessReasoning(
  scene: string,
  actualReasoning: unknown,
  domainTextLimit: number
): ReasoningFields {
  const contract = invocationSceneContract(scene);
  if (contract.persistenceMode !== "business_result"
    || contract.reasoningVisibility !== "user_viewable") return {};
  const text = typeof actualReasoning === "string"
    ? actualReasoning.trim().slice(0, domainTextLimit)
    : "";
  return text ? {
    reasoningContent: text,
    reasoningVisibility: "user_viewable"
  } : {};
}

/** Removes private and unclassified reasoning from product JSON, including Owner responses. @since unreleased */
export function projectProductReasoning<T>(value: T): T {
  if (Array.isArray(value)) return value.map(projectProductReasoning) as T;
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(source);
  if ((prototype !== Object.prototype && prototype !== null)
    || typeof source.toJSON === "function") return value;
  const visible = source.reasoningVisibility === "user_viewable";
  return Object.fromEntries(Object.entries(source)
    .filter(([key]) => {
      if (["modelReasoning", "partialReasoningContent"].includes(key)) return false;
      if (["reasoningContent", "reasoningVisibility"].includes(key)) return visible;
      return true;
    })
    .map(([key, item]) => [key, projectProductReasoning(item)])) as T;
}
