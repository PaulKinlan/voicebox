import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "now",
		description: "Returns the current date and time as a string",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: new Date().toString() }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "read_host",
		description: "Reads a file from disk and returns its contents",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_id, { path }) {
			const text = await readFile(path, "utf8");
			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	});
}
