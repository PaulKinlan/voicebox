// tests/mini-app-save-membership.test.mjs — the save-sync membership gate, driven against the
// SHIPPED function body, not a copy (voicebox-beads-z7ks).
//
// WHY THIS FILE EXISTS. voicebox-beads-9lpi gated the editor save's shelf sync on catalog
// membership, but the gate fell back to the STALE cached catalog when the GET failed — and the
// cache can still name an app whose shelf record another client deleted, so a save re-POSTed and
// re-created the deletion (rev-9lpi's FAIL finding, reproduced by VM extraction). A source-text
// pin cannot see which value `listed` holds on the failure path; only driving the function can.
//
// THE MUTANTS this file turns RED:
//   · `let listed = catalogMiniApps` (the z7ks defect itself) — the offline-fallback arm POSTs;
//   · dropping the `if (onShelf)` gate — the non-member arm POSTs;
//   · treating an unparseable catalog body as membership — the unparseable arm POSTs.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const FUSED = new URL("../public/fused.js", import.meta.url);

/** Extract one top-level function's source by brace matching from its declaration. */
function extractFunction(source, decl) {
  const start = source.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist in public/fused.js — a rename breaks this drive, which is the point`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${decl}`);
}

const FN_SOURCE = extractFunction(readFileSync(FUSED, "utf8"), "async function syncMiniAppAfterFileSave");

/**
 * Drive the shipped function with mocked globals. fetchImpl decides per URL; postCount counts
 * POST /api/mini-apps CALLS (the function fires it void, but the call itself is synchronous once
 * the GET resolves).
 */
async function driveSave({ cached, fetchImpl }) {
  let postCount = 0;
  const context = {
    miniAppSyncName: (f) => f,
    isHtmlFileName: (f) => typeof f === "string" && f.endsWith(".html"),
    normalizeMiniAppKey: (k) => String(k).toLowerCase(),
    catalogMiniApps: cached,
    launchedMiniApps: new Map(),
    miniAppController: undefined,
    sqehSyncMiniApps: undefined,
    AbortSignal,
    console,
    fetch: async (url, opts) => {
      if (opts && opts.method === "POST") {
        postCount++;
        return { ok: true, status: 200 };
      }
      return fetchImpl(url);
    },
  };
  vm.createContext(context);
  vm.runInContext(`${FN_SOURCE}; syncMiniAppAfterFileSave`, context);
  await context.syncMiniAppAfterFileSave("draft.html", "<!doctype html><p>edited</p>");
  return postCount;
}

const GET_OK_WITH = (miniApps) => async () => ({
  ok: true,
  json: async () => ({ miniApps }),
});

test("z7ks: a failed catalog GET does NOT answer membership from the stale cache — no re-promotion POST", async () => {
  const posts = await driveSave({
    cached: [{ id: "app_draft", fileName: "draft.html" }], // deleted on the server, alive in the cache
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.equal(posts, 0, "an unreadable catalog must mean NO creation, even when the cache says the app is on the shelf");
});

test("z7ks: a 200 with an unparseable catalog body is still UNCONFIRMED — no POST", async () => {
  const posts = await driveSave({
    cached: [{ id: "app_draft", fileName: "draft.html" }],
    fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError("not json"); } }),
  });
  assert.equal(posts, 0);
});

test("confirmed shelf membership still earns the sync POST (the 9lpi contract's other half)", async () => {
  const posts = await driveSave({
    cached: [],
    fetchImpl: GET_OK_WITH([{ id: "app_draft", fileName: "draft.html" }]),
  });
  assert.equal(posts, 1, "a promoted app's save refreshes its shelf copy");
});

test("a confirmed NON-member's save posts nothing (the original 9lpi negative)", async () => {
  const posts = await driveSave({
    cached: [{ id: "app_draft", fileName: "draft.html" }],
    fetchImpl: GET_OK_WITH([]),
  });
  assert.equal(posts, 0, "the fresh catalog's answer replaces the cache, it does not merge with it");
});
