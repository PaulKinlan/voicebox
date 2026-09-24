#!/usr/bin/env node
// tools/approval-code.mjs — Display active pending extension approval requests and their 8-digit code (voicebox-beads-62f).
//
// Usage:
//   node tools/approval-code.mjs
//
// For developers running Voicebox headless, under systemd, or in a separate terminal window,
// this tool reads the 0600 .pending-approval.json file in the host extensions directory and
// displays the pending plan details and single-use code.
import { readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const EXTENSIONS_DIR = process.env.VOICEBOX_EXTENSIONS_DIR ?? path.join(REPO, "extensions");
const PENDING_FILE = path.join(EXTENSIONS_DIR, ".pending-approval.json");

if (!existsSync(PENDING_FILE)) {
  console.log("No pending extension approval requests.");
  process.exit(0);
}

let pending;
try {
  pending = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
} catch (err) {
  console.error(`Could not read pending approval file (${PENDING_FILE}): ${err?.message ?? err}`);
  process.exit(1);
}

if (!pending || typeof pending !== "object" || !pending.code) {
  console.log("No active pending extension approval requests.");
  process.exit(0);
}

if (Date.now() >= pending.expiresAt) {
  rmSync(PENDING_FILE, { force: true });
  const extName = pending.plan?.name ?? pending.plan?.id ?? "extension";
  console.log(`Approval request for '${extName}' expired at ${new Date(pending.expiresAt).toISOString()}. Request a new code in the room UI.`);
  process.exit(0);
}

const extName = pending.plan?.name ?? pending.plan?.id ?? "Unknown";
const capabilities = (pending.plan?.declared ?? []).join(", ") || "none";
const tools = (pending.plan?.tools ?? []).map((t) => t.name ?? t).join(", ") || "none";
const remainingSecs = Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000));

console.log("────────────────────────────────────────────────────────────");
console.log("EXTENSION APPROVAL REQUEST (HOST CONSOLE)");
console.log("────────────────────────────────────────────────────────────");
console.log(`Extension:     ${extName} (${pending.plan?.id ?? "no id"})`);
console.log(`Request ID:    ${pending.requestId}`);
console.log(`Approval code: ${pending.code}`);
console.log(`Expires:       ${new Date(pending.expiresAt).toISOString()} (~${remainingSecs}s remaining)`);
console.log(`Capabilities:  ${capabilities}`);
console.log(`Tools:         ${tools}`);
console.log("────────────────────────────────────────────────────────────");
console.log("Enter this 8-digit code in the room UI only if you approve this plan.");
console.log("────────────────────────────────────────────────────────────");
