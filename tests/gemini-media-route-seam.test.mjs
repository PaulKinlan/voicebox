// tests/gemini-media-route-seam.test.mjs — the four Gemini media routes are a module now
// (voicebox-beads-r9hv.4, slice 3 of the voicebox-beads-r9hv ADR), and this file holds what the
// extraction can get wrong while the suite stays green.
//
// WHY THIS FILE EXISTS, AND WHY IT IS WRITTEN FROM FIRST PRINCIPLES: no existing test named
// /api/gemini, so there was no behaviour owner to lean on. And these handlers reach for EXTERNAL media
// APIs, so a test that drove them end to end would depend on a live provider and a key. Instead the
// providers (image, video start/poll, embeddings, semantic search) are injected fakes, and the seam is
// asserted where it can be: the refusal shapes, the argument shapes, the live root read, and the
// table's dispatch identity. The last test installs a fetch spy that throws on contact and asserts
// nothing in this file ever reaches the network — the fakes are unreachable-by-construction, and the
// spy is what turns that from a claim into a check.
//
// THE READ THAT MATTERS: `POST /api/gemini/image` honours `saveAs` only when the ACTIVE root is a
// machine root. In server.mjs `active` is a module-level `let`, reassigned when a root is declared or
// deleted, so the host hands over `getActiveRoot` and the handler reads it per request. A snapshot would
// freeze the boot-time root (the voicebox-beads-w1f9 shape), and the saveAs test below changes the
// accessor's answer between two calls, which is exactly what a snapshot fails.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGeminiMediaRoutes } from "../lib/routes/gemini-media.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE_KEYS = [
  "GET /api/gemini/capabilities",
  "POST /api/gemini/image",
  "POST /api/gemini/video",
  "POST /api/gemini/embed",
];

function wiringCall(source) {
  const start = source.indexOf("createGeminiMediaRoutes({");
  assert.ok(start > -1, "server.mjs must build the Gemini media routes");
  const end = source.indexOf("\n});", start);
  assert.ok(end > start, "the factory call must be closed");
  return source.slice(start, end);
}

function assertGeminiWiring(source) {
  const call = wiringCall(source);
  for (const dep of [
    "json",
    "readJsonBody",
    "answerOnce",
    "resolveActive",
    "getActiveRoot: () => active",
    "contentBodyMaxBytes: CONTENT_JSON_BODY_MAX_BYTES",
    "listGeminiCapabilities",
    "liveConfigCatalogue: GEMINI_LIVE_CONFIG_CATALOGUE",
    "generateGeminiImage",
    "startGeminiVideoGeneration",
    "pollGeminiVideoOperation",
    "embedGeminiTexts",
    "semanticSearchDocuments",
  ]) {
    assert.ok(call.includes(dep), `the host must hand over ${dep}`);
  }
  for (const key of ROUTE_KEYS) {
    assert.ok(!source.includes(`  "${key}": `), `no inline "${key}" may shadow the factory`);
  }
  // Dispatch order is the table's semantics, so pin the spread's position rather than just its presence:
  // these four entries sat between ...activityRoutes and "DELETE /api/root".
  const activity = source.indexOf("  ...activityRoutes,");
  const spread = source.indexOf("  ...geminiMediaRoutes,");
  const unroot = source.indexOf('  "DELETE /api/root": ');
  assert.ok(activity > -1 && spread > -1 && unroot > -1, "the table must still have activityRoutes, the gemini spread and DELETE /api/root");
  assert.ok(spread > activity && spread < unroot, "the gemini spread must stay where the four entries were: after ...activityRoutes and before DELETE /api/root");
}

test("the host wires the four media routes at their original table position and hands over a LIVE root accessor", () => {
  const source = readFileSync(path.join(REPO, "server.mjs"), "utf8");
  assertGeminiWiring(source);

  // SELF-PROVING MUTANTS: each way this slice rots must make the guard above throw, or the guard is decoration.
  const missingSpread = source.replace("  ...geminiMediaRoutes,\n", "");
  assert.notEqual(missingSpread, source, "the missing-spread mutant must change the source");
  assert.throws(() => assertGeminiWiring(missingSpread), { name: "AssertionError" });

  const shadowed = source.replace("  ...geminiMediaRoutes,\n", '  "POST /api/gemini/embed": () => null,\n');
  assert.notEqual(shadowed, source, "the shadowing mutant must change the source");
  assert.throws(() => assertGeminiWiring(shadowed), { name: "AssertionError" });

  // Move the spread to the FRONT of the table — a real reorder, not a no-op.
  const moved = source.replace("  ...geminiMediaRoutes,\n", "").replace("const routes = {\n", "const routes = {\n  ...geminiMediaRoutes,\n");
  assert.notEqual(moved, source, "the reordered mutant must change the source");
  assert.throws(() => assertGeminiWiring(moved), { name: "AssertionError" }, "position matters: dispatch order is behaviour");

  // THE SNAPSHOT MUTANT. NOTE THE SCOPING: `getActiveRoot: () => active,` now appears in TWO factories
  // (the tool-catalogue slice and this one), so a bare string replace would hit whichever comes first in
  // the file and this mutant would silently fail to throw. Mutate the extracted call instead.
  const call = wiringCall(source);
  const mutatedCall = call.replace("getActiveRoot: () => active,", "getActiveRoot: active,");
  assert.notEqual(mutatedCall, call, "the snapshot mutant must change the factory call");
  const snapshot = source.replace(call, mutatedCall);
  assert.throws(() => assertGeminiWiring(snapshot), { name: "AssertionError" }, "handing over the binding freezes the root at boot");
});

