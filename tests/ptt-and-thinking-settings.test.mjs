// tests/ptt-and-thinking-settings.test.mjs — Unit tests for hiding Push to talk
// unless toggled in Settings, and placing Extended thinking depth under Agent Settings
// wired to /live audio and vision sessions.
//
//   node --test tests/ptt-and-thinking-settings.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertInClientSources } from "./lib/client-sources.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const liveVoiceJs = fs.readFileSync(path.join(ROOT, "public", "live-voice.js"), "utf8");
const helpHtml = fs.readFileSync(path.join(ROOT, "public", "help.html"), "utf8");
const serverSource = fs.readFileSync(path.join(ROOT, ["server", "mjs"].join(".")), "utf8");

test("public/index.html hides #vision-ptt-btn by default and provides #setting-ptt-enabled in Settings", () => {
  const pttBtnMatch = indexHtml.match(/<button[^>]*\bid="vision-ptt-btn"[^>]*>/);
  assert.ok(pttBtnMatch, "#vision-ptt-btn must exist in public/index.html");
  assert.match(
    pttBtnMatch[0],
    /\bhidden\b/,
    "#vision-ptt-btn must have the hidden attribute by default so Push to talk is hidden unless toggled on in Settings",
  );

  assert.match(
    indexHtml,
    /id="ptt-settings-row"/,
    "#ptt-settings-row must exist in Settings",
  );
  assert.match(
    indexHtml,
    /<input[^>]*type="checkbox"[^>]*id="setting-ptt-enabled"/,
    "#setting-ptt-enabled checkbox must exist in Settings",
  );
  assert.match(
    indexHtml,
    /id="setting-ptt-state"/,
    "#setting-ptt-state description must exist in Settings",
  );
});

test("public/index.html places #setting-thinking-level inside Agent Settings rather than inside #settings-live-vision", () => {
  const agentSectionIdx = indexHtml.indexOf(">Agent Settings<");
  const agentModelIdx = indexHtml.indexOf('id="agent-model"');
  const thinkingLevelIdx = indexHtml.indexOf('id="setting-thinking-level"');
  const thinkingStateIdx = indexHtml.indexOf('id="setting-thinking-level-state"');
  const liveVisionFieldsetIdx = indexHtml.indexOf('id="settings-live-vision"');

  assert.ok(agentSectionIdx !== -1, "Agent Settings heading must exist");
  assert.ok(agentModelIdx !== -1, "#agent-model must exist");
  assert.ok(thinkingLevelIdx !== -1, "#setting-thinking-level must exist");
  assert.ok(thinkingStateIdx !== -1, "#setting-thinking-level-state must exist");
  assert.ok(liveVisionFieldsetIdx !== -1, "#settings-live-vision fieldset must exist");

  assert.ok(
    thinkingLevelIdx > agentModelIdx && thinkingLevelIdx < liveVisionFieldsetIdx,
    "Extended thinking depth (#setting-thinking-level) must sit inside Agent Settings after #agent-model and before #settings-live-vision",
  );

  const liveVisionBlock = indexHtml.slice(
    liveVisionFieldsetIdx,
    indexHtml.indexOf("</fieldset>", liveVisionFieldsetIdx),
  );
  assert.equal(
    liveVisionBlock.includes('id="setting-thinking-level"'),
    false,
    "#setting-thinking-level must not remain inside #settings-live-vision",
  );
});

test("the client wires settingPttEnabled visibility toggle and restarts active live session on settingThinkingLevel change", () => {
  assertInClientSources(ROOT, /settingPttEnabled:\s*"setting-ptt-enabled"/);
  assertInClientSources(ROOT, /settingPttState:\s*"setting-ptt-state"/);
  assertInClientSources(ROOT, /settingThinkingLevelState:\s*"setting-thinking-level-state"/);

  assertInClientSources(ROOT,
    /els\.settingPttEnabled\?\.addEventListener\("change"/,
    "the client must listen for changes on #setting-ptt-enabled",
  );
  assertInClientSources(ROOT,
    /els\.visionPttBtn\.hidden\s*=\s*!enabled/,
    "the client must toggle els.visionPttBtn.hidden when #setting-ptt-enabled changes",
  );
  // RE-POINTED TO THE HANDLER, NOT THE WIRING (voicebox-beads-uei2.12). The old marker wanted the two
  // globals within 160 characters of each other, which the extraction made true by accident: fused.js now
  // passes `isLiveSessionActive` and `restartLiveSession` as adjacent closures over those globals, so the
  // assertion would have kept passing while saying nothing about the change handler at all. The fact it is
  // meant to pin is the handler's, so it is asserted where the handler is: guarded by the live-session
  // question, in the same block, calling the restart. tests/vision-controls-extraction.test.mjs drives the
  // rule as well, including that the question is asked at the moment of the change (not captured at init).
  assertInClientSources(ROOT,
    /if \(isLiveSessionActive\?\.\(\)\)\s*\{[\s\S]{0,120}restartLiveSession\?\.\(\)/,
    "the client must restart the active live session when #setting-thinking-level changes",
  );
});

test("public/live-voice.js and server.mjs wire thinkingLevel through the /live WebSocket handshake", () => {
  assert.match(
    liveVoiceJs,
    /params\.set\("thinkingLevel",\s*thinkingLevel\)/,
    "public/live-voice.js must pass thinkingLevel on the /live WebSocket query string",
  );
  assert.match(
    serverSource,
    /url\.searchParams\.get\("thinkingLevel"\)/,
    "server.mjs must read thinkingLevel from the /live WebSocket URL query string",
  );
  assert.match(
    serverSource,
    /thinkingLevel:\s*requestedThinkingLevel/,
    "server.mjs must forward thinkingLevel into createLiveSession",
  );
});

test("public/help.html documents Push to talk Settings toggle and Extended thinking depth under Agent Settings", () => {
  assert.match(
    helpHtml,
    /enable <strong>Push to talk<\/strong> in Settings/i,
    "public/help.html must note that Push to talk is enabled in Settings",
  );
  assert.match(
    helpHtml,
    /Extended thinking depth[\s\S]{0,120}Agent Settings[\s\S]{0,120}audio and video sessions/i,
    "public/help.html must note that Extended thinking depth is under Agent Settings for both audio and video sessions",
  );
});
