import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTurn } from "../lib/resolver.mjs";

test("resolver grammar: web search phrasings route to web_search extension", async () => {
  for (const [transcript, query] of [
    ["web search for voicebox news", "voicebox news"],
    ["search the web for indexdb limits", "indexdb limits"],
    ["web_search quantum computing 2026", "quantum computing 2026"],
  ]) {
    const r = await resolveTurn(transcript, "script");
    assert.equal(r.verb, "extension");
    assert.equal(r.name, "web_search");
    assert.equal(r.args.query, query, `${transcript}: wrong query`);
  }
});

test("resolver grammar: 'search for X' (no web) stays grep", async () => {
  const r = await resolveTurn("search for hello", "script");
  assert.equal(r.verb, "grep");
  const r2 = await resolveTurn("grep for world", "script");
  assert.equal(r2.verb, "grep");
});
