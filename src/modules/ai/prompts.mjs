import {
  optionalPromptText,
  promptRoleId,
  promptText,
  renderPrompt
} from "../../shared/prompts/index.mjs";

export function systemPrompt() {
  return promptText("ai.system.core");
}

export function systemPromptForScene(basePrompt, scene, settings = {}) {
  const roleName = scene === "perceptionExtraction"
    ? "perception"
    : ["thoughtAnswer", "followUpAnswer", "annotationShenji"].includes(scene)
      ? "answer"
      : "";
  const role = roleName ? optionalPromptText(promptRoleId(roleName)) : "";
  const contract = optionalPromptText(`ai.scene.${scene}`);
  const style = promptText(`ai.style.${settings.responseStyle || "standard"}`);
  const identity = settings.assistantName ? renderPrompt("ai.identity.named", { assistantName: settings.assistantName }) : "";
  return [basePrompt, role, contract, style, identity].filter(Boolean).join("\n\n");
}

export function userPrompt({ context = "", chain = "", task = "" }) {
  return renderPrompt("ai.user.wrapper", { context, chain, task });
}
