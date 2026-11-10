// tests/fence-unit-credentials.test.mjs — voicebox-beads-thb4 (TM-CRED-005).
//
//   node --test tests/fence-unit-credentials.test.mjs
//
// tools/fence-unit.sh passed VOICEBOX_BEARER (and the boot marker) as `--property=Environment=…` on a
// transient systemd --user unit. That property list is readable by any same-UID process for the unit's whole
// life (`systemctl --user show <unit> -p Environment`), so the pairing bearer was published to everything on
// the box for up to RuntimeMaxSec. The channel is now a 0600 file in the sandbox home whose PATH (not its
// contents) rides the environment.
//
// Three things must hold, and each of them was false before this change:
//   1. no secret name appears in a `--property=Environment=` assignment in tools/fence-unit.sh;
//   2. the provider writes the values to a 0600 file and puts only its path in the unit's environment;
//   3. the fence script reads that file, exports the two names for bwrap's --setenv, and DELETES the file
//      before bwrap runs — the sandbox home is bound INSIDE the sandbox, so a leftover file is readable
//      from there.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFenceCredentials } from "../lib/unit-fence-provider.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
/**
 * Strip comments so a mention in prose is not mistaken for an assignment (the repo's own 5qox lesson). Shell
 * scripts comment with `#`; the JS-style passes stay because this helper also reads lib/unit-fence-provider.mjs.
 */
const stripComments = (source) =>
  source
    .replace(/^\s*#[^\n]*/gm, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");

test("the unit property list carries a FILE PATH, never a secret (voicebox-beads-thb4)", () => {
  const script = stripComments(read("tools/fence-unit.sh"));
  for (const secret of ["VOICEBOX_BEARER", "VOICEBOX_BOOT_MARKER"]) {
    assert.equal(
      new RegExp(`--property=Environment=${secret}[=]`).test(script),
      false,
      `${secret} must not be passed as a unit Environment= property — that list is world-readable to same-UID processes`,
    );
  }
  assert.match(script, /--property=Environment=VOICEBOX_CREDENTIAL_FILE=/, "the credential FILE PATH rides the environment instead");
  assert.match(script, /VOICEBOX_CREDENTIAL_FILE/, "the script must pass the path through to the Exec");
});

test("the provider writes a 0600 file and hands the unit only its path (voicebox-beads-thb4)", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "thb4-creds-"));
  try {
    const file = writeFenceCredentials(home, { bearer: "vbx_pairing_bearer", bootMarker: "0123456789abcdef0123456789abcdef" });
    assert.ok(file, "a boot with credentials must produce a file");
    assert.equal(statSync(file).mode & 0o777, 0o600, "the credential file must be 0600");
    const contents = readFileSync(file, "utf8");
    assert.match(contents, /^VOICEBOX_BEARER=vbx_pairing_bearer$/m);
    assert.match(contents, /^VOICEBOX_BOOT_MARKER=0123456789abcdef0123456789abcdef$/m);
    // No credentials asked for, no file: the path is not created "just in case".
    assert.equal(writeFenceCredentials(home, {}), null);
    // And the SOURCE of the provider does not put either secret into the unit env it builds.
    const provider = stripComments(read("lib/unit-fence-provider.mjs"));
    assert.equal(/unitEnv\(\{[^}]*VOICEBOX_BEARER/.test(provider), false, "the bearer must not enter the unit environment");
    assert.match(provider, /unitEnv\(credentials \? \{ VOICEBOX_CREDENTIAL_FILE: credentials \}/, "only the path is passed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the fence reads the file, exports the names for bwrap, and deletes it BEFORE bwrap runs (voicebox-beads-thb4)", () => {
  const fence = read("tools/fence.sh");
  // Drive the REAL block from the script rather than a copy of it: cut it out and run it under bash with a
  // fixture file, then assert what it exported and that the file is gone.
  const start = fence.indexOf('if [ -n "${VOICEBOX_CREDENTIAL_FILE:-}" ]');
  assert.notEqual(start, -1, "the credential-reading block must exist in tools/fence.sh");
  const end = fence.indexOf("\nunset VOICEBOX_CREDENTIAL_FILE", start);
  assert.notEqual(end, -1, "the block must end by unsetting the path variable");
  const block = fence.slice(start, end + "\nunset VOICEBOX_CREDENTIAL_FILE".length);

  const scratch = mkdtempSync(path.join(os.tmpdir(), "thb4-fence-"));
  try {
    const file = path.join(scratch, ".fence-credentials");
    writeFileSync(file, "VOICEBOX_BEARER=vbx_from_file\nVOICEBOX_BOOT_MARKER=deadbeef\n", { mode: 0o600 });
    chmodSync(file, 0o600);
    const printed = execFileSync("bash", ["-c", `${block}\nprintf '%s|%s|%s' "\${VOICEBOX_BEARER:-}" "\${VOICEBOX_BOOT_MARKER:-}" "\${VOICEBOX_CREDENTIAL_FILE:-}"`], {
      env: { PATH: process.env.PATH, VOICEBOX_CREDENTIAL_FILE: file, VOICEBOX_BEARER: "", VOICEBOX_BOOT_MARKER: "" },
      encoding: "utf8",
    });
    assert.equal(printed, "vbx_from_file|deadbeef|", "both values come from the file, and the path variable is cleared");
    assert.equal(existsSync(file), false, "the file must be deleted before bwrap starts: the sandbox home is bound inside");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a value containing shell syntax is inert, not evaluated (voicebox-beads-thb4)", () => {
  const fence = read("tools/fence.sh");
  const start = fence.indexOf('if [ -n "${VOICEBOX_CREDENTIAL_FILE:-}" ]');
  const end = fence.indexOf("\nunset VOICEBOX_CREDENTIAL_FILE", start);
  const block = fence.slice(start, end + "\nunset VOICEBOX_CREDENTIAL_FILE".length);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "thb4-inert-"));
  try {
    const file = path.join(scratch, ".fence-credentials");
    writeFileSync(file, "VOICEBOX_BEARER=$(touch /tmp/thb4-should-not-exist);`id`\n", { mode: 0o600 });
    chmodSync(file, 0o600);
    const printed = execFileSync("bash", ["-c", `${block}\nprintf '%s' "\${VOICEBOX_BEARER:-}"`], {
      env: { PATH: process.env.PATH, VOICEBOX_CREDENTIAL_FILE: file },
      encoding: "utf8",
    });
    assert.equal(printed, "$(touch /tmp/thb4-should-not-exist);`id`", "the value is read as data");
    assert.equal(existsSync("/tmp/thb4-should-not-exist"), false, "nothing in the value was executed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
