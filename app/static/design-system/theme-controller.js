export const PSU_THEMES = ["lavender", "mint", "sky", "amber", "rose", "graphite"];
export const PSU_MODES = ["system", "light", "dark"];

const DEFAULT_THEME = "lavender";
const DEFAULT_MODE = "system";
let mediaQuery = null;
let listener = null;
let activeConfig = null;

function ensureMetaThemeColor() {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  return meta;
}

function readCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function normalizeTheme(theme) {
  return PSU_THEMES.includes(theme) ? theme : DEFAULT_THEME;
}

function normalizeMode(mode) {
  return PSU_MODES.includes(mode) ? mode : DEFAULT_MODE;
}

export function getThemeKeys(appId) {
  if (!appId || typeof appId !== "string") throw new Error("Pixel Soft Utility requires a stable appId.");
  return { themeKey: `${appId}-theme`, modeKey: `${appId}-mode` };
}

export function getStoredThemeState(appId) {
  const { themeKey, modeKey } = getThemeKeys(appId);
  return {
    theme: normalizeTheme(localStorage.getItem(themeKey)),
    mode: normalizeMode(localStorage.getItem(modeKey)),
  };
}

export function resolveMode(mode) {
  const selected = normalizeMode(mode);
  if (selected !== "system") return selected;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyThemeState({ appId, theme = DEFAULT_THEME, mode = DEFAULT_MODE, persist = true } = {}) {
  if (!appId) throw new Error("applyThemeState needs appId.");

  const normalizedTheme = normalizeTheme(theme);
  const normalizedMode = normalizeMode(mode);
  const resolvedMode = resolveMode(normalizedMode);
  const root = document.documentElement;

  root.dataset.theme = normalizedTheme;
  root.dataset.mode = normalizedMode;
  root.dataset.resolvedMode = resolvedMode;

  if (persist) {
    const { themeKey, modeKey } = getThemeKeys(appId);
    localStorage.setItem(themeKey, normalizedTheme);
    localStorage.setItem(modeKey, normalizedMode);
  }

  requestAnimationFrame(() => {
    const meta = ensureMetaThemeColor();
    meta.content = readCssVar("--color-background") || readCssVar("--color-surface-soft") || (resolvedMode === "dark" ? "#101316" : "#FFFBFF");
  });

  window.dispatchEvent(new CustomEvent("psu:themechange", {
    detail: { appId, theme: normalizedTheme, mode: normalizedMode, resolvedMode }
  }));

  return { theme: normalizedTheme, mode: normalizedMode, resolvedMode };
}

export function initPixelSoftUtilityTheme({ appId, defaultTheme = DEFAULT_THEME, defaultMode = DEFAULT_MODE } = {}) {
  if (!appId) throw new Error("initPixelSoftUtilityTheme needs appId.");
  activeConfig = { appId, defaultTheme: normalizeTheme(defaultTheme), defaultMode: normalizeMode(defaultMode) };

  const stored = getStoredThemeState(appId);
  const state = applyThemeState({
    appId,
    theme: stored.theme || activeConfig.defaultTheme,
    mode: stored.mode || activeConfig.defaultMode,
    persist: false,
  });

  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  listener = () => {
    const currentMode = document.documentElement.dataset.mode || DEFAULT_MODE;
    if (currentMode === "system") {
      applyThemeState({ appId, theme: document.documentElement.dataset.theme, mode: "system", persist: false });
    }
  };
  mediaQuery.addEventListener?.("change", listener);
  mediaQuery.addListener?.(listener);
  return state;
}

export function setPixelSoftUtilityTheme(theme) {
  if (!activeConfig) throw new Error("Theme controller is not initialized.");
  return applyThemeState({ appId: activeConfig.appId, theme, mode: document.documentElement.dataset.mode || activeConfig.defaultMode });
}

export function setPixelSoftUtilityMode(mode) {
  if (!activeConfig) throw new Error("Theme controller is not initialized.");
  return applyThemeState({ appId: activeConfig.appId, theme: document.documentElement.dataset.theme || activeConfig.defaultTheme, mode });
}

export function destroyPixelSoftUtilityThemeListener() {
  if (mediaQuery && listener) {
    mediaQuery.removeEventListener?.("change", listener);
    mediaQuery.removeListener?.(listener);
  }
  mediaQuery = null;
  listener = null;
}
