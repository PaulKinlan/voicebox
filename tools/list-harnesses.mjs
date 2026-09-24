#!/usr/bin/env node
import { discoverHarnesses } from "../lib/harness-inventory.mjs";
const report = await discoverHarnesses();
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`${report.scope} — ${report.observedAt}\n${report.note}\n`);
  for (const row of report.entries) {
    console.log(`${row.name}: ${row.state}${row.version ? ` ${row.version}` : ""}\n  ${row.description}\n  ${row.why}\n  ${row.capabilities}\n  Voicebox delegation: ${row.delegation.ok ? row.delegation.mechanism : row.delegation.why}`);
    const catalogue = row.toolCatalogue;
    if (catalogue.status === "declared") {
      console.log(`  Declared tools (${catalogue.tools.length}) — host metadata, not live permissions\n  Source: ${catalogue.source}\n  Scope: ${catalogue.scope}`);
      for (const tool of catalogue.tools) console.log(`    ${tool.name}: ${tool.description}`);
      if (!catalogue.tools.length) console.log("    Host declared an empty list; actual session tools remain unknown.");
    } else console.log(`  Tools — unknown: ${catalogue.why}`);
    console.log();
  }
}
