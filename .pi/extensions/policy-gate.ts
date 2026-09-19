// .pi/extensions/policy-gate.ts — compliant-mode gate (k3, 2026-09-19)
//
// The named mechanism from docs/03-architecture-k3.md §3.2: intercept every
// tool call BEFORE it executes, present the plan in the harness's own words
// (tool name + full input), ask via ctx.ui.confirm() — the channel C2 proved
// is wired end-to-end (extension_ui_request → session/request_permission) —
// block until the answer arrives, and honour it. A denied call never
// executes: the block returns before the tool runs.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		// The plan, in the harness's own words — BEFORE the act. The host's
		// decision is made on content (tool + full input), never on a title.
		const plan = JSON.stringify({ tool: event.toolName, input: event.input }, null, 2);
		const ok = await ctx.ui.confirm(
			`Permission: ${event.toolName}`,
			`The agent wants to run this tool:\n\n${plan.slice(0, 1500)}\n\nAllow it to execute?`,
		);
		if (!ok) {
			return { block: true, reason: `denied by the host: ${event.toolName} was not allowed to run` };
		}
	});
}
