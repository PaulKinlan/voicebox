#!/usr/bin/env node
// Credential-free real-adapter diagnostic, deliberately not a task runner.
import { openPiAcpProbe, createPiAcpExecutor } from "../lib/pi-acp.mjs";
const [adapterDir, piBinary] = process.argv.slice(2);
if (!adapterDir || !piBinary) {
  console.error("Usage: node tools/acp-check.mjs <installed pi-acp directory> <pi binary>");
  process.exitCode = 2;
} else {
  let probe;
  try {
    probe = await openPiAcpProbe({ adapterDir, piBinary });
    console.log(JSON.stringify({ diagnostic: "initialize only; no model task", protocolVersion: probe.info.protocolVersion, agentInfo: probe.info.agentInfo, admission: createPiAcpExecutor().check() }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ refused: error.refused ?? "adapter-unavailable", why: error.refused ? error.message : "check the installed adapter/runtime paths" }));
    process.exitCode = 1;
  } finally { if (probe) await probe.close(); }
}
