if (globalThis.__forNowEntryFailed) throw new Error("Application entry load timed out");
const openingRoot = document.querySelector("#opening-screen");
for (const element of document.body.children) if (element !== openingRoot) element.inert = true;
const openingRequest = import("./frontend/opening/index.mjs")
  .then(({ startOpening }) => {
    const controller = startOpening();
    if (globalThis.__forNowEntryFailed) controller.fail();
    return controller;
  })
  .catch(() => {
    for (const element of document.body.children) if (element !== openingRoot) element.inert = true;
    openingRoot.hidden = false;
    openingRoot.removeAttribute("aria-busy");
    openingRoot.dataset.openingState = "failure";
    document.querySelector("#opening-status").textContent = "";
    document.querySelector("#opening-recovery").hidden = false;
    document.querySelector("#opening-retry").onclick = () => location.reload();
    return { ready: async () => false, fail: () => false, dispose: () => {} };
  });
const opening = Object.freeze({
  ready: () => openingRequest.then(controller => (
    globalThis.__forNowEntryFailed ? controller.fail() : controller.ready()
  )),
  fail: error => openingRequest.then(controller => controller.fail(error)),
  dispose: () => openingRequest.then(controller => controller.dispose())
});
globalThis.__forNowOpeningFail = error => opening.fail(error);
void import("./frontend/app/index.mjs")
  .then(({ startApplication }) => startApplication({ opening }))
  .catch(error => opening.fail(error));
