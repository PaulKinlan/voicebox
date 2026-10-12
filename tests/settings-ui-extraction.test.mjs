import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initSettingsUi } from "../public/settings-ui.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class FakeElement {
  constructor(id) { this.id = id; this.value = ""; this.textContent = ""; this.placeholder = ""; this.disabled = false; this.open = false; this.listeners = new Map(); this.attributes = new Map(); this.focused = false; }
  addEventListener(type, handler) { const listeners = this.listeners.get(type) || []; listeners.push(handler); this.listeners.set(type, listeners); }
  async dispatch(type) { for (const listener of this.listeners.get(type) || []) await listener({ target: this }); }
  showModal() { this.open = true; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  focus() { this.focused = true; }
  replaceChildren(...children) { this.children = children; }
  append(child) { (this.children ??= []).push(child); }
}

const names = ["settings", "settingsOpen", "apiKeysSave", "apiKeysStatus", "apiKeyGemini", "apiKeyOpenai", "apiKeyAnthropic", "apiKeyGeminiStatus", "apiKeyOpenaiStatus", "apiKeyAnthropicStatus"];
const domIds = ["agent-provider-state", "agent-model-state", "agent-voice-state", "agent-timbre-state", "agent-personality-state", "agent-custom-instruction-state", "agent-provider", "agent-model", "agent-voice", "agent-timbre", "agent-personality", "agent-custom-instruction", "agent-base", "agent-base-note"];

function setup(t, { stored = null, active = false } = {}) {
  const old = { document: globalThis.document, localStorage: globalThis.localStorage, window: globalThis.window, fetch: globalThis.fetch };
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const els = Object.fromEntries(names.map((id) => [id, new FakeElement(id)]));
  const byId = Object.fromEntries(domIds.map((id) => [id, new FakeElement(id)]));
  let saved = stored ? JSON.stringify(stored) : null;
  const writes = [];
  globalThis.localStorage = { getItem: (key) => key === "voicebox.agent.settings.v1" ? saved : null,
    setItem: (key, value) => { writes.push([key, value]); saved = value; } };
  globalThis.document = { getElementById: (id) => byId[id] ?? null, activeElement: null,
    createElement: (tag) => new FakeElement(tag) };
  const calls = [];
  const dummy = "DUMMY-NOT-A-REAL-KEY-012345";
  const slots = { gemini: { configured: true, masked: "****345" }, openai: false, anthropic: false };
  let failSave = false;
  globalThis.fetch = async (url, options = {}) => {
    calls.push([url, options]);
    if (url === "/api/keys" && options.method === "PUT") return { ok: !failSave, status: failSave ? 403 : 200, json: async () => failSave ? { why: "refused" } : { ok: true } };
    return { ok: true, json: async () => ({ providers: slots }) };
  };
  const agent = { ok: true, capabilities: [{ id: "gemini", label: "Gemini", available: true, model: "model-a", models: [{ id: "model-a", label: "A" }, { id: "model-b", label: "B" }], voices: [] }],
    requested: { provider: "gemini", model: "model-a", voice: null, timbre: "balanced", personality: "plain", customInstruction: null },
    applied: { model: "model-a" }, pending: {}, personalities: [{ id: "plain", label: "Plain" }], base: { instruction: "base", note: "base", editable: false }, persisted: "host" };
  const requests = [];
  const request = async (url, options = {}) => { requests.push([url, options]); if (options.method === "PUT" && options.body) {
    const patch = JSON.parse(options.body);
    agent.requested = { ...agent.requested, ...patch };
    agent.applied.model = agent.requested.model ?? "model-a";
  } return agent; };
  let restarts = 0;
  globalThis.window = { __voiceboxIsLiveSessionActive: () => active,
    __voiceboxRestartLiveSession: async () => { restarts++; return { restarted: true }; } };
  let health = 0;
  let devices = 0;
  const ui = initSettingsUi({ els, request, health: () => { health++; }, refreshDevices: () => { devices++; }, on: (el, type, handler) => el?.addEventListener(type, handler) });
  return { els, byId, calls, requests, writes, dummy, ui, slots, agent, setFailSave: (val) => { failSave = val; }, get health() { return health; }, get devices() { return devices; }, get restarts() { return restarts; } };
}

