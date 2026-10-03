// lib/agent-monitor-app.mjs — Built-in Agent Progress Tracker mini-app descriptor.

import fs from "node:fs";

const html = fs.readFileSync(
  new URL("../public/apps/agent-monitor.html", import.meta.url),
  "utf8",
);

export const AGENT_MONITOR_APP_ID = "agent-progress-tracker";

export const AGENT_MONITOR_MINI_APP = Object.freeze({
  appId: AGENT_MONITOR_APP_ID,
  title: "Agent Progress Tracker",
  html,
});

export function getAgentMonitorMiniApp() {
  return { ...AGENT_MONITOR_MINI_APP };
}
