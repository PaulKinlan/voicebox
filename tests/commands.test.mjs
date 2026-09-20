// tests/commands.test.mjs — the ONE command list: shape, mapping, and the
// refusal vocabulary the live model is instructed to speak.
import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, COMMAND_VERBS, commandToAction, functionDeclarations, liveSystemInstruction } from "../lib/commands.mjs";

test("the list declares write/read/list — the executor's verbs, once", () => {
  assert.deepEqual([...COMMAND_VERBS].sort(), ["list", "read", "write"]);
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
});

test("commandToAction maps a tool call to the executor's action shape", () => {
  assert.deepEqual(commandToAction("write_file", { name: "a.txt", content: "hi" }), { verb: "write", name: "a.txt", content: "hi" });
  assert.deepEqual(commandToAction("read_file", { name: "a.txt" }), { verb: "read", name: "a.txt" });
  assert.deepEqual(commandToAction("list_files"), { verb: "list", name: "" });
});

test("an unknown command maps to null — the caller refuses, never guesses", () => {
  assert.equal(commandToAction("delete_everything", {}), null);
  assert.equal(commandToAction("write-file", { name: "x" }), null, "near-miss spellings are not accepted");
});

test("the system instruction names the tools AND the spoken refusals", () => {
  const text = liveSystemInstruction();
  for (const c of COMMANDS) assert(text.includes(c.name), `the instruction must name ${c.name}`);
  assert.match(text, /root-not-declared/, "the refusal vocabulary is in the instruction");
  assert.match(text, /never claim|Never claim/i, "the no-pretending rule is in the instruction");
});
