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
  statistics: "mine",
  "ai-cost": "mine",
  architecture: "mine",
  commercialization: "mine",
  feedback: "mine",
  export: "mine",
  notifications: "mine",
  trash: "mine",
  account: "mine",
  settings: "mine",
  about: "mine"
});

export function createPageRouter({
  query,
  queryAll,
  effects = {},
  scrollTo = options => globalThis.scrollTo(options)
}) {
  let currentView = "";

  function switchView(name) {
    const section = viewSections[name] || "today";
    const sectionNav = query("#section-nav");
    queryAll(".view").forEach(view => view.classList.toggle("active", view.id === `view-${name}`));
    queryAll(".nav-button").forEach(button => {
      const active = button.dataset.section === section;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    sectionNav.hidden = section === "mine";
    queryAll("[data-section-links]").forEach(group => {
      group.hidden = group.dataset.sectionLinks !== section;
    });
    queryAll(".section-nav button").forEach(button => {
      const active = button.dataset.view === name;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    if (currentView === "quotes" && name !== "quotes") effects.leaveQuotes?.();
    effects[name]?.();
    currentView = name;
    scrollTo({ top: 0, behavior: "smooth" });
  }

  return {
    switchView,
    currentView: () => currentView
  };
}