test("host has one settings owner and still boots exactly two loaders without import-time requests", () => {
  const source = readFileSync(path.join(root, "public/fused.js"), "utf8");
  assert.match(source, /import \{ initSettingsUi \} from "\.\/settings-ui\.mjs"/);
  assert.match(source, /initSettingsUi\(\{ els, request, health, refreshDevices, on \}\)/);
  assert.equal((source.match(/loadAgentSettings\(\); \/\/ the dialog has real state/g) || []).length, 1);
  assert.equal((source.match(/void loadApiKeysSettings\(\);/g) || []).length, 1);
  assert.doesNotMatch(source, /function describeProviderKeySlot\(/);
  assert.doesNotMatch(source, /const AGENT_SETTINGS_KEY =/);
  assert.match(source, /getToolStatus: \(name\) => lastToolStatus\.get\(name\)/, "v25a keeps a LIVE accessor");
  assert.doesNotMatch(source, /map just below/, "w1f9 stale comment must be repaired");
});

test("settings init installs one open/close path, preserves boot PUT and keeps key plaintext out of status/storage", async (t) => {
  const h = setup(t, { stored: { provider: "gemini", model: "model-a" }, active: true });
  assert.equal(h.requests.length, 0, "initialization must not trigger agent PUT/GET");
  assert.equal(h.calls.length, 0, "initialization must not fetch key status");
  await h.ui.loadAgentSettings();
  assert.equal(h.requests.length, 1, "exactly one boot local-setting PUT");
  assert.equal(h.requests[0][1].method, "PUT");
  await h.ui.loadApiKeysSettings();
  assert.equal(h.els.apiKeyGemini.placeholder, "Saved (****345) — paste to replace");
  await h.els.settingsOpen.dispatch("click");
  assert.equal(h.els.settings.open, true);
  assert.equal(h.els.settingsOpen.attributes.get("aria-expanded"), "true");
  assert.equal(h.devices, 1);
  h.els.settings.open = false;
  await h.els.settings.dispatch("close");
  assert.equal(h.els.settingsOpen.attributes.get("aria-expanded"), "false");
  assert.equal(h.els.settingsOpen.focused, true);

  h.els.apiKeyGemini.value = h.dummy;
  h.els.apiKeyOpenai.value = "  ";
  await h.els.apiKeysSave.dispatch("click");
  const saved = h.calls.filter(([url, options]) => url === "/api/keys" && options.method === "PUT");
  assert.equal(saved.length, 1);
  assert.deepEqual(JSON.parse(saved[0][1].body), { gemini: h.dummy });
  assert.equal(h.els.apiKeyGemini.value, "");
  assert.equal(h.els.apiKeysSave.disabled, false);
  assert.equal(h.health, 1);
  const visible = [...Object.values(h.els), ...Object.values(h.byId)].map((el) => `${el.textContent} ${el.placeholder}`).join(" ");
  assert.doesNotMatch(visible, /DUMMY-NOT-A-REAL-KEY/);
  assert.equal(h.writes.some(([, value]) => value.includes(h.dummy)), false);

  h.setFailSave(true);
  h.els.apiKeyGemini.value = h.dummy;
  await h.els.apiKeysSave.dispatch("click");
  assert.match(h.els.apiKeysStatus.textContent, /Could not save API keys/);
  assert.equal(h.els.apiKeysSave.disabled, false);
  assert.equal(h.els.apiKeyGemini.value, h.dummy, "failed save leaves the unsaved value to retry");
  assert.doesNotMatch(h.els.apiKeysStatus.textContent, /DUMMY-NOT-A-REAL-KEY/);

  h.byId["agent-model"].value = "model-b";
  await h.byId["agent-model"].dispatch("change");
  assert.equal(h.restarts, 1, "active model change restarts live session exactly once");
  assert.match(h.byId["agent-model-state"].textContent, /Reconnected live session with model-b/);
});
