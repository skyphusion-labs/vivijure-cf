// Shared Vivijure studio chrome: top-bar page nav from one config.
//
// Deployers can override window.VIVIJURE_STUDIO_NAV before this script runs.
// Hrefs are relative (no leading slash) and resolved against the current page,
// so the studio works at any mount path. Pretty paths (/planner, /cast,
// /modules) are rewritten to *.html by the worker; modules.html is also served
// as a static asset if the rewrite is not deployed yet.

(function () {
  // cf#647: primary nav is filmmaker surfaces. Modules and Settings stay
  // reachable from the account menu (operators still use them daily).
  const DEFAULT_NAV = [
    { id: "planner", label: "Planner", href: "planner" },
    { id: "cast", label: "Cast", href: "cast" },
  ];
  const OPERATOR_NAV = [
    { id: "pipeline", label: "Modules", href: "modules" },
    { id: "settings", label: "Settings", href: "settings" },
  ];

  const nav = Array.isArray(window.VIVIJURE_STUDIO_NAV)
    ? window.VIVIJURE_STUDIO_NAV
    : DEFAULT_NAV;

  function currentPage() {
    const tagged = document.body.dataset.studioPage;
    if (tagged) return tagged;
    const path = window.location.pathname.replace(/\/$/, "") || "/";
    const leaf = path.split("/").pop() || "";
    if (leaf === "modules" || leaf === "modules.html" || leaf === "index.html") return "pipeline";
    if (leaf === "planner" || leaf === "planner.html") return "planner";
    if (leaf === "cast" || leaf === "cast.html") return "cast";
    if (leaf === "settings" || leaf === "settings.html") return "settings";
    if (path === "/") return "pipeline";
    return "";
  }

  function pageHref(href) {
    return new URL(href, document.baseURI).href;
  }

  const page = currentPage();

  document.querySelectorAll("[data-studio-nav]").forEach((host) => {
    host.replaceChildren();
    for (const item of nav) {
      if (!item || !item.href) continue;
      const a = document.createElement("a");
      a.className = "studio-nav-link";
      a.href = pageHref(item.href);
      a.textContent = item.label || item.id || item.href;
      if (item.id && item.id === page) {
        a.classList.add("is-current");
        a.setAttribute("aria-current", "page");
      }
      host.appendChild(a);
    }
  });

  // Rewrite static brand links that use the pretty studio paths.
  document.querySelectorAll('.brand-vivijure[href="planner"]').forEach((el) => {
    el.href = pageHref("planner");
  });

  const menu = document.getElementById("account-menu");
  if (menu) {
    const primaryIds = new Set(nav.map((item) => item && item.id).filter(Boolean));
    let host = menu.querySelector("[data-studio-account-ops]");
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("data-studio-account-ops", "");
      host.className = "account-ops";
      const prefs = menu.querySelector(".account-prefs");
      if (prefs) menu.insertBefore(host, prefs);
      else menu.appendChild(host);
    }
    host.replaceChildren();
    for (const item of OPERATOR_NAV) {
      if (!item || !item.href || primaryIds.has(item.id)) continue;
      const a = document.createElement("a");
      a.className = "account-row";
      a.setAttribute("role", "menuitem");
      a.href = pageHref(item.href);
      a.textContent = item.label || item.id || item.href;
      if (item.id && item.id === page) a.setAttribute("aria-current", "page");
      host.appendChild(a);
    }
    if (!host.childNodes.length) host.remove();
  }
})();
