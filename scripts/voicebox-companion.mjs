#!/usr/bin/env node
// scripts/voicebox-companion.mjs — CLI entrypoint for the Voicebox Native OS Companion (voicebox-beads-osba).

import {
  DEFAULT_GLOBAL_HOTKEY,
  createCompanionBridge,
  generateMacOsLaunchAgentPlist,
  normalizeHotkeySpec,
} from "../lib/os-companion.mjs";

async function main(argv = process.argv.slice(2)) {
  let hotkey = process.env.VOICEBOX_COMPANION_HOTKEY || DEFAULT_GLOBAL_HOTKEY;
  const hostUrl = process.env.VOICEBOX_HOST_URL || "http://127.0.0.1:8787";
  let mode = "status";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hotkey" && argv[i + 1]) {
      hotkey = argv[i + 1];
      i += 1;
    } else if (arg === "--print-plist") {
      mode = "plist";
    } else if (arg === "--toggle-mic") {
      mode = "toggle";
    } else if (arg === "--status") {
      mode = "status";
    }
  }

  const spec = normalizeHotkeySpec(hotkey);
  if (!spec.ok) {
    process.stderr.write(`${JSON.stringify(spec)}\n`);
    process.exit(1);
  }

  if (mode === "plist") {
    process.stdout.write(`${generateMacOsLaunchAgentPlist({ hostUrl, hotkey: spec.accelerator })}\n`);
    return;
  }

  const bridge = createCompanionBridge({ hostUrl, hotkey: spec.accelerator });
  if (mode === "toggle") {
    const res = await bridge.togglePushToTalk();
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(bridge.getStatus(), null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
