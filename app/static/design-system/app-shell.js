import { initPixelSoftUtilityTheme } from "./theme-controller.js";

export function initPixelSoftUtilityApp(config) {
  const required = ["app_id", "app_name", "app_subtitle", "app_symbol"];
  for (const key of required) {
    if (!config?.[key]) throw new Error(`Missing app manifest field: ${key}`);
  }

  initPixelSoftUtilityTheme({
    appId: config.app_id,
    defaultTheme: config.default_theme || "lavender",
    defaultMode: config.default_mode || "system",
  });

  document.documentElement.dataset.appId = config.app_id;
  document.title = config.app_name;
  setAppMetadata(config);
  renderAppIdentity(config);
  bindHeaderScrollState();
  bindSheetTriggers();
}

export function getResolvedLogoSrc(config) {
  const logo = config?.app_logo;
  if (!logo) return "";
  const mode = document.documentElement.dataset.resolvedMode;
  if (mode === "dark" && logo.dark_src) return logo.dark_src;
  if (mode === "light" && logo.light_src) return logo.light_src;
  return logo.src || "";
}

export function setAppMetadata(config) {
  const logo = config?.app_logo;
  const favicon = logo?.use_as_favicon === false ? "" : (logo?.favicon || logo?.src || "");

  setOrCreateMeta("application-name", config.app_name);
  setOrCreateMeta("apple-mobile-web-app-title", config.app_name);

  if (favicon) {
    const rel = favicon.endsWith(".svg") ? "icon" : "icon";
    setOrCreateLink(rel, favicon, favicon.endsWith(".svg") ? "image/svg+xml" : undefined);
  }
}

function setOrCreateMeta(name, content) {
  let meta = document.head.querySelector(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", name);
    document.head.append(meta);
  }
  meta.setAttribute("content", content);
}

function setOrCreateLink(rel, href, type) {
  let link = document.head.querySelector(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", rel);
    document.head.append(link);
  }
  link.setAttribute("href", href);
  if (type) link.setAttribute("type", type);
}

export function renderAppIdentity(config) {
  const logoSrc = getResolvedLogoSrc(config);
  const logoAlt = config?.app_logo?.alt ?? "";

  document.querySelectorAll("[data-psu-app-name]").forEach((element) => { element.textContent = config.app_name; });
  document.querySelectorAll("[data-psu-app-subtitle]").forEach((element) => { element.textContent = config.app_subtitle; });

  document.querySelectorAll("[data-psu-app-logo]").forEach((img) => {
    if (!logoSrc) {
      img.hidden = true;
      img.closest(".psu-app-symbol, .psu-logo-frame")?.classList.add("psu-logo-missing");
      return;
    }
    img.hidden = false;
    img.alt = logoAlt;
    img.src = logoSrc;
    img.addEventListener("error", () => {
      img.hidden = true;
      img.closest(".psu-app-symbol, .psu-logo-frame")?.classList.add("psu-logo-missing");
    }, { once: true });
  });

  document.querySelectorAll("[data-psu-fallback-symbol]").forEach((svg) => {
    const use = svg.querySelector("use");
    if (use) use.setAttribute("href", `#psu-icon-${config.app_symbol}`);
  });
}

export function bindHeaderScrollState() {
  const header = document.querySelector("[data-psu-app-header]");
  if (!header) return;
  const update = () => header.classList.toggle("is-scrolled", window.scrollY > 4);
  update();
  window.addEventListener("scroll", update, { passive: true });
}

export function bindSheetTriggers() {
  document.addEventListener("click", (event) => {
    const openTrigger = event.target.closest("[data-psu-open]");
    const closeTrigger = event.target.closest("[data-psu-close]");
    const backdrop = event.target.matches(".psu-backdrop") ? event.target : null;

    if (openTrigger) {
      const target = document.querySelector(openTrigger.dataset.psuOpen);
      if (target) {
        target.hidden = false;
        target.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")?.focus();
      }
    }

    if (closeTrigger) {
      closeTrigger.closest(".psu-backdrop")?.setAttribute("hidden", "");
    }

    if (backdrop) backdrop.setAttribute("hidden", "");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      document.querySelectorAll(".psu-backdrop:not([hidden])").forEach((element) => element.setAttribute("hidden", ""));
    }
  });

  window.addEventListener("psu:themechange", () => {
    const configScript = document.querySelector("script[type='application/json'][data-psu-app-config]");
    if (!configScript) return;
    try { renderAppIdentity(JSON.parse(configScript.textContent)); } catch {}
  });
}
