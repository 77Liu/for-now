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
  const role = ["thoughtAnswer", "followUpAnswer", "annotationShenji"].includes(scene)
    ? optionalPromptText(promptRoleId("answer"))
    : "";
  const contract = optionalPromptText(`ai.scene.${scene}`);
  const style = promptText(`ai.style.${settings.responseStyle || "standard"}`);
  const identity = settings.assistantName ? renderPrompt("ai.identity.named", { assistantName: settings.assistantName }) : "";
  return [basePrompt, role, contract, style, identity].filter(Boolean).join("\n\n");
}

export function userPrompt({ context = "", chain = "", task = "" }) {
  return renderPrompt("ai.user.wrapper", { context, chain, task });
}
