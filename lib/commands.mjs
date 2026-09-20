// lib/commands.mjs — THE ONE COMMAND LIST.
//
// Every consumer that tells a model "what you can do" reads from here:
// the live session's tool declarations (lib/live-providers/gemini.mjs setup),
// the text resolver's contract (lib/resolver.mjs), and anything that lists
// capabilities. A second hand-maintained list is how two sources of truth
// grow back — add a command HERE and both model paths know it together.
//
// A command is the model-facing name plus the executor verb it maps to. The
// executor (server.mjs) is still the guard: a declaration says what the model
// may ASK for, and containment/refusal decide what actually happens.

export const COMMANDS = [
  {
    name: "write_file",
    verb: "write",
    description: "Create or overwrite a file in the active project. Use a plain file name, no directories.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "the file name, e.g. notes.txt" },
        content: { type: "string", description: "the exact text to write into the file" },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "read_file",
    verb: "read",
    description: "Read a file's contents from the active project.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "the file name to read" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_files",
    verb: "list",
    description: "List the files in the active project.",
    parameters: { type: "object", properties: {} },
  },
];

/** The verbs a model may produce — the resolver's allow-list, from the same list. */
export const COMMAND_VERBS = new Set(COMMANDS.map((c) => c.verb));

/** The declarations a live provider hands its vendor at setup time. */
export function functionDeclarations() {
  return COMMANDS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

/**
 * Map a model's tool call to an executor action: { verb, name, content? }.
 * An unknown command is null — the caller answers with a refusal, never a guess.
 */
export function commandToAction(name, args = {}) {
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) return null;
  return {
    verb: cmd.verb,
    name: String(args.name ?? ""),
    ...(args.content != null && { content: String(args.content) }),
  };
}

/**
 * The live session's system instruction, derived from the same list: what the
 * voice can do, where the files are, and that a refusal has a name and is
 * SPOKEN — a model that silently fails is worse than one that explains.
 */
export function liveSystemInstruction() {
  const verbs = COMMANDS.map((c) => `- ${c.name}: ${c.description}`).join("\n");
  return [
    "You are the voice of voicebox, a build environment on the user's machine. You can act on the active project with these tools:",
    verbs,
    "Rules you keep:",
    "- To create, read or list files you MUST call the tool. Never claim to have done it without the tool call.",
    "- After each tool call, tell the user the outcome in one short spoken sentence.",
    "- If a tool result has ok: false, SAY the refusal it names, exactly. 'root-not-declared' means no project folder has been declared yet — say you cannot act until one is, and stop. 'outside-root' means the name tried to leave the project — say so.",
    "- You have no other capabilities. If asked for anything else, say plainly that you cannot do it yet.",
  ].join("\n");
}
