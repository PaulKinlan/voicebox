// TEST INSTRUMENT ONLY: D1 owns a held, credential-free ACP diagnostic, not a model task.
import fs from "node:fs";
import path from "node:path";
import { installTaskExecutor } from "../../lib/tasks.mjs";
import { createPiAcpExecutor, openPiAcpProbe } from "../../lib/pi-acp.mjs";
const production = createPiAcpExecutor();
const controls = process.env.VOICEBOX_TASK_FIXTURE;
installTaskExecutor({
  check({ input }) {
    if (input.agent !== "diagnostic-only") return production.check({ input });
    // 'closed-host-fixture' is the host-fixture seam in lib/tasks.mjs:290 — this executor IS the
    // boundary (bwrap, no network, no credentials), so a configured-agent record is not required.
    // Without the marker, delegate_task refuses agent-not-configured before run() ever probes.
    return { ok: true, mechanism: "closed-host-fixture: test-only bwrap, no network, credential-free ACP diagnostic", bounds: { deadlineMs: 20000, maxOutputBytes: 1024 } };
  },
  async run() {
    const probe = await openPiAcpProbe({ adapterDir: process.env.VOICEBOX_ACP_ADAPTER, piBinary: process.env.VOICEBOX_ACP_PI, timeoutMs: 15000 });
    fs.appendFileSync(path.join(controls, "acp-starts.jsonl"), JSON.stringify({ pid: probe.pid, agentInfo: probe.info.agentInfo }) + "\n");
    const end = await probe.exited;
    throw end.outcome;
  },
});