/** Build the routes with injected fakes, recording every provider call. */
function harness({ active = null } = {}) {
  const calls = { image: [], video: [], poll: [], embed: [], search: [], bodyMax: [] };
  let root = active;
  const answered = [];
  const routes = createGeminiMediaRoutes({
    json: (res, status, payload) => {
      answered.push({ status, payload });
      res.status = status;
      res.payload = payload;
      return res;
    },
    readJsonBody: async (req, _res, max) => {
      calls.bodyMax.push(max);
      return req.body === undefined ? null : req.body;
    },
    answerOnce: (res, fn) => fn(),
    resolveActive: (name) => ({ ok: true, path: path.join(scratchDir, name) }),
    getActiveRoot: () => root,
    contentBodyMaxBytes: 8 * 1024 * 1024,
    listGeminiCapabilities: () => ({ ok: true, configured: false, capabilities: { stubbed: true } }),
    liveConfigCatalogue: { stubbed: true },
    generateGeminiImage: async (args) => {
      calls.image.push(args);
      return { ok: true, model: "stub-image", mimeType: "image/png", data: "BASE64", caption: "a caption", bytes: Buffer.from("PNG-BYTES") };
    },
    startGeminiVideoGeneration: async (args) => {
      calls.video.push(args);
      return { ok: true, operationName: "op-1" };
    },
    pollGeminiVideoOperation: async (args) => {
      calls.poll.push(args);
      return { ok: true, done: true };
    },
    embedGeminiTexts: async (args) => {
      calls.embed.push(args);
      return { ok: true, embeddings: [] };
    },
    semanticSearchDocuments: async (args) => {
      calls.search.push(args);
      return { ok: true, results: [] };
    },
  });
  return { routes, calls, answered, setActive: (value) => { root = value; } };
}

