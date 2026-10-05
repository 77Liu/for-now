const openingRoot = document.querySelector("#opening-screen");
for (const element of document.body.children) if (element !== openingRoot) element.inert = true;
const openingRequest = import("./frontend/opening/index.mjs")
  .then(({ startOpening }) => startOpening())
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
  ready: () => openingRequest.then(controller => controller.ready()),
  fail: error => openingRequest.then(controller => controller.fail(error)),
  dispose: () => openingRequest.then(controller => controller.dispose())
});
void import("./frontend/app/index.mjs")
  .then(({ startApplication }) => startApplication({ opening }))
  .catch(error => opening.fail(error));
