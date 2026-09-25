#!/usr/bin/env node
// tools/create-extension.mjs — Create and locally add new extensions (voicebox-beads-b1p).
//
// Host-owned admission gate:
//   - Staging creates a pending proposal in workspace/proposals/ (source: "local").
//   - Direct admission requires host authority (.host-token); a declared capability
//     is not an enforced one.
//
// Usage:
//   node tools/create-extension.mjs <descriptor.json> [--admit] [--workspace <dir>] [--extensions <dir>]
//   node tools/create-extension.mjs --id <id> --name <name> --primitive <primitive> [--hosts <hosts>] [--tool <name>] [--admit]
//
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { declareOverrides } from "../lib/state-dirs.mjs";

function usage() {
  console.log(`Usage:
  node tools/create-extension.mjs <descriptor.json> [--admit]
  node tools/create-extension.mjs --id <id> --name <name> --primitive <primitive> [options]

Options:
  --id <id>              Extension ID (/^[a-z0-9_-]+$/)
  --name <name>          Human-readable extension name
  --desc <description>   Extension description
  --primitive <prim>     Primitive: now | read-file | write-file | list-files | http-get | wasm
  --tool <name>          Tool name (/^[a-z0-9_]+$/)
  --tooldesc <desc>      Tool description
  --hosts <host1,host2>  Allowed hosts for network primitive
  --max-requests <n>     Max network requests budget (default 50)
  --admit                Admit immediately using host token (.host-token)
  --stage                Stage as pending proposal only (default)
  --workspace <dir>      Workspace directory override
  --extensions <dir>     Host extensions directory override
`);
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) usage();

let file = null;
let id = null;
let name = null;
let desc = null;
let primitive = null;
let tool = null;
let tooldesc = null;
let hosts = [];
let maxRequests = 50;
let admit = false;
let workspaceDir = null;
let extensionsDir = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--id") id = args[++i];
  else if (arg === "--name") name = args[++i];
  else if (arg === "--desc") desc = args[++i];
  else if (arg === "--primitive") primitive = args[++i];
  else if (arg === "--tool") tool = args[++i];
  else if (arg === "--tooldesc") tooldesc = args[++i];
  else if (arg === "--hosts") hosts = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
  else if (arg === "--max-requests") maxRequests = parseInt(args[++i], 10);
  else if (arg === "--admit") admit = true;
  else if (arg === "--stage") admit = false;
  else if (arg === "--workspace") workspaceDir = args[++i];
  else if (arg === "--extensions") extensionsDir = args[++i];
  else if (!arg.startsWith("--") && !file) file = arg;
}

if (workspaceDir || extensionsDir) {
  // The override is declared THROUGH the fact's owner (voicebox-beads-y5k): only
  // lib/state-dirs.mjs touches these env vars. Owners read env at use time, so the
  // dynamic import below sees the declaration wherever it lands.
  declareOverrides({ workspace: workspaceDir, extensions: extensionsDir });
}

const {
  createExtension,
  createAndAdmitExtension,
} = await import("../lib/extensions.mjs");

let descriptor;
if (file) {
  try {
    descriptor = JSON.parse(readFileSync(path.resolve(file), "utf8"));
  } catch (err) {
    console.error(`Error reading descriptor file: ${err.message}`);
    process.exit(1);
  }
} else if (id && name && primitive) {
  const toolName = tool ?? id.replace(/-/g, "_");
  const toolDescription = tooldesc ?? desc ?? name;
  const capabilities = [];
  const bounds = {};
  if (primitive === "http-get") {
    capabilities.push("network");
    bounds.hosts = hosts.length ? hosts : ["127.0.0.1"];
    bounds.maxRequests = maxRequests;
  } else if (primitive === "read-file" || primitive === "list-files") {
    capabilities.push("read");
  } else if (primitive === "write-file") {
    capabilities.push("write");
    bounds.maxBytes = 65536;
  }
  descriptor = {
    id,
    name,
    description: desc ?? name,
    source: "local",
    runsIn: "host",
    capabilities,
    bounds,
    tools: [
      {
        name: toolName,
        description: toolDescription,
        primitive,
        params: {},
      },
    ],
  };
} else {
  usage();
}

if (admit) {
  const r = createAndAdmitExtension(descriptor, "host-cli");
  if (!r.ok) {
    console.error(`Refused by admission gate (${r.refused}): ${r.why}`);
    process.exit(1);
  }
  console.log(`Created and admitted local extension '${descriptor.id}':`);
  console.log(`  Decision: ${r.decision}`);
  console.log(`  Enforced: ${JSON.stringify(r.enforced)}`);
  console.log(`  Gets: ${r.gets?.join("; ")}`);
  process.exit(0);
} else {
  const r = createExtension(descriptor, descriptor.source ?? "local");
  if (!r.ok) {
    console.error(`Refused (${r.refused}): ${r.why}`);
    process.exit(1);
  }
  console.log(`Staged local extension proposal '${descriptor.id}' in workspace:`);
  console.log(`  Gate decision: ${r.plan?.gate?.decision} (${r.plan?.gate?.why ?? "admissible"})`);
  console.log(`  Declared capabilities: ${(r.plan?.declared ?? []).join(", ") || "none"}`);
  console.log(`  Note: ${r.note}`);
  process.exit(0);
}
