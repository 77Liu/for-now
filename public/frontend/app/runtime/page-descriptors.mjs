import { escapeHtml, plainPreview, presentError, renderMarkdown } from "../../content/index.mjs";
import { createHomeFeatureController } from "../../features/home/index.mjs";
import { uploadOriginalImages, validatedImageFiles } from "../../media/index.mjs";
import { createUnavailableRouteResult } from "../../pages/index.mjs";
import { sessionSerial } from "../../session/index.mjs";
import { publishDomains, state } from "../../state/index.mjs";
import {
  entryKeyIntent,
  eventDate,
  eventTimestamp,
  formatDate,
  formatDateKey,
  formatTime,
  localDateKey,
  localDateTimeForDate,
  toLocalDateTimeInput
} from "../../time/index.mjs";
import { installAccountDescriptors } from "./page-descriptors-account.mjs";
import { installInsightsDescriptors } from "./page-descriptors-insights.mjs";
import { installPrimaryDescriptors } from "./page-descriptors-primary.mjs";

export function createPageFeatureDescriptors(ports = {}) {
  const shared = {
    ...ports,
    createHomeFeatureController,
    state,
    sessionSerial,
    publishDomains,
    escapeHtml,
    plainPreview,
    presentError,
    renderMarkdown,
    uploadOriginalImages,
    validatedImageFiles,
    createUnavailableRouteResult,
    entryKeyIntent,
    eventDate,
    eventTimestamp,
    formatDate,
    formatDateKey,
    formatTime,
    localDateKey,
    localDateTimeForDate,
    toLocalDateTimeInput
  };
  const descriptors = {};
  Object.assign(shared, installPrimaryDescriptors(descriptors, shared));
  installInsightsDescriptors(descriptors, shared);
  installAccountDescriptors(descriptors, shared);
  return descriptors;
}
