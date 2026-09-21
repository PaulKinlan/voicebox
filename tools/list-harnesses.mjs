#!/usr/bin/env node
import { discoverHarnesses } from "../lib/harness-inventory.mjs";
const report = await discoverHarnesses();
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`${report.scope} — ${report.observedAt}\n${report.note}\n`);
  for (const row of report.entries) {
    console.log(`${row.name}: ${row.state}${row.version ? ` ${row.version}` : ""}\n  ${row.description}\n  ${row.why}\n  ${row.capabilities}\n  Voicebox delegation: ${row.delegation.refused} — ${row.delegation.why}\n`);
  }
}
