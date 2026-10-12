// public/theme.mjs — theme preference: tri-state (light / dark / system), persisted to localStorage.
//
// voicebox-beads-ri9x, the first slice of voicebox-beads-mvxl. Extracted behaviour-for-behaviour from
// fused.js:152-200, the repo's second-largest collision hotspot (311KB, 123 edits in 30 days).
// Nothing here is new behaviour: the same localStorage key, the same data-theme / data-theme-mode
// attributes, the same system-mode matchMedia listener, the same labels, the same icon swap, and the
// same "an unknown value falls back to light" rule.
//
// THE SEAM, which is the point of the slice: this module is HANDED its three elements instead of
// reaching into fused.js's 124-entry WANTED dictionary, so it cannot grow a dependency on the rest of
// the page. It also binds its own listeners — fused.js's `on()` helper is only a null-safe
// addEventListener, so copying that five-line idea here removes an import rather than adding one.
// fused.js calls initTheme() once at boot; the only other caller is the system-command branch, which
// imports applyTheme from here.

/** The localStorage key holding the person's choice. One owner, exported, so callers cannot disagree. */
export const THEME_KEY = "voicebox:theme";

// The elements this module was handed, and nothing else. Module-owned state: the theme preference is
// this module's concern now, which is what lets a test drive it with fake elements.
let elements = {};
let disposeThemeListeners = null;

/** Null-safe listener wiring, so a page missing one of the three elements still boots. */
function on(el, type, handler) {
  if (!el) return () => {};
  el.addEventListener(type, handler);
  return () => el.removeEventListener?.(type, handler);
}

/**
 * Apply a theme preference: set the document attributes, optionally persist the choice, and sync the
 * select, the state label and the toggle. `mode` is the PREFERENCE ("light" | "dark" | "system");
 * `data-theme` receives the EFFECTIVE scheme, which for "system" is resolved from prefers-color-scheme.
 */
export function applyTheme(mode, { persist = false } = {}) {
  const pref = (mode === "dark" || mode === "light" || mode === "system") ? mode : "light";
  const effective = pref === "system"
    ? (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light")
    : pref;
  document.documentElement.dataset.theme = effective;
  document.documentElement.dataset.themeMode = pref;
  if (persist) {
    try { localStorage.setItem(THEME_KEY, pref); } catch { /* private mode */ }
  }
  if (elements.themeSelect) {
    elements.themeSelect.value = pref;
  }
  if (elements.themeSelectState) {
    elements.themeSelectState.textContent = pref === "system"
      ? `System (${effective})`
      : `${effective.charAt(0).toUpperCase() + effective.slice(1)} mode`;
  }
  if (elements.themeToggle) {
    const isDark = effective === "dark";
    const label = isDark ? "Switch to light mode" : "Switch to dark mode";
    elements.themeToggle.setAttribute("aria-label", label);
    elements.themeToggle.setAttribute("title", label);
    elements.themeToggle.setAttribute("aria-pressed", String(isDark));
    const use = elements.themeToggle.querySelector("use");
    if (use) use.setAttribute("href", isDark ? "#i-sun" : "#i-moon");
  }
}

/**
 * Boot: apply the stored preference, then wire the three ways it can change — the toggle button, the
 * settings select, and the system scheme changing while "system" is selected. Run once, at the point
 * fused.js used to run its own copy, so the timing of the first applyTheme is unchanged.
 */
export function initTheme(ui = {}) {
  // A re-entry replaces only listeners owned by this module, never other page listeners.
  disposeThemeListeners?.();
  elements = ui;
  const hostWindow = window;
  const removers = [];
  let initialTheme = "light";
  try {
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === "dark" || savedTheme === "light" || savedTheme === "system") initialTheme = savedTheme;
  } catch { /* ignore */ }
  applyTheme(initialTheme);
  removers.push(on(ui.themeToggle, "click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next, { persist: true });
  }));
  removers.push(on(ui.themeSelect, "change", () => {
    const next = ui.themeSelect.value;
    applyTheme(next, { persist: true });
  }));
  const media = hostWindow.matchMedia?.("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    if (document.documentElement.dataset.themeMode === "system") applyTheme("system");
  };
  media?.addEventListener?.("change", onSystemChange);
  removers.push(() => media?.removeEventListener?.("change", onSystemChange));

  const onStorage = (event) => {
    let storage;
    try { storage = localStorage; } catch { return; /* blocked site data */ }
    if (event.storageArea !== storage || (event.key !== THEME_KEY && event.key !== null)) return;
    let value = event.newValue;
    // clear() has key=null; re-read the key rather than assuming an unrelated clear changed it.
    if (event.key === null) {
      try { value = storage.getItem(THEME_KEY); } catch { value = null; }
    }
    // applyTheme owns the light fallback for missing/poisoned values. Never echo to storage.
    applyTheme(value);
  };
  hostWindow.addEventListener?.("storage", onStorage);
  removers.push(() => hostWindow.removeEventListener?.("storage", onStorage));

  let active = true;
  const dispose = () => {
    if (!active) return;
    active = false;
    for (const remove of removers) remove();
    if (disposeThemeListeners === dispose) {
      disposeThemeListeners = null;
      elements = {};
    }
  };
  disposeThemeListeners = dispose;
  return dispose;
}
