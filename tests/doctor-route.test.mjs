// tests/doctor-route.test.mjs — Unit tests for GET /api/doctor diagnostic probe and UI.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDoctorRoutes } from "../lib/routes/doctor.mjs";
import { identifiersInRenderedText } from "../tools/rendered-plain-language.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("createDoctorRoutes returns structured diagnostics report without leaking secrets", async () => {
  let capturedStatus = 0;
  let capturedBody = null;
  const jsonMock = (_res, status, body) => {
    capturedStatus = status;
    capturedBody = body;
    return body;
  };

  const routes = createDoctorRoutes({
    getActive: () => ({
      project: "test-project",
      root: { kind: "machine", path: "/tmp/test-project" },
    }),
    getApiKeys: () => ({
      ok: true,
      keys: {
        gemini: { configured: true, masked: "••••abcd", source: "env" },
        openai: { configured: false, masked: "", source: "none" },
        anthropic: { configured: false, masked: "", source: "none" },
      },
    }),
    getHarnessInventory: async () => [
      { name: "pi", status: "ready", installed: true },
      { name: "codex", status: "setup", installed: false },
    ],
    loopbackAuth: false,
    json: jsonMock,
  });

  assert.ok(routes["GET /api/doctor"]);

  await routes["GET /api/doctor"]({}, {});
  assert.equal(capturedStatus, 200);
  assert.equal(capturedBody.ok, true);
  assert.ok(typeof capturedBody.timestamp === "string");
  assert.ok(["ok", "warn", "error"].includes(capturedBody.verdict));
  assert.ok(Array.isArray(capturedBody.checks));
  assert.ok(capturedBody.checks.length >= 5);

  const checkIds = new Set(capturedBody.checks.map((c) => c.id));
  assert.ok(checkIds.has("workspace_root"));
  assert.ok(checkIds.has("provider_gemini"));
  assert.ok(checkIds.has("provider_openai"));
  assert.ok(checkIds.has("coding_harnesses"));
  assert.ok(checkIds.has("loopback_auth"));

  // Check workspace root reporting
  const rootCheck = capturedBody.checks.find((c) => c.id === "workspace_root");
  assert.equal(rootCheck.status, "ok");
  assert.match(rootCheck.detail, /test-project/);

  // Check provider reporting
  const geminiCheck = capturedBody.checks.find((c) => c.id === "provider_gemini");
  assert.equal(geminiCheck.status, "ok");
  assert.match(geminiCheck.detail, /Configured/);

  // Assert no secrets leaked
  const reportString = JSON.stringify(capturedBody);
  assert.equal(reportString.includes("secret"), false);
  assert.equal(reportString.includes("sk-ant"), false);
  assert.equal(reportString.includes("AIza"), false);
});

test("public/index.html includes system check doctor elements and passes plain-language scan", () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.match(indexHtml, /id="settings-run-doctor"/);
  assert.match(indexHtml, /id="settings-doctor-results"/);
  assert.match(indexHtml, /id="settings-doctor-list"/);

  const match = indexHtml.match(/<fieldset[^>]*id="settings-debug-group"[\s\S]*?<\/fieldset>/i);
  assert.ok(match, "settings-debug-group must exist in public/index.html");

  const hits = identifiersInRenderedText(match[0]);
  assert.deepEqual(
    hits,
    [],
    `Expected 0 plain-language hits in settings-debug-group, got: ${JSON.stringify(hits)}`,
  );
});
