import {
  createAliyunSegmentationTransport,
  createVolcengineSpeechTransport,
  createVolcengineVisionTransport
} from "../../infrastructure/ai-providers/index.mjs";
import { createRateGate } from "../../shared/concurrency/index.mjs";

export function createMediaProviders({
  speechConfig = {},
  visionConfig = {},
  segmentationConfig = {},
  speechQps,
  speechConcurrency,
  ocrQps,
  ocrConcurrency,
  documentQps,
  documentConcurrency,
  segmentationQps,
  segmentationConcurrency,
  meteredProviderCall,
  suppliedSpeechProvider = null,
  suppliedVisionProvider = null,
  suppliedSegmentationProvider = null
}) {
  if (typeof meteredProviderCall !== "function") {
    throw new TypeError("Media providers require meteredProviderCall");
  }

  const segmentationGate = createRateGate(segmentationQps, segmentationConcurrency);
  const speechGate = createRateGate(speechQps, speechConcurrency);
  const ocrGate = createRateGate(ocrQps, ocrConcurrency);
  const documentParseGate = createRateGate(documentQps, documentConcurrency);
  const speechProvider = suppliedSpeechProvider
    || createVolcengineSpeechTransport(speechConfig);
  const visionProvider = suppliedVisionProvider
    || createVolcengineVisionTransport(visionConfig);
  const segmentationProvider = suppliedSegmentationProvider
    || createAliyunSegmentationTransport({
      ...segmentationConfig,
      auditCall: meteredProviderCall
    });

  return {
    segmentationGate,
    speechGate,
    ocrGate,
    documentParseGate,
    speechProvider,
    visionProvider,
    segmentationProvider
  };
}
