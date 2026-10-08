export { createOpeningPreferencesController } from "./opening-controller.mjs";
import { createAccountFeatureController } from "./account-controller.mjs";
import { createSettingsFeatureController } from "./settings-controller.mjs";

export { createAccountFeatureController } from "./account-controller.mjs";
export { createLocalTestController } from "./local-test.mjs";
export {
  DEFAULT_LLM_PROFILES,
  DEFAULT_LLM_SCENARIOS,
  DEFAULT_SCENE_EFFORTS,
  LLM_EFFORTS,
  LLM_TIERS,
  RESPONSE_STYLE_OPTIONS,
  RESPONSE_STYLE_SCENES,
  accountTtsVoice,
  normalizeAccountSettings,
  normalizeTtsGenerationRate,
  settingsPayload,
  speechPreviewPayload,
  ttsGenerationRateText
} from "./model.mjs";
export {
  ACCOUNT_SELECTORS,
  SETTINGS_SELECTORS,
  escapeMarkup,
  renderAccountIdentity,
  renderAccountRoles,
  renderGenerationRate,
  renderLocalTest,
  renderSettingsForm
} from "./presentation.mjs";
export { createSettingsFeatureController } from "./settings-controller.mjs";
export { createVoicePreviewController } from "./voice-preview.mjs";

export function createAccountSettingsFeatureControllers({
  auth,
  session,
  request,
  currentUser,
  settings,
  speech,
  localTest,
  pageAudio,
  capabilities,
  toast,
  confirm
} = {}) {
  return Object.freeze({
    account: createAccountFeatureController({
      auth,
      request: request?.json,
      currentUser,
      hasCapability: capabilities?.has,
      showToast: toast,
      confirmAction: confirm
    }),
    settings: createSettingsFeatureController({
      request,
      currentUser,
      settings,
      speech,
      localTest,
      session,
      pageAudio,
      hasCapability: capabilities?.has,
      showToast: toast,
      confirmAction: confirm
    })
  });
}
