let reviewModuleRequest = null;
let statisticsModuleRequest = null;

async function reviewModule() {
  const pending = reviewModuleRequest || import("./review/controller.mjs");
  reviewModuleRequest = pending;
  try {
    return await pending;
  } catch (error) {
    if (reviewModuleRequest === pending) reviewModuleRequest = null;
    throw error;
  }
}

async function statisticsModule() {
  const pending = statisticsModuleRequest || import("./statistics/controller.mjs");
  statisticsModuleRequest = pending;
  try {
    return await pending;
  } catch (error) {
    if (statisticsModuleRequest === pending) statisticsModuleRequest = null;
    throw error;
  }
}

export async function loadReviewFeatureController(options) {
  return (await reviewModule()).createReviewFeatureController(options);
}

export async function loadStatisticsFeatureController(options) {
  return (await statisticsModule()).createStatisticsFeatureController(options);
}
