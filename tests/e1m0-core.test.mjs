// tests/e1m0-core.test.mjs — the checks that are not page behaviours, and check 8 in full.
//
//   node --test tests/e1m0-core.test.mjs
//
// These run the SAME core/ sources the browser runs: Node strips the types and imports them
// directly, so "the library" is tested as a library rather than through the one placement that
// happens to be built. Check 8 is static on purpose — it is the cheap test that keeps "a library"
// from becoming "two implementations that drift silently", and a drift that only shows up in
// behaviour is a drift nobody sees until the two placements disagree.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../core/policy.ts";
import { resolveInsideRoot } from "../core/paths.ts";
import { validate } from "../core/schema.ts";
import { auditFileName, hashRoot, mergeAudit, resumeSeq } from "../core/audit.ts";
import { RULES, ENFORCEABLE } from "../core/tier-table.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = path.join(ROOT, "core");
const schema = JSON.parse(readFileSync(path.join(ROOT, "tools/create-asset.schema.json"), "utf8"));
const ctx = { root: "v1/projects/atlas" };
const inside = (name) => `${ctx.root}/assets/${name}`;

// 8 ------------------------------------------------------------------------------------------
test("8. core/ imports nothing outside itself (N18, static and cheap)", () => {
  const files = readdirSync(CORE).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 5, "the core is missing");
  const offenders = [];

  for (const file of files) {
    // Comments are stripped first: this file's own prose contains the words "import" and "from"
    // inside quoted sentences, and a check that reads its documentation as code reports offenders
    // that do not exist — which is how a guard becomes noise and then becomes ignored.
    const source = readFileSync(path.join(CORE, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // `import ... from "x"`, `export ... from "x"` and dynamic `import("x")`. A TYPE-ONLY import
    // counts, because erasing it is a decision the next placement will make differently.
    const specifiers = [
      ...[...source.matchAll(/^\s*(?:import|export)\b[\s\S]{0,400}?\bfrom\s*["']([^"']+)["']/gm)].map((m) => m[1]),
      ...[...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
    ];
    for (const specifier of specifiers) {
      const isCoreRelative = specifier.startsWith("./") && !specifier.startsWith("../");
      const target = path.join(CORE, specifier);
      if (!isCoreRelative) offenders.push(`${file} → ${specifier}`);
      else if (!existsSync(target)) offenders.push(`${file} → ${specifier} (missing)`);
    }
  }

  assert.deepEqual(offenders, [], `core/ reaches outside itself: ${offenders.join(", ")}`);
});

test("8b. the tier table is data, and the rows M0 needs are in it", () => {
  const ids = RULES.map((r) => r.id);
  for (const required of ["outside-root", "symlink-out", "eval-path", "absent-capability", "writes-inside", "reads-inside", "delete", "leaves-browser"]) {
    assert.ok(ids.includes(required), `the table is missing the row '${required}'`);
  }
  // The capability map is the row that decides what can be enforced at all: exec and eval are
  // ABSENT in a browser, not denied, and a rule about them would be a description.
  assert.equal(ENFORCEABLE.has("exec"), false);
  assert.equal(ENFORCEABLE.has("eval"), false);
  assert.equal(ENFORCEABLE.get("write"), "handle-scope");
  assert.equal(ENFORCEABLE.get("network"), "egress-policy");
  // Credential and system rules are structurally satisfied in an origin, so they must NOT appear
  // as code — the failure mode is re-adding them as rules that enforce nothing.
  assert.equal(ids.some((id) => /credential|ssh|system|process/.test(id)), false);
});

// 2 + 3 --------------------------------------------------------------------------------------
test("2/3. the tier table decides both ways, and a refusal names its rule and its why", () => {
  const allowed = decide({ kind: "write", target: inside("ok.svg"), tool: "create-asset" }, ctx);
  assert.deepEqual(allowed, { decision: "allow", rule: "writes-inside" }, "a write inside the root was not allowed");

  const refused = decide({ kind: "write", target: "v1/projects/other/assets/evil.svg", tool: "create-asset" }, ctx);
  assert.equal(refused.decision, "refuse");
  assert.equal(refused.rule, "outside-root");
  assert.match(refused.why, /execution root/, "the refusal does not say why");

  // The allowed case in the same test: a test that only proves refusals proves half of it.
  assert.equal(decide({ kind: "read", target: inside("ok.svg") }, ctx).decision, "allow");
  assert.equal(decide({ kind: "delete", target: inside("ok.svg") }, ctx).decision, "confirm");
  assert.equal(decide({ kind: "network", target: inside("ok.svg") }, ctx).decision, "confirm");
  assert.equal(decide({ kind: "exec", target: inside("ok.svg") }, ctx).decision, "refuse");
  assert.equal(decide({ kind: "exec", target: inside("ok.svg") }, ctx).rule, "absent-capability");
});

// 4 ------------------------------------------------------------------------------------------
test("4. '..' as a NAME is refused, a sibling is accepted, and a rewrite never happens", () => {
  for (const candidate of ["..", "../../evil.sh", "a/../b", "./..", "assets/..", "../.."]) {
    const result = resolveInsideRoot(ctx.root, candidate);
    assert.equal(result.ok, false, `'${candidate}' was accepted`);
    assert.equal(result.rule, "outside-root");
  }
  const absolute = resolveInsideRoot(ctx.root, "/etc/passwd");
  assert.equal(absolute.ok, false, "an absolute path inside the root was accepted");

  const sibling = resolveInsideRoot(ctx.root, "assets/sibling.txt");
  assert.equal(sibling.ok, true);
  assert.equal(sibling.path, "v1/projects/atlas/assets/sibling.txt");
});

// 6 (the schema half) ------------------------------------------------------------------------
test("schema validation refuses by name, and accepts the well-formed case", () => {
  const good = validate(schema, { name: "ok.svg", kind: "svg", body: "<svg/>" });
  assert.equal(good.ok, true);
  assert.deepEqual(good.ok && good.value, { name: "ok.svg", kind: "svg", body: "<svg/>" });

  const cases = [
    ["unknown field", { name: "x", kind: "text", body: "x", extra: 1 }, "unknown-field"],
    ["unknown kind", { name: "x", kind: "exe", body: "x" }, "unknown-kind"],
    ["missing field", { name: "x" }, "missing-field"],
    ["malformed field", { name: 1, kind: "text", body: "x" }, "malformed-field"],
    ["not an object", null, "malformed-input"],
    ["huge body", { name: "x", kind: "text", body: "y".repeat(schema.maxBytes + 1) }, "too-large"],
  ];
  for (const [label, input, rule] of cases) {
    const result = validate(schema, input);
    assert.equal(result.ok, false, `${label} was accepted`);
    assert.equal(result.rule, rule, `${label} was refused without its own name`);
    assert.ok(result.why.length > 10, `${label} was refused without a why`);
  }
});

// 9 (the ordering half) ----------------------------------------------------------------------
test("the audit merges by (instance, seq) and never claims a global order", () => {
  const entry = (instance, seq, at, root) => ({
    seq,
    instance,
    project: "atlas@browser",
    root,
    turn: null,
    at,
    act: { kind: "write", target: `${root}/assets/x` },
    decision: "allow",
    rule: "writes-inside",
    result: "ok",
    observed: { exists: true, bytes: 1 },
  });

  // `at` runs backwards on purpose: a merge that used the wall clock would reorder these, and two
  // machines have no shared clock, so `at` is a hint and nothing more.
  const merged = mergeAudit([
    entry("phone", 2, "2026-09-19T00:00:00Z", "v1/projects/atlas"),
    entry("phone", 1, "2026-09-19T23:00:00Z", "v1/projects/atlas"),
    entry("laptop", 1, "2026-09-19T12:00:00Z", "v1/projects/atlas"),
  ]);
  assert.deepEqual(merged.map((e) => `${e.instance}:${e.seq}`), ["laptop:1", "phone:1", "phone:2"]);

  // One file per root, and the file name is stable for the root it belongs to.
  const name = auditFileName("phone", "v1/projects/atlas");
  assert.match(name, /^phone-[0-9a-f]{8}\.jsonl$/);
  assert.equal(auditFileName("phone", "v1/projects/atlas"), name);
  assert.notEqual(auditFileName("phone", "v1/projects/berlin"), name);
  assert.notEqual(hashRoot("picked:atlas"), hashRoot("v1/projects/atlas"));

  // Resuming continues the instance's numbering instead of restarting it, which is what stops a
  // reload from producing two entries numbered 1.
  assert.equal(resumeSeq([entry("phone", 7, "x", "r")], "phone"), 7);
  assert.equal(resumeSeq([entry("laptop", 9, "x", "r")], "phone"), 0);
});

// the wasm artefact --------------------------------------------------------------------------
test("the committed .wasm matches its .wat source and imports exactly two things", async () => {
  const bytes = readFileSync(path.join(ROOT, "tools/create-asset.wasm"));
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map((i) => `${i.module}.${i.name}`);
  assert.deepEqual(imports.sort(), ["env.note", "env.writeFile"], "the tool gained or lost an import");

  const fetchFixture = new WebAssembly.Module(readFileSync(path.join(ROOT, "tests/fixtures/fetch-import.wasm")));
  assert.ok(WebAssembly.Module.imports(fetchFixture).some((i) => i.name === "fetch"), "the negative control does not import fetch");

  // The artefact is build output, so it must not drift from the source. wabt is a devDependency;
  // without it this half is skipped with a reason rather than passing quietly.
  let wabt = null;
  try {
    wabt = await import("wabt");
  } catch {
    console.warn("wabt is not installed — the .wat/.wasm parity half of this check was skipped");
    return;
  }
  const module = await wabt.default();
  for (const [wat, wasm] of [
    ["tools/create-asset.wat", "tools/create-asset.wasm"],
    ["tests/fixtures/fetch-import.wat", "tests/fixtures/fetch-import.wasm"],
    ["tests/fixtures/trap.wat", "tests/fixtures/trap.wasm"],
  ]) {
    const parsed = module.parseWat("x.wat", readFileSync(path.join(ROOT, wat), "utf8"));
    const compiled = Buffer.from(parsed.toBinary({ write_debug_names: false }).buffer);
    parsed.destroy();
    assert.deepEqual(
      compiled,
      readFileSync(path.join(ROOT, wasm)),
      `${wasm} is stale — run \`npm run build:wasm\``,
    );
  }
});
