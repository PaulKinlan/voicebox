// tests/extension-credential-bounds.test.mjs — TM-EXT-004: a header may read only what the
// descriptor NAMES.
//
// THE DEFECT. A descriptor declares `params.headers: { "X-Key": "$SOME_VAR" }` and callHttp
// interpolated ANY name from the host's environment into that header, sent to the descriptor's
// declared host. The host was reviewed; the VARIABLE was not, so the reachable secret set was
// "everything this process holds" — one admitted tool could have sent the live provider's key to
// its own host, and nothing but a reader's attention stood in the way.
//
// THE FIX, DRIVEN HERE AT BOTH PLACES IT LIVES:
//   * core/extensions.ts — bounds.credentials NAMES the variables a header may read; a header
//     interpolating an unnamed one is refused AT ADMISSION by name (undeclared-credential), and a
//     name that is not an environment-variable name is refused (bad-credential-name).
//   * lib/extensions.mjs — the READ itself resolves only a named variable, so the moment the
//     secret would leave is the moment it is checked.
//
// No server and no browser: the gate is a pure function, and the call path is driven in-process
// with fetch stubbed, so this file belongs to the concurrent unit lane.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { admit } from "../core/extensions.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// The extension system resolves its state directories at import time, so the scratch tree is
// named BEFORE the import and this suite never touches a directory the repo or a deployment owns.
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "voicebox-cred-bounds-"));
process.env.VOICEBOX_WORKSPACE = path.join(SCRATCH, "workspace");
process.env.VOICEBOX_EXTENSIONS_DIR = path.join(SCRATCH, "extensions");
mkdirSync(process.env.VOICEBOX_WORKSPACE, { recursive: true });
const ext = await import("../lib/extensions.mjs");

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const DECLARED_VALUE = "declared-value-7f2a";
const UNNAMED_VALUE = "must-never-leave-9c1b";

/** A network descriptor whose first header interpolates `envName`, named (or not) in bounds. */
const descriptor = ({ headers, credentials } = {}) => ({
  id: "cred-probe",
  name: "Cred Probe",
  description: "reads one named credential",
  source: "local",
  runsIn: "host",
  capabilities: ["network"],
  bounds: {
    hosts: ["api.example.com"],
    maxRequests: 2,
    ...(credentials !== undefined ? { credentials } : {}),
  },
  tools: [{
    name: "cred_probe",
    description: "GET with one interpolated header",
    primitive: "http-get",
    params: { url: "https://api.example.com/v1", headers: headers ?? { "X-Key": "$DECLARED_CRED" } },
  }],
});

// ── the gate: the declaration is checked by name ──────────────────────────

test("a header that interpolates a variable the descriptor does not name is refused BY NAME", () => {
  const verdict = admit(descriptor({ headers: { "X-Key": "$UNNAMED_CRED" } }), "machine", new Set());
  assert.equal(verdict.decision, "refused");
  assert.equal(verdict.rule, "undeclared-credential");
  assert.match(verdict.why, /header 'X-Key' interpolates \$UNNAMED_CRED/);
  assert.match(verdict.why, /bounds\.credentials does not name/, "the refusal says which declaration is missing");
  assert.match(verdict.why, /names nothing/, "an empty declaration is named as empty, not silently listed as []");
});

test("the refusal names the credentials the descriptor DOES declare, so the fix is on the page", () => {
  const verdict = admit(
    descriptor({ headers: { "X-Key": "$OTHER_CRED" }, credentials: ["DECLARED_CRED"] }),
    "machine",
    new Set(),
  );
  assert.equal(verdict.rule, "undeclared-credential");
  assert.match(verdict.why, /it names \[DECLARED_CRED\]/);
});

test("a credential name that is not an environment-variable name is refused, in bounds and in a header", () => {
  const inBounds = admit(descriptor({ credentials: ["not a name"] }), "machine", new Set());
  assert.equal(inBounds.rule, "bad-credential-name");
  assert.match(inBounds.why, /bounds\.credentials names 'not a name'/);
  // A header value is $VAR and nothing else: '$A$B' and '$lower' are not names, and a value that
  // looks like an expression must never reach process.env.
  const inHeader = admit(descriptor({ headers: { "X-Key": "$lower_case" }, credentials: ["LOWER_CASE"] }), "machine", new Set());
  assert.equal(inHeader.rule, "bad-credential-name");
  assert.match(inHeader.why, /header 'X-Key' interpolates '\$lower_case'/);
  // A declaration that is not an array fails closed at the gate rather than throwing or iterating
  // the characters of a string.
  const notAnArray = admit({ ...descriptor(), bounds: { hosts: ["api.example.com"], maxRequests: 1, credentials: "BRAVE_API_KEY" } }, "machine", new Set());
  assert.equal(notAnArray.decision, "refused");
  assert.match(notAnArray.why, /bounds\.credentials must be an array/);
});

