// tests/test-lanes.test.mjs — the classification the gate now depends on
// (`voicebox-beads-6qu`).
//
// The gate runs two lanes because the suite's own file-concurrency caused the
// refusals: live tests (Chromium over CDP, or a server process of their own)
// failed inside the concurrent suite while passing alone and passing serial.
// A hand-kept list would rot the moment somebody adds a test, so the lanes are
// DERIVED from each file's code — and these cases hold the derivation, including
// its one real trap: a file that merely MENTIONS a browser in a comment is not a
// live test. And its second (`voicebox-beads-k96l`): a test that WRITES
// live-looking source — this file does, which filed it LIVE and serial — is not a
// live test either, while every launch form the suite really uses still is.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../scripts/test-lanes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (...args) => execFileSync(process.execPath, [path.join(root, "scripts/test-lanes.mjs"), ...args], { cwd: root, encoding: "utf8" });

test("every test file is in exactly one lane, and the known victims are LIVE", () => {
  const output = run("--check");
  assert.match(output, /\[lanes\] ok: \d+ unit, \d+ live/);
  const live = new Set(execFileSync(process.execPath, [path.join(root, "scripts/test-lanes.mjs"), "--lane", "live"], { cwd: root, encoding: "utf8" }).trim().split(/\s+/));
  for (const victim of [
    "tests/extension-approval-ui.test.mjs",
    "tests/environment-probe.test.mjs",
    "tests/pre-push.test.mjs",
    "tests/tasks-http.test.mjs",
  ]) {
    assert.ok(live.has(victim), `${victim} launches a browser or a server and must be in the live lane`);
  }
  // The lane that races must not contain the files that broke the gate.
  const unit = new Set(execFileSync(process.execPath, [path.join(root, "scripts/test-lanes.mjs"), "--lane", "unit"], { cwd: root, encoding: "utf8" }).trim().split(/\s+/));
  for (const victim of [
    "tests/extension-approval-ui.test.mjs",
    "tests/environment-probe.test.mjs",
    "tests/pre-push.test.mjs",
    "tests/tasks-http.test.mjs",
  ]) {
    assert.equal(unit.has(victim), false, `${victim} must not be in the concurrent lane`);
  }
});

