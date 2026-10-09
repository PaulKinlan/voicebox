// tests/extension-tracing.test.mjs — Verify rich detailed extension lifecycle logging (voicebox-beads-4gv)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { callTool, createAndAdmitExtension, setHostHooks } from "../lib/extensions.mjs";
import { colorizeTags, TAG_COLORS, RESET_COLOR } from "../lib/logger.mjs";

test("extension logging: detailed traces on invocation and refusal", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-ext-trace-"));
  const workspace = path.join(scratch, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  t.after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  setHostHooks({
    activeRoot: () => ({ project: "test", root: { kind: "machine", path: workspace, environment: "env_test" } }),
  });

  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => { logs.push(args.join(" ")); origLog.apply(console, args); };
  console.error = (...args) => { errors.push(args.join(" ")); origError.apply(console, args); };
  t.after(() => {
    console.log = origLog;
    console.error = origError;
  });

  // 1. Invocation of unknown tool logs invocation and refusal trace
  const unknownRes = await callTool("missing_calc", { query: "42" });
  assert.equal(unknownRes.ok, false);
  assert.ok(logs.some((l) => l.includes("[extension] calling 'missing_calc' args={\"query\":\"42\"}")));
  assert.ok(errors.some((e) => e.includes("[extension:refused] unknown-tool: no tool 'missing_calc' in the loaded set")));
});

test("color-coded extension tags: colorizeTags applies distinct ANSI styling for extension channels", () => {
  const netLog = colorizeTags("[extension:network] fetch https://example.com", true);
  assert.equal(netLog, `${TAG_COLORS["extension:network"]}[extension:network]${RESET_COLOR} fetch https://example.com`);

  const wasmLog = colorizeTags("[extension:wasm] diff executed in 2ms", true);
  assert.equal(wasmLog, `${TAG_COLORS["extension:wasm"]}[extension:wasm]${RESET_COLOR} diff executed in 2ms`);

  const refusedLog = colorizeTags("[extension:refused] host-not-allowed: forbidden", true);
  assert.equal(refusedLog, `${TAG_COLORS["extension:refused"]}[extension:refused]${RESET_COLOR} host-not-allowed: forbidden`);

  const callLog = colorizeTags("[extension] calling 'web_search'", true);
  assert.equal(callLog, `${TAG_COLORS.extension}[extension]${RESET_COLOR} calling 'web_search'`);
});

test("extension network logging: query-string credentials are scrubbed from fetch logs (voicebox-beads-l9i3)", async (t) => {
  const secretToken = "super-secret-token-xyz999";
  const secretKey = "super-secret-key-abc111";

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/redirect-disallowed")) {
      res.writeHead(302, { location: `http://127.0.0.2:${port}/forbidden?token=${secretToken}&key=${secretKey}` });
      return res.end();
    }
    if (req.url?.startsWith("/redirect")) {
      res.writeHead(302, { location: `/api/endpoint?token=${secretToken}&key=${secretKey}&q=redirected` });
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Answer: "pong" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const admitted = createAndAdmitExtension({
    id: "url_redact_probe",
    name: "URL Redact Probe",
    description: "Probe for query credential scrubbing",
    capabilities: ["network"],
    bounds: { hosts: ["127.0.0.1"], maxRequests: 5 },
    tools: [
      {
        name: "probe_fetch",
        description: "Probe fetch",
        primitive: "http-get",
        params: {
          headers: {
            "Authorization": "$PROBE_TEST_AUTH",
          },
        },
      },
    ],
  });
  assert.equal(admitted.decision, "admitted");

  process.env.PROBE_TEST_AUTH = "Bearer probe-secret-12345";
  t.after(() => { delete process.env.PROBE_TEST_AUTH; });

  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => { logs.push(args.join(" ")); origLog.apply(console, args); };
  console.error = (...args) => { errors.push(args.join(" ")); origError.apply(console, args); };
  t.after(() => {
    console.log = origLog;
    console.error = origError;
  });

  const targetUrl = `http://127.0.0.1:${port}/api/endpoint?token=${secretToken}&key=${secretKey}&q=weather`;

  const res = await callTool("probe_fetch", { url: targetUrl });
  assert.equal(res.ok, true);

  // Assert sensitive values never appear anywhere in stdout or stderr
  assert.equal(logs.some((l) => l.includes(secretToken)), false, "secret token leaked to stdout");
  assert.equal(logs.some((l) => l.includes(secretKey)), false, "secret key leaked to stdout");
  assert.equal(errors.some((e) => e.includes(secretToken)), false, "secret token leaked to stderr");
  assert.equal(errors.some((e) => e.includes(secretKey)), false, "secret key leaked to stderr");

  // Assert [extension:network] fetch log redacted the query secrets
  const netLogs = logs.filter((l) => l.includes("[extension:network] fetch"));
  assert.ok(netLogs.length >= 1, "missing [extension:network] fetch log");
  for (const logLine of netLogs) {
    assert.match(logLine, /token=\[redacted\]/);
    assert.match(logLine, /key=\[redacted\]/);
    assert.match(logLine, /q=weather/, "non-sensitive query parameter is preserved");
  }

  // Assert the auth log at line 1237 (in console.error) also scrubbed the URL
  const authErrors = errors.filter((e) => e.includes("[extension:network] fetch") && e.includes("(auth: Authorization)"));
  assert.ok(authErrors.length >= 1, "missing [extension:network] fetch auth log");
  for (const errLine of authErrors) {
    assert.match(errLine, /token=\[redacted\]/);
    assert.match(errLine, /key=\[redacted\]/);
    assert.doesNotMatch(errLine, new RegExp(secretToken));
  }

  // 2. Redirect hop assertion: redirect target with query credentials is also scrubbed
  logs.length = 0;
  errors.length = 0;
  const redirectRes = await callTool("probe_fetch", { url: `http://127.0.0.1:${port}/redirect` });
  assert.equal(redirectRes.ok, true);
  assert.equal(logs.some((l) => l.includes(secretToken)), false, "secret token leaked on redirect log");
  const redirectLogs = logs.filter((l) => l.includes("[extension:network] redirect"));
  assert.ok(redirectLogs.length >= 1, "missing [extension:network] redirect log");
  for (const rLog of redirectLogs) {
    assert.match(rLog, /token=\[redacted\]/);
    assert.match(rLog, /key=\[redacted\]/);
    assert.match(rLog, /q=redirected/);
  }

  // 3. Redirect refusal assertion: redirect to disallowed host with query credentials is scrubbed from stderr
  logs.length = 0;
  errors.length = 0;
  const disallowedRes = await callTool("probe_fetch", { url: `http://127.0.0.1:${port}/redirect-disallowed` });
  assert.equal(disallowedRes.ok, false);
  assert.equal(disallowedRes.refused, "redirect-host-not-allowed");
  assert.equal(errors.some((e) => e.includes(secretToken)), false, "secret token leaked to stderr on redirect refusal");
  assert.equal(errors.some((e) => e.includes(secretKey)), false, "secret key leaked to stderr on redirect refusal");
  const refusalErrors = errors.filter((e) => e.includes("[extension:refused] redirect-host-not-allowed"));
  assert.ok(refusalErrors.length >= 1, "missing [extension:refused] redirect-host-not-allowed error");
  for (const rErr of refusalErrors) {
    assert.match(rErr, /token=\[redacted\]/);
    assert.match(rErr, /key=\[redacted\]/);
    assert.match(rErr, /chain:/);
  }
});