test("a declared credential admits, and the disclosure names the exact variable a person is approving", () => {
  const verdict = admit(descriptor({ credentials: ["DECLARED_CRED"] }), "machine", new Set());
  assert.equal(verdict.decision, "admitted");
  const disclosed = verdict.gets.find((g) => g.startsWith("credentials: "));
  assert.ok(disclosed, `the plan must disclose the declared secrets: ${JSON.stringify(verdict.gets)}`);
  assert.match(disclosed, /^credentials: DECLARED_CRED — /);
  assert.match(disclosed, /every other variable in the host's environment is unreadable/);
});

test("the catalogue's brave-search declares the one variable it reads", () => {
  const catalogue = JSON.parse(readFileSync(path.join(ROOT, "catalogue", "brave-search.json"), "utf8"));
  const interpolated = catalogue.tools.flatMap((t) => Object.values(t.params?.headers ?? {}))
    .filter((v) => typeof v === "string" && v.startsWith("$"))
    .map((v) => v.slice(1));
  assert.deepEqual(interpolated, ["BRAVE_API_KEY"], "the pre-condition of this test");
  assert.deepEqual(catalogue.bounds.credentials, interpolated, "the descriptor names exactly what its headers read");
  assert.equal(admit(catalogue, "machine", new Set()).decision, "admitted");
});

// ── the read site: an unnamed variable is never read ──────────────────────

test("the call path sends the named value and never reads an unnamed variable", async (t) => {
  const realFetch = globalThis.fetch;
  const calls = [];
  // No host is contacted: the mediated fetch IS the only egress a tool has, so stubbing it is
  // driving the real path — everything above the socket is the shipped code.
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    return new Response(JSON.stringify({ ok: true, stubbed: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  process.env.DECLARED_CRED = DECLARED_VALUE;
  process.env.UNNAMED_CRED = UNNAMED_VALUE;
  t.after(() => {
    globalThis.fetch = realFetch;
    delete process.env.DECLARED_CRED;
    delete process.env.UNNAMED_CRED;
  });

  const admitted = ext.createAndAdmitExtension(descriptor({ credentials: ["DECLARED_CRED"] }), "test-host");
  assert.equal(admitted.decision, "admitted", `admission failed: ${JSON.stringify(admitted)}`);

  const result = await ext.callTool("cred_probe", {});
  assert.equal(result.ok, true, `the call failed: ${JSON.stringify(result)}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["X-Key"], DECLARED_VALUE, "the NAMED variable's value is sent");
  assert.equal(
    JSON.stringify(calls[0]).includes(UNNAMED_VALUE), false,
    "an unnamed variable's value never left the process",
  );

  // The second door: a live reconfiguration runs the same gate, so an unnamed header cannot be
  // smuggled in after admission either — refused by name, and the running tool is untouched.
  const smuggled = ext.reconfigureExtension(
    "cred-probe",
    { params: { cred_probe: { headers: { "X-Key": "$UNNAMED_CRED" } } } },
    "test-host",
  );
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.refused, "undeclared-credential");
  assert.match(smuggled.why, /\$UNNAMED_CRED/);

  calls.length = 0;
  assert.equal((await ext.callTool("cred_probe", {})).ok, true, "the refused reconfiguration did not disturb the live tool");
  assert.equal(calls[0].headers["X-Key"], DECLARED_VALUE, "the live descriptor is the admitted one");

  // The declaration itself is an ADMISSION fact, not a live setting: changing it through the
  // reconfiguration door is refused by name rather than silently ignored (an ignored bound is
  // how a descriptor and the thing enforcing it start disagreeing).
  const rewidened = ext.reconfigureExtension(
    "cred-probe",
    { bounds: { credentials: ["DECLARED_CRED", "UNNAMED_CRED"] } },
    "test-host",
  );
  assert.equal(rewidened.ok, false);
  assert.equal(rewidened.refused, "credentials-not-reconfigurable");
  assert.match(rewidened.why, /re-propose the descriptor/);
});
