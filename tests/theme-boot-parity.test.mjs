// tests/theme-boot-parity.test.mjs — the pre-paint guard must answer exactly like the module it shadows.
//
// public/theme-boot.js has to restate four decisions that public/theme.mjs owns: the localStorage key,
// the light|dark|system whitelist with anything else falling back to light, the matchMedia resolution of
// "system", and the two attribute names (data-theme = effective scheme, data-theme-mode = preference).
// It cannot import the module — that is the deferred module it exists to work around — so the
// restatement is unavoidable, and a restatement that drifts is a bug that no other test in this repo can
// see: both files would keep working, on different answers.
//
// So this is not a "the file contains a string" test. It runs BOTH implementations through the SAME fake
// DOM over the same matrix and refuses any disagreement in the attributes they produce. Change either
// side's key, whitelist, fallback or attribute names and this goes red.
//
//   node --test tests/theme-boot-parity.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEME_KEY, initTheme } from "../public/theme.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT_SRC = fs.readFileSync(path.join(here, "..", "public", "theme-boot.js"), "utf8");

/** A DOM small enough to be honest about what it proves: only what these two implementations touch. */
function fakeEnv({ stored, osDark, storageThrows = false }) {
  const store = stored === undefined ? {} : { [THEME_KEY]: stored };
  const dataset = {};
  const listeners = [];
  const document = { documentElement: { dataset } };
  const localStorage = {
    getItem(key) {
      if (storageThrows) throw new Error("site data blocked");
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem() {},
  };
  const window = {
    matchMedia(query) {
      return { matches: /prefers-color-scheme:\s*dark/.test(query) ? osDark : false, addEventListener(type) { listeners.push(type); } };
    },
  };
  return { dataset, document, localStorage, window, listeners };
}

/** Run the guard the way the browser does: a classic script that sees the globals as globals. */
function runBoot(env) {
  new Function("window", "document", "localStorage", BOOT_SRC)(env.window, env.document, env.localStorage);
  return { theme: env.dataset.theme, mode: env.dataset.themeMode };
}

/** Run the real module's boot entry point against the same fake globals. */
function runInitTheme(env) {
  const saved = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
  globalThis.window = env.window;
  globalThis.document = env.document;
  globalThis.localStorage = env.localStorage;
  try {
    initTheme({});
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.localStorage = saved.localStorage;
  }
  return { theme: env.dataset.theme, mode: env.dataset.themeMode };
}

test("theme-boot.js restates theme.mjs's key verbatim, so a rename cannot silently diverge", () => {
  assert.ok(
    BOOT_SRC.includes(`"${THEME_KEY}"`),
    `public/theme-boot.js must name the storage key as theme.mjs exports it (${JSON.stringify(THEME_KEY)}). It is the one string that cannot be checked behaviourally in the browser, because a wrong key reads nothing and looks like "nothing stored".`,
  );
  // The guard must be a CLASSIC script: type=module or defer would put it back after the first paint,
  // which is the entire defect. Asserted here because the file is the thing that must not change.
  assert.equal(/^\s*import\s|\bexport\s/.test(BOOT_SRC.replace(/^\/\/.*$/gm, "")), false, "theme-boot.js must not be module syntax");
});

test("theme-boot.js and theme.mjs produce IDENTICAL attributes across the whole matrix", () => {
  const storedValues = [undefined, "light", "dark", "system", "bogus", "", "Dark", "system "];
  const disagreements = [];
  let cases = 0;

  for (const stored of storedValues) {
    for (const osDark of [false, true]) {
      for (const storageThrows of [false, true]) {
        const label = `stored=${JSON.stringify(stored)} osDark=${osDark} storageThrows=${storageThrows}`;
        const boot = runBoot(fakeEnv({ stored, osDark, storageThrows }));
        const module = runInitTheme(fakeEnv({ stored, osDark, storageThrows }));
        cases += 1;
        if (boot.theme !== module.theme || boot.mode !== module.mode) {
          disagreements.push(`${label}: theme-boot.js ${JSON.stringify(boot)} vs theme.mjs ${JSON.stringify(module)}`);
        }
      }
    }
  }

  assert.deepEqual(
    disagreements,
    [],
    `the guard and the module must agree on every input; a disagreeing restatement is a second answer to "what theme is it". Cases: ${cases}`,
  );
});

test("the agreed answer is the contract people rely on, stated independently of both implementations", () => {
  const expected = [
    [{ stored: undefined, osDark: false }, { theme: "light", mode: "light" }, "nothing stored, light OS"],
    [{ stored: undefined, osDark: true }, { theme: "light", mode: "light" }, "nothing stored stays light, it does NOT silently follow the OS"],
    [{ stored: "light", osDark: true }, { theme: "light", mode: "light" }, "an explicit light choice beats a dark OS"],
    [{ stored: "dark", osDark: false }, { theme: "dark", mode: "dark" }, "an explicit dark choice beats a light OS"],
    [{ stored: "system", osDark: true }, { theme: "dark", mode: "system" }, "system resolves to the OS scheme, and the PREFERENCE stays system"],
    [{ stored: "system", osDark: false }, { theme: "light", mode: "system" }, "system on a light OS"],
    [{ stored: "bogus", osDark: true }, { theme: "light", mode: "light" }, "an unknown stored value falls back to light, as theme.mjs documents"],
    [{ stored: "dark", osDark: false, storageThrows: true }, { theme: "light", mode: "light" }, "storage blocked: the same light default initTheme uses, NOT system"],
  ];
  for (const [input, want, why] of expected) {
    assert.deepEqual(runBoot(fakeEnv(input)), want, `theme-boot.js: ${why}`);
  }
});
