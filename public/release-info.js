globalThis.CIKE_RELEASE_INFO = Object.freeze({
  appVersion: "0.5.12",
  releaseVersion: "0.5.12",
  cacheVersion: "cike-shell-0.5.12"
});

if (typeof document !== "undefined") {
  const updateReleaseLabels = () => {
    document.querySelectorAll("[data-release-version]").forEach(element => {
      element.textContent = `v${globalThis.CIKE_RELEASE_INFO.appVersion}`;
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateReleaseLabels, { once: true });
  } else {
    updateReleaseLabels();
  }
}
