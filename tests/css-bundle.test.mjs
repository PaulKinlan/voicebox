// tests/css-bundle.test.mjs — unit tests for readComposedCss helper (voicebox-beads-4gyw)
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readComposedCss, PUBLIC } from "./lib/css-bundle.mjs";

test("readComposedCss: resolves @import rules into a single composed stylesheet", () => {
  const css = readComposedCss(path.join(PUBLIC, "style.css"));
  assert.ok(css.length > 50000, "composed stylesheet should contain extensive CSS declarations");
  assert.match(css, /:root\s*\{[^}]*--ground:/, "composed CSS must include tokens from tokens.css");
  assert.match(css, /\.room\s*\{/, "composed CSS must include stage rules from stage.css");
  assert.match(css, /\.sqeh-deck\s*\{/, "composed CSS must include deck rules from deck.css");
  assert.match(css, /\.settings\s*\{/, "composed CSS must include dialogs rules from dialogs.css");
  assert.match(css, /\.mini-app-container\s*\{/, "composed CSS must include mini-app rules from mini-apps.css");
});