test("classification reads CODE: a comment naming a browser does not make a live test", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-lanes-"));
  try {
    writeFileSync(path.join(dir, "mentions.test.mjs"), `// this one talks about tests/lib/cdp.mjs and a server.mjs but launches nothing\nimport test from "node:test";\ntest("unit", () => {});\n`);
    writeFileSync(path.join(dir, "launches.test.mjs"), `import { launch } from "./lib/cdp.mjs";\n`);
    writeFileSync(path.join(dir, "fixture.cjs"), `// not a test file: the classifier only reads *.test.mjs\n`);
    const { unit, live } = classify(dir);
    assert.deepEqual(unit.map(({ file }) => file), ["mentions.test.mjs"]);
    assert.deepEqual(live.map(({ file }) => file), ["launches.test.mjs"]);
    assert.equal(live[0].why, "a browser over CDP", "the reason is named, so a misclassification can be argued with");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classification detects browser/server helper launches: page-acceptance, task-fixture, and createServer are LIVE", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-lanes-helpers-"));
  try {
    writeFileSync(path.join(dir, "prepush.test.mjs"), `// spawns page acceptance\nconst child = spawn(process.execPath, ['tools/page-acceptance.mjs']);\n`);
    writeFileSync(path.join(dir, "taskfix.test.mjs"), `import { taskFixture } from "./lib/task-fixture.mjs";\n`);
    writeFileSync(path.join(dir, "netserver.test.mjs"), `import { createServer } from "node:http";\n`);
    const { unit, live } = classify(dir);
    assert.deepEqual(unit, []);
    assert.equal(live.length, 3);
    assert.ok(live.some((l) => l.file === "prepush.test.mjs" && l.why.includes("page-acceptance")));
    assert.ok(live.some((l) => l.file === "taskfix.test.mjs" && l.why.includes("task-fixture")));
    assert.ok(live.some((l) => l.file === "netserver.test.mjs" && l.why.includes("createServer")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lane scripts exist and swap out at the same files npm test runs", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts["test:unit"], /test-lanes\.mjs --lane unit/);
  assert.match(pkg.scripts["test:live"], /--test-concurrency=1/);
  assert.match(pkg.scripts["test:live"], /--lane live/);
  // `npm test` stays the whole suite for humans and CI: the split is the GATE's,
  // not a redefinition of what the repository's test command means.
  assert.equal(pkg.scripts.test, "node --test tests/*.mjs");
});

// ── voicebox-beads-k96l: the classifier reads CODE, not the DATA a test writes ──────────
// Every fixture below is written INLINE, as the content of a writeFileSync call: that is
// what makes it data to the classifier, so this file stays in the unit lane while it
// names every helper there is. (Staged in a variable, the same text would be read — see
// "staged-fixture" — and this file would be filed live again.)

test("classification reads CODE, not DATA: fixture source a test WRITES is not a launch (voicebox-beads-k96l)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-lanes-data-"));
  try {
    // This file's own shape, and harder: fixture files written from string and template
    // literals whose source imports, spawns and calls every launch helper — through every
    // write call the rule knows, with ${…} code that only computes the text, a nested
    // template, a node -e program that is never run, and the names in prose.
    writeFileSync(path.join(dir, "writes-fixtures.test.mjs"), [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import fs, { writeFileSync, appendFileSync } from "node:fs";',
      'import { writeFile } from "node:fs/promises";',
      'test("names createServer and callWasmTool in a title, and launches nothing", async () => {',
      '  writeFileSync(join(dir, "a.test.mjs"), `import { launch } from "./lib/cdp.mjs";\\n`);',
      '  writeFileSync(join(dir, "b.test.mjs"), "import { startServer } from \\"./lib/server.mjs\\";\\n");',
      "  appendFileSync(join(dir, \"c.test.mjs\"), 'spawn(process.execPath, [\"server.mjs\"]);\\n');",
      '  await writeFile(join(dir, "d.test.mjs"), `spawn(process.execPath, ["tools/page-acceptance.mjs"]);\\n`, "utf8");',
      '  fs.writeFileSync(join(dir, "e.test.mjs"), [`import { taskFixture } from "./lib/task-fixture.mjs";`, `import { createServer } from "node:http";`].join("\\n"));',
      '  writeFileSync(join(dir, "f.test.mjs"), `const { callWasmTool } = await import("../lib/wasm-shelf.mjs");\\nawait callWasmTool(tool, {});\\n`);',
      "  writeFileSync(join(dir, \"g.test.mjs\"), `execFileSync(process.execPath, [\"-e\", \"require('node:http').createServer().listen(0)\"]);\\n`);",
      '  writeFileSync(join(dir, "h.test.mjs"), `import { launch } from "${base}/lib/cdp.mjs";\\nspawn(process.execPath, [\\`\\${ROOT}/server.mjs\\`]);\\n`);',
      '  assert.ok(true, "createServer and callWasmTool appear here as prose only");',
      "});",
    ].join("\n"));
    const { unit, live } = classify(dir);
    assert.deepEqual(live, [], `source a test writes is data, not a launch — misread as: ${JSON.stringify(live)}`);
    assert.deepEqual(unit.map(({ file }) => file), ["writes-fixtures.test.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the launch forms this suite really uses stay LIVE, each for its own reason (voicebox-beads-k96l)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-lanes-forms-"));
  try {
    // Every form tests/ used on 2026-09-28, surveyed file by file: the helper imports, the
    // server spawned by name and by relative path, page acceptance by path.join, the
    // WebSocket helper, createServer as a member, the wasm call.
    writeFileSync(path.join(dir, "cdp-import.test.mjs"), 'import { launch } from "./lib/cdp.mjs";\n');
    writeFileSync(path.join(dir, "helper-server.test.mjs"), 'import { startServer } from "./lib/server.mjs";\n');
    writeFileSync(path.join(dir, "ws-helper.test.mjs"), 'import { WebSocketServer } from "../lib/ws-server.mjs";\n');
    writeFileSync(path.join(dir, "spawns-by-name.test.mjs"), 'const child = spawn(process.execPath, ["server.mjs"], { cwd: ROOT });\n');
    writeFileSync(path.join(dir, "spawns-relative.test.mjs"), 'const child = spawn(process.execPath, [path.join(here, "../server.mjs")]);\n');
    writeFileSync(path.join(dir, "acceptance-joined.test.mjs"), "const child = spawn(process.execPath, [path.join(root, 'tools', 'page-acceptance.mjs')]);\n");
    writeFileSync(path.join(dir, "task-helper.test.mjs"), 'import { taskFixture } from "./lib/task-fixture.mjs";\n');
    writeFileSync(path.join(dir, "http-member.test.mjs"), 'import http from "node:http";\nconst front = http.createServer((req, res) => res.end());\n');
    writeFileSync(path.join(dir, "wasm-call.test.mjs"), 'const { callWasmTool } = await import("../lib/wasm-shelf.mjs");\nawait callWasmTool(tool, { input: "abc" });\n');
    // The forms a test could reach for next — the first five the old flat regexes let
    // escape to the concurrent lane — and the ones the data rule must not swallow: a
    // dynamic import, a helper reached through path.join segments, a path built in a
    // template literal, a program handed to node -e or a shell (bash -lc included), code
    // beside a write, ${…} code inside one, a spawn or a callback among a write's own
    // arguments, the PATH a write goes to, and a fixture staged in a variable (read,
    // because every doubt resolves to LIVE).
    writeFileSync(path.join(dir, "cdp-dynamic.test.mjs"), 'const { launch } = await import("./lib/cdp.mjs");\n');
    writeFileSync(path.join(dir, "task-dynamic.test.mjs"), 'const { taskFixture } = await import("./lib/task-fixture.mjs");\n');
    writeFileSync(path.join(dir, "cdp-joined.test.mjs"), 'const { launch } = await import(pathToFileURL(path.join(here, "lib", "cdp.mjs")).href);\n');
    writeFileSync(path.join(dir, "task-joined.test.mjs"), 'const { taskFixture } = await import(pathToFileURL(path.join(here, "lib", "task-fixture.mjs")).href);\n');
    writeFileSync(path.join(dir, "spawns-template.test.mjs"), 'const child = spawn(process.execPath, [`${ROOT}/server.mjs`]);\n');
    writeFileSync(path.join(dir, "eval-string.test.mjs"), `execFileSync(process.execPath, ["-e", "require('node:http').createServer().listen(0)"]);\n`);
    writeFileSync(path.join(dir, "eval-template.test.mjs"), 'execFileSync(process.execPath, ["-e", `require("node:http").createServer().listen(0)`]);\n');
    writeFileSync(path.join(dir, "shell-string.test.mjs"), `execSync("node -e \\"require('node:http').createServer().listen(0)\\"");\n`);
    writeFileSync(path.join(dir, "shell-flags.test.mjs"), `spawnSync("bash", ["-lc", "node -e 'require(\\"node:http\\").createServer().listen(0)'"]);\n`);
    writeFileSync(path.join(dir, "writes-then-serves.test.mjs"), 'writeFileSync(file, "fixture text");\nconst server = createServer();\n');
    writeFileSync(path.join(dir, "serves-in-substitution.test.mjs"), 'writeFileSync(file, `port ${listen(createServer())}\\n`);\n');
    writeFileSync(path.join(dir, "writes-spawn-output.test.mjs"), 'writeFileSync(file, spawnSync(process.execPath, ["server.mjs", "--version"]).stdout);\n');
    writeFileSync(path.join(dir, "writes-in-callback.test.mjs"), 'writeFile(file, "fixture text", () => spawn(process.execPath, ["server.mjs"]));\n');
    writeFileSync(path.join(dir, "writes-to-helper.test.mjs"), 'writeFileSync(path.join(repo, "tools", "page-acceptance.mjs"), "process.exit(0)\\n");\n');
    writeFileSync(path.join(dir, "staged-fixture.test.mjs"), 'const FIXTURE = `import { launch } from "./lib/cdp.mjs";\\n`;\nwriteFileSync(file, FIXTURE);\n');
    const { unit, live } = classify(dir);
    assert.deepEqual(unit, [], `every launch form must stay LIVE — these escaped to the concurrent lane: ${unit.map(({ file }) => file).join(", ")}`);
    assert.deepEqual(Object.fromEntries(live.map(({ file, why }) => [file, why])), {
      "acceptance-joined.test.mjs": "a browser via page-acceptance",
      "cdp-dynamic.test.mjs": "a browser over CDP",
      "cdp-import.test.mjs": "a browser over CDP",
      "cdp-joined.test.mjs": "a browser over CDP",
      "eval-string.test.mjs": "a server via createServer",
      "eval-template.test.mjs": "a server via createServer",
      "helper-server.test.mjs": "a server process",
      "http-member.test.mjs": "a server via createServer",
      "serves-in-substitution.test.mjs": "a server via createServer",
      "shell-flags.test.mjs": "a server via createServer",
      "shell-string.test.mjs": "a server via createServer",
      "spawns-by-name.test.mjs": "a server process",
      "spawns-relative.test.mjs": "a server process",
      "spawns-template.test.mjs": "a server process",
      "staged-fixture.test.mjs": "a browser over CDP",
      "task-dynamic.test.mjs": "a server via task-fixture",
      "task-helper.test.mjs": "a server via task-fixture",
      "task-joined.test.mjs": "a server via task-fixture",
      "wasm-call.test.mjs": "worker threads or wasm execution",
      "writes-in-callback.test.mjs": "a server process",
      "writes-spawn-output.test.mjs": "a server process",
      "writes-then-serves.test.mjs": "a server via createServer",
      "writes-to-helper.test.mjs": "a browser via page-acceptance",
      "ws-helper.test.mjs": "a server process",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("comments are read as a lexer reads them — a glob in a string or a regex after if (…) opens none, a trailing one is not code, an unreadable file is read raw (voicebox-beads-k96l)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-lanes-comments-"));
  try {
    // The old regex strip took the "/*" inside this glob for a comment and deleted everything
    // up to the next "*/" — the server this file really starts included — and filed it unit.
    writeFileSync(path.join(dir, "glob-then-launch.test.mjs"), 'const pattern = "tests/*.mjs";\nconst server = createServer();\n/* a real comment */\n');
    // The same trap in a regex: after `if (…)` a "/" opens a regex literal, never a division,
    // so the "/*" inside this one opens no comment either.
    writeFileSync(path.join(dir, "regex-after-if.test.mjs"), 'if (ok) /\\/*/.test(s);\nconst server = createServer();\n/* a real comment */\n');
    writeFileSync(path.join(dir, "trailing-note.test.mjs"), 'test("unit", () => {}); // mentions "server.mjs" and createServer, runs neither\n');
    writeFileSync(path.join(dir, "block-note.test.mjs"), '/* import { launch } from "./lib/cdp.mjs"; */\ntest("unit", () => {});\n');
    // A file the lexer cannot read to its end (here, a template never closed) is read RAW,
    // comments and all: over-reading files it LIVE, which is the safe direction.
    writeFileSync(path.join(dir, "unreadable.test.mjs"), '// spawns "server.mjs"\nconst broken = `never closed;\n');
    const { unit, live } = classify(dir);
    assert.deepEqual(unit.map(({ file }) => file), ["block-note.test.mjs", "trailing-note.test.mjs"]);
    assert.deepEqual(live, [
      { file: "glob-then-launch.test.mjs", why: "a server via createServer" },
      { file: "regex-after-if.test.mjs", why: "a server via createServer" },
      { file: "unreadable.test.mjs", why: "a server process" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("this file is UNIT, and wasm-shelf stays LIVE for the worker it holds (voicebox-beads-k96l)", () => {
  const unit = new Set(run("--lane", "unit").trim().split(/\s+/));
  assert.ok(unit.has("tests/test-lanes.test.mjs"), "the classifier's own test launches nothing: every helper it names is fixture text it writes, or prose");
  const live = new Set(run("--lane", "live").trim().split(/\s+/));
  assert.ok(
    live.has("tests/wasm-shelf.test.mjs"),
    "wasm-shelf.test.mjs holds its process ~50s past its last test (its grow worker outlives terminate()), the hold that blew the 90s unit budget (voicebox-beads-6io) — it stays live until that worker dies at its deadline",
  );
});
