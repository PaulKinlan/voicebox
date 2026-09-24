// tests/commands.test.mjs — the ONE command list: shape, mapping, and the
// refusal vocabulary the live model is instructed to speak.
import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, COMMAND_VERBS, commandToAction, functionDeclarations, liveSystemInstruction } from "../lib/commands.mjs";

test("the list declares file and extension actions — the executor's verbs, once", () => {
  assert.deepEqual([...COMMAND_VERBS].sort(), ["contact_agent", "delegate_task", "delete", "diff", "edit", "extension", "extensions", "grep", "list", "list_agents", "read", "write"]);
  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, "command names must be unique");
});

test("functionDeclarations are vendor-ready JSON-schema declarations", () => {
  const decls = functionDeclarations();
  assert.equal(decls.length, COMMANDS.length);
  for (const d of decls) {
    assert.equal(typeof d.name, "string");
    assert.equal(typeof d.description, "string");
    assert.equal(d.parameters.type, "object");
  }
  const write = decls.find((d) => d.name === "write_file");
  assert.deepEqual(write.parameters.required.sort(), ["content", "name"]);
  const del = decls.find((d) => d.name === "delete_file");
  assert.deepEqual(del.parameters.required.sort(), ["name"]);
  const edit = decls.find((d) => d.name === "edit_file");
  assert.deepEqual(edit.parameters.required.sort(), ["name", "newText", "oldText"]);
  const diff = decls.find((d) => d.name === "diff_file");
  assert.deepEqual(diff.parameters.required.sort(), ["content", "name"]);
  const grep = decls.find((d) => d.name === "grep_files");
  assert.deepEqual(grep.parameters.required.sort(), ["query"]);
  const delegate = decls.find((d) => d.name === "delegate_task");
  assert.deepEqual(delegate.parameters.required.sort(), ["agent", "task"]);
});

test("commandToAction maps a tool call to the executor's action shape", () => {
  assert.deepEqual(commandToAction("write_file", { name: "a.txt", content: "hi" }), { verb: "write", name: "a.txt", content: "hi" });
  assert.deepEqual(commandToAction("read_file", { name: "a.txt" }), { verb: "read", name: "a.txt" });
  assert.deepEqual(commandToAction("list_files"), { verb: "list", name: "" });
  assert.deepEqual(commandToAction("delete_file", { name: "a.txt" }), { verb: "delete", name: "a.txt" });
  assert.deepEqual(commandToAction("edit_file", { name: "a.txt", oldText: "foo", newText: "bar" }), { verb: "edit", name: "a.txt", oldText: "foo", newText: "bar" });
  assert.deepEqual(commandToAction("diff_file", { name: "a.txt", content: "new text" }), { verb: "diff", name: "a.txt", content: "new text" });
  assert.deepEqual(commandToAction("grep_files", { query: "target" }), { verb: "grep", name: "", query: "target" });
  assert.deepEqual(commandToAction("list_agents"), { verb: "list_agents", name: "" });
  assert.deepEqual(commandToAction("delegate_task", { agent: "pi", task: "calculate" }), { verb: "delegate_task", agent: "pi", task: "calculate" });
});

test("extension calls preserve arguments and refuse malformed values", () => {
  assert.deepEqual(commandToAction("list_extensions"), { verb: "extensions", name: "" });
  assert.deepEqual(commandToAction("call_extension", { name: "web_search", url: "https://example.com/?q=Saturn" }), {
    verb: "extension", name: "web_search", args: { url: "https://example.com/?q=Saturn" },
  });
  assert.deepEqual(commandToAction("call_extension", { name: "clock" }), { verb: "extension", name: "clock", args: {} });
  for (const args of [{ name: "" }, { name: 1 }, { name: "clock", url: {} }, { name: "clock", authority: "host" }, JSON.parse('{"name":"clock","__proto__":"bad"}')]) {
    assert.equal(commandToAction("call_extension", args).refused, "invalid-argument");
  }
  assert.equal(commandToAction("call_extension", {}).refused, "missing-argument");
});

test("an unknown command maps to null — the caller refuses, never guesses", () => {
  assert.equal(commandToAction("delete_everything", {}), null);
  assert.equal(commandToAction("write-file", { name: "x" }), null, "near-miss spellings are not accepted");
});

test("a missing required argument is a NAMED REFUSAL, never a coercion", () => {
  // astra's argument-rename mutation: `filename` for `name` used to coerce to name=""
  // and the supplied value was silently gone.
  const renamed = commandToAction("write_file", { filename: "notes.txt", content: "hi" });
  assert.equal(renamed.refused, "missing-argument", JSON.stringify(renamed));
  assert.match(renamed.why, /name/, "the refusal names the missing argument");
  const noContent = commandToAction("write_file", { name: "notes.txt" });
  assert.equal(noContent.refused, "missing-argument");
  assert.match(noContent.why, /content/);
  // And a valid call still maps clean:
  assert.deepEqual(commandToAction("write_file", { name: "a.txt", content: "" }), { verb: "write", name: "a.txt", content: "" });
});

test("the text resolver's instruction is GENERATED from the same list — no fourth copy", async () => {
  const { RESOLVER_SYSTEM } = await import("../lib/resolver.mjs");
  for (const c of COMMANDS) {
    assert(RESOLVER_SYSTEM.includes(c.instruction), `the resolver instruction is missing ${c.verb}'s own line — a hand-maintained copy crept back`);
  }
});

test("the system instruction names the tools AND the spoken refusals", () => {
  const text = liveSystemInstruction();
  for (const c of COMMANDS) assert(text.includes(c.name), `the instruction must name ${c.name}`);
  assert.match(text, /root-not-declared/, "the refusal vocabulary is in the instruction");
  assert.match(text, /never claim|Never claim/i, "the no-pretending rule is in the instruction");
});
