import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { createHealthImageConfig, normalizeHealthImage } from "../../modules/health/index.mjs";
import {
  cleanAttachmentPaths,
  cleanupTemporaryFiles
} from "../../shared/attachments/index.mjs";
import { promptText, renderPrompt } from "../../shared/prompts/index.mjs";

const PARSE_ERROR = "截图已读取，但模型返回格式无法解析，请重试或手动填写";

export function createVisionWorkflows({
  attachments,
  materializeAttachmentFiles,
  visionProvider,
  ocrGate,
  aiBudgetRuntime,
  providerBudgetStage,
  conservativeDeepSeekStage,
  currentBudgetAccountId,
  meteredProviderCall,
  runDeepSeek,
  today,
  createId = () => crypto.randomUUID()
}) {
  if (!attachments?.save || !attachments?.discard
    || typeof materializeAttachmentFiles !== "function"
    || typeof visionProvider?.configured !== "boolean"
    || typeof visionProvider?.recognizeText !== "function"
    || typeof ocrGate?.acquire !== "function") {
    throw new TypeError("Vision workflows require attachments, provider and OCR gate");
  }
  if (typeof aiBudgetRuntime?.executeTask !== "function"
    || typeof providerBudgetStage !== "function"
    || typeof conservativeDeepSeekStage !== "function"
    || typeof currentBudgetAccountId !== "function"
    || typeof meteredProviderCall !== "function"
    || typeof runDeepSeek !== "function") {
    throw new TypeError("Vision workflows require explicit AI budget and generation ports");
  }
  if (typeof today !== "function" || typeof createId !== "function") {
    throw new TypeError("Vision workflows require date and id functions");
  }

  const imageParseConfig = {
    ...createHealthImageConfig(),
    book: {
      scene: "bookRecognition",
      maxImages: 1,
      prompt: promptText("health.image.book")
    }
  };

  async function recognizeVisualFiles(
    files,
    { budgetExecution = null, stageIds = [] } = {}
  ) {
    if (!visionProvider.configured) return null;
    const results = [];
    for (const [index, file] of files.entries()) {
      const data = await fs.readFile(file);
      const release = await ocrGate.acquire();
      try {
        results.push(await meteredProviderCall({
          provider: "volcengine",
          service: "vision",
          scene: "visionOcr",
          action: "OCRNormal",
          request: { imageBytes: data.length },
          modality: "vision",
          imageCount: 1,
          imageBytes: data.length,
          unitType: "call",
          units: 1
        }, () => visionProvider.recognizeText({ data }), undefined, budgetExecution ? {
          execution: budgetExecution,
          stageId: stageIds[index]
        } : null));
      } finally {
        release();
      }
    }
    return results.map((result, index) => (
      `<image index="${index + 1}">\n${result.text || "（未识别到文字）"}\n</image>`
    )).join("\n");
  }

  const ocrStages = files => (
    visionProvider.configured ? files.map((_, index) => `ocr-${index + 1}`) : []
  );
  const ocrBudgetStage = id => providerBudgetStage({
    provider: "volcengine",
    service: "vision",
    scene: "visionOcr",
    action: "OCRNormal",
    unitType: "call",
    units: 1
  }, id);

  async function parseImageRequest(input, kind) {
    const config = imageParseConfig[kind];
    if (!config) throw new Error("不支持这种截图类型");
    const images = Array.isArray(input.images) ? input.images : input.image ? [input.image] : [];
    const requestedPaths = Array.isArray(input.attachmentPaths) ? input.attachmentPaths : [];
    const attachmentPaths = cleanAttachmentPaths(requestedPaths);
    if (images.length && requestedPaths.length) throw new Error("截图只能使用一种上传方式");
    if (requestedPaths.length
      && (attachmentPaths.length !== requestedPaths.length
        || attachmentPaths.length > config.maxImages)) {
      throw new Error(`最多提交 ${config.maxImages} 张有效截图`);
    }
    if (!images.length && !attachmentPaths.length) {
      throw new Error(kind === "sleep" ? "睡眠识别需要 1～2 张图片" : "请先上传截图");
    }
    const uploaded = attachmentPaths.length
      ? {
          files: await materializeAttachmentFiles(attachmentPaths),
          attachmentPaths,
          cleanupFiles: []
        }
      : await attachments.save(images, config.maxImages, { needsLocalFiles: true });
    if (attachmentPaths.length) uploaded.cleanupFiles = uploaded.files;
    try {
      const ocrStageIds = ocrStages(uploaded.files);
      const modelStageId = "deepseek-extraction";
      return await aiBudgetRuntime.executeTask({
        accountId: currentBudgetAccountId(),
        taskId: `image-parse:${createId()}`,
        stages: [
          ...ocrStageIds.map(ocrBudgetStage),
          conservativeDeepSeekStage({
            id: modelStageId,
            scene: config.scene,
            model: visionProvider.configured ? "deepseek-v4-pro" : "deepseek-flash"
          })
        ]
      }, async budgetExecution => {
        const referenceDate = /^\d{4}-\d{2}-\d{2}$/.test(input.referenceDate || "")
          ? input.referenceDate
          : today();
        const dateContext = renderPrompt("health.image.referenceDate", {
          referenceDate
        });
        const recognizedText = await recognizeVisualFiles(uploaded.files, {
          budgetExecution,
          stageIds: ocrStageIds
        });
        const raw = await runDeepSeek(
          recognizedText
            ? `${config.prompt}${dateContext}\n\n以下是火山 OCR 提取的原始文字，请只据此提取字段；无法确认的字段保持为空：\n${recognizedText}`
            : `${config.prompt}${dateContext}`,
          {
            scene: config.scene,
            ...(recognizedText ? {} : { imagePaths: uploaded.files }),
            json: true,
            maxTokens: 4000,
            budgetExecution,
            budgetStageIds: [modelStageId]
          }
        );
        let parsed = {};
        try {
          parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "");
        } catch {
          throw new Error(PARSE_ERROR);
        }
        if (!["sleep", "heartRate", "weight", "exercise"].includes(kind)) {
          throw new Error("不支持这种截图类型");
        }
        return {
          ...normalizeHealthImage(kind, parsed),
          attachmentPaths: uploaded.attachmentPaths
        };
      });
    } catch (error) {
      if (!attachmentPaths.length) await attachments.discard(uploaded.attachmentPaths);
      throw error;
    } finally {
      await cleanupTemporaryFiles(uploaded.cleanupFiles);
    }
  }

  async function recognizeBook(files) {
    const config = imageParseConfig.book;
    const ocrStageIds = ocrStages(files);
    const modelStageId = "deepseek-book";
    return aiBudgetRuntime.executeTask({
      accountId: currentBudgetAccountId(),
      taskId: `book-recognition:${createId()}`,
      stages: [
        ...ocrStageIds.map(ocrBudgetStage),
        conservativeDeepSeekStage({
          id: modelStageId,
          scene: config.scene,
          model: visionProvider.configured ? "deepseek-v4-pro" : "deepseek-flash"
        })
      ]
    }, async budgetExecution => {
      const recognizedText = await recognizeVisualFiles(files, {
        budgetExecution,
        stageIds: ocrStageIds
      });
      return runDeepSeek(
        recognizedText
          ? `${config.prompt}\n\n以下是火山 OCR 提取的原始文字，请只据此提取字段；无法确认的字段保持为空：\n${recognizedText}`
          : config.prompt,
        {
          scene: config.scene,
          ...(recognizedText ? {} : { imagePaths: files }),
          json: true,
          maxTokens: 4000,
          budgetExecution,
          budgetStageIds: [modelStageId]
        }
      );
    });
  }

  return {
    imageParseConfig,
    recognizeVisualFiles,
    parseImageRequest,
    recognizeBook
  };
}
