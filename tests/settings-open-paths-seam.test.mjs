import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("all three Settings entry points use the single gear handler, never direct showModal bypasses", () => {
  const source = readFileSync(path.join(root, "public/fused.js"), "utf8");
  const busSource = readFileSync(path.join(root, "public/components/system-command-bus.mjs"), "utf8");
  const owner = readFileSync(path.join(root, "public/settings-ui.mjs"), "utf8");
  assert.match(owner, /on\(els\.settingsOpen, "click", \(\) => \{[\s\S]*?els\.settings\.showModal\(\);[\s\S]*?els\.settingsOpen\.setAttribute\("aria-expanded", "true"\);[\s\S]*?refreshDevices\(\);[\s\S]*?void loadAgentSettings\(\);[\s\S]*?void loadApiKeysSettings\(\);/, "gear handler is the one modal/aria/refresh owner");
  assert.match(busSource, /if \(p === "settings"\) currentEls\.settingsOpen\?\.click\(\);/, "system-command route must invoke the gear handler");
  assert.match(source, /getElementById\("sqeh-dock-settings"\)\?\.addEventListener\("click", \(\) => els\.settingsOpen\?\.click\(\)\);/, "dock route must invoke the gear handler");
  assert.doesNotMatch(source, /els\.settings\?\.showModal\?\.\(\)|getElementById\("settings"\)\?\.showModal/, "no direct Settings opener bypasses refresh and aria");
  assert.match(owner, /on\(els\.settings, "close", \(\) => \{\s*els\.settingsOpen\.setAttribute\("aria-expanded", "false"\);\s*els\.settingsOpen\.focus\(\);/, "native close returns focus to gear");
});