let scratchDir;
test("the four routes: capabilities payload, provider refusal mapping, and the live root read", async (t) => {
  scratchDir = mkdtempSync(path.join(os.tmpdir(), "vb-gemini-seam-"));
  t.after(() => rmSync(scratchDir, { recursive: true, force: true }));

  // NEGATIVE CONTROL AT THE SEAM: the factory claims exactly four routes, in their original order, and
  // nothing else. A sibling spelling or a wrong method is the host's business, not this module's.
  const { routes, calls, answered, setActive } = harness();
  assert.deepEqual(Object.keys(routes), ROUTE_KEYS, "the four keys, in the order the table had them");
  assert.equal(routes["GET /api/geminiX"], undefined, "a sibling spelling must not be swallowed");
  assert.equal(routes["POST /api/gemini/capabilities"], undefined, "only the exact method+path is claimed");

  // 1. CAPABILITIES: the host's catalogue plus the frozen live-config catalogue, and no provider call.
  answered.length = 0;
  const capabilities = await routes["GET /api/gemini/capabilities"]({}, {});
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.payload, { ok: true, configured: false, capabilities: { stubbed: true }, liveConfigCatalogue: { stubbed: true } });
  assert.equal(calls.image.length + calls.video.length + calls.poll.length + calls.embed.length + calls.search.length, 0, "reading the catalogue must not call a provider");

  // 2. REFUSALS COME FIRST: a non-object body is 400 bad-request on every POST, and NO provider is reached —
  //    which is why a refusing request can never make an outbound call.
  for (const [key, marker] of [["POST /api/gemini/image", "image"], ["POST /api/gemini/video", "video"], ["POST /api/gemini/embed", "embed"]]) {
    answered.length = 0;
    const res = await routes[key]({ body: "not an object" }, {});
    assert.equal(res.status, 400, `${key} must refuse a non-object body`);
    assert.deepEqual(res.payload, { ok: false, refused: "bad-request", why: "body must be JSON" });
    assert.equal(calls[marker].length + calls.poll.length + calls.search.length, 0, `${key} must not reach a provider when it refuses`);
  }

  // 3. THE IMAGE ROUTE'S LARGER BODY CAP, and the reader default on the other two POSTs (voicebox-beads-d808).
  calls.bodyMax.length = 0;
  await routes["POST /api/gemini/image"]({ body: null }, {});
  await routes["POST /api/gemini/video"]({ body: null }, {});
  await routes["POST /api/gemini/embed"]({ body: null }, {});
  assert.deepEqual(calls.bodyMax, [8 * 1024 * 1024, undefined, undefined], "image takes the content cap; video and embed take the reader default");

  // 4. THE LIVE ROOT READ (the voicebox-beads-w1f9 shape). With no machine root declared, saveAs is
  //    ignored and nothing is written...
  const saveAs = "media/out.png";
  const beforeSave = await routes["POST /api/gemini/image"]({ body: { prompt: "a cat", saveAs } }, {});
  assert.equal(beforeSave.status, 200);
  assert.equal(beforeSave.payload.savedFile, null, "no machine root => saveAs is ignored");
  assert.equal(existsSync(path.join(scratchDir, saveAs)), false, "and nothing is written");
  assert.deepEqual(calls.image.at(-1).referenceImages, [], "referenceImages defaults to [] rather than being passed through as undefined");

  //    ...and when a machine root is declared AFTER the module was built, the same call saves. A snapshot
  //    of `active` keeps answering "no root" here and this assertion is what fails.
  setActive({ root: { kind: "machine", path: scratchDir } });
  const afterSave = await routes["POST /api/gemini/image"]({ body: { prompt: "a cat", saveAs } }, {});
  assert.equal(afterSave.payload.savedFile, saveAs, "the route must read the active root at request time — a captured snapshot keeps the boot-time root");
  assert.equal(existsSync(path.join(scratchDir, saveAs)), true, "and the bytes must reach the declared root");
  assert.equal(readFileSync(path.join(scratchDir, saveAs), "utf8"), "PNG-BYTES", "the provider's bytes are what gets written");
  assert.deepEqual(Object.keys(afterSave.payload), ["ok", "model", "mimeType", "data", "caption", "savedFile"], "the success envelope is unchanged");

  //    A non-machine root must not be written to, even though it is active.
  setActive({ root: { kind: "project", path: scratchDir } });
  const otherKind = await routes["POST /api/gemini/image"]({ body: { prompt: "a cat", saveAs: "media/other.png" } }, {});
  assert.equal(otherKind.payload.savedFile, null, "only a machine root is this process's filesystem to write to");
  assert.equal(existsSync(path.join(scratchDir, "media/other.png")), false);

  // 5. VIDEO: operationName polls, otherwise it starts, and ok:false maps to 400.
  calls.poll.length = 0; calls.video.length = 0;
  await routes["POST /api/gemini/video"]({ body: { operationName: "  op-9  " } }, {});
  assert.deepEqual(calls.poll, [{ operationName: "op-9" }], "a trimmed operationName polls");
  assert.equal(calls.video.length, 0, "and does not also start a generation");
  await routes["POST /api/gemini/video"]({ body: { prompt: "p", model: "m", aspectRatio: "16:9", durationSeconds: 4 } }, {});
  assert.deepEqual(calls.video, [{ prompt: "p", model: "m", aspectRatio: "16:9", durationSeconds: 4 }]);

  // 6. EMBED: query+documents searches; otherwise the texts normalisation (array / single string / nothing).
  calls.search.length = 0; calls.embed.length = 0;
  await routes["POST /api/gemini/embed"]({ body: { query: "q", documents: ["a", "b"], topK: 3 } }, {});
  assert.deepEqual(calls.search, [{ query: "q", documents: ["a", "b"], model: undefined, topK: 3 }]);
  await routes["POST /api/gemini/embed"]({ body: { texts: ["x", "y"] } }, {});
  await routes["POST /api/gemini/embed"]({ body: { text: "single" } }, {});
  await routes["POST /api/gemini/embed"]({ body: {} }, {});
  assert.deepEqual(calls.embed.map((c) => c.texts), [["x", "y"], ["single"], []], "array, single string, and nothing at all");
});

test("no call in this file reaches the network", async (t) => {
  scratchDir = mkdtempSync(path.join(os.tmpdir(), "vb-gemini-net-"));
  t.after(() => rmSync(scratchDir, { recursive: true, force: true }));

  // The providers are injected, so the real ones are unreachable by construction. This spy is what turns
  // that from a claim into a check: if anything here ever reached for the network, the test dies loudly.
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("this test must not touch the network");
  };
  try {
    const { routes } = harness({ active: { root: { kind: "machine", path: scratchDir } } });
    for (const key of ROUTE_KEYS) {
      await routes[key]({ body: key.includes("capabilities") ? undefined : { prompt: "p", saveAs: "net.png", texts: ["t"], query: "q", documents: [] } }, {});
    }
    assert.equal(fetchCalls, 0, "driving every route must not reach the network");
  } finally {
    globalThis.fetch = realFetch;
  }
});
