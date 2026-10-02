export const viewSections = Object.freeze({
  today: "today",
  together: "today",
  daily: "today",
  captures: "seen",
  books: "seen",
  quotes: "seen",
  keepsakes: "seen",
  journals: "thought",
  thoughts: "thought",
  discovery: "thought",
  review: "thought",
  mine: "mine",
  "personal-context": "mine",
  statistics: "mine",
  "ai-cost": "mine",
  architecture: "mine",
  commercialization: "mine",
  feedback: "mine",
  export: "mine",
  notifications: "mine",
  trash: "mine",
  permission: "mine",
  account: "mine",
  settings: "mine",
  about: "mine"
});

export const ownerViewCapabilities = Object.freeze({
  "ai-cost": "ai-costs",
  architecture: "architecture",
  commercialization: "commercialization"
});

export function createPageRouter({
  query,
  queryAll,
  effects = {},
  canAccessView = () => true,
  onDenied = () => {},
  scrollTo = options => globalThis.scrollTo(options),
  defaultView = "today"
}) {
  const fallbackView = viewSections[defaultView] ? defaultView : "today";
  let currentView = fallbackView;

  function applyView(name, { runEffects = false, resetScroll = false } = {}) {
    let viewName = viewSections[name] ? name : fallbackView;
    const requiredCapability = ownerViewCapabilities[viewName];
    if (requiredCapability && !canAccessView(viewName, requiredCapability)) {
      onDenied(viewName, requiredCapability);
      viewName = "permission";
    }
    const section = viewSections[viewName];
    const sectionNav = query("#section-nav");
    queryAll(".view").forEach(view => view.classList.toggle("active", view.id === `view-${viewName}`));
    queryAll(".nav-button").forEach(button => {
      const active = button.dataset.section === section;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    if (sectionNav) sectionNav.hidden = section === "mine";
    queryAll("[data-section-links]").forEach(group => {
      group.hidden = group.dataset.sectionLinks !== section;
    });
    queryAll(".section-nav button").forEach(button => {
      const active = button.dataset.view === viewName;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    if (runEffects) {
      if (currentView === "quotes" && viewName !== "quotes") effects.leaveQuotes?.();
      effects[viewName]?.();
    }
    currentView = viewName;
    if (resetScroll) scrollTo({ top: 0, behavior: "smooth" });
    return viewName;
  }

  function switchView(name) {
    return applyView(name, { runEffects: true, resetScroll: true });
  }

  function restoreView(name = currentView) {
    return applyView(name);
  }

  return {
    switchView,
    restoreView,
    currentView: () => currentView
  };
}
