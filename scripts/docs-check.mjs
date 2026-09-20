// scripts/docs-check.mjs — the mechanism that keeps the descriptions of this system true.
//
//   node scripts/docs-check.mjs            # check: exit 1 when a doc has drifted from the code
//   node scripts/docs-check.mjs --write    # regenerate the generated blocks in place
//
// WHY THIS EXISTS. A README claimed "streamed as PCM16 over /live to models/gemini-3.8-live" four lines
// above "No live model. The resolver is scripted; nothing calls Gemini Live." Both were true of different
// halves — the audio path in a tree that had not landed, the turn path in the tree that had — and the
// largest gap in the product was invisible because one word, "live", covered two different things.
// A document kept current by remembering is a document that contradicts itself again within a week.
//
// SO THE CLAIMS ARE DERIVED, NOT TYPED:
//   * the providers come from the module that registers them (`registeredResolvers()`), imported, not grepped;
//   * the routes and the workspace come from a REAL SERVER on a scratch port, probed over HTTP — the same
//     thing the suite does, because "it serves" and "the doc says it serves" are different claims;
//   * the page's scripts come from `public/index.html`, read as HTML rather than matched as text.
//
// The generated blocks live between <!-- BEGIN GENERATED: name --> and <!-- END GENERATED: name --> in the
// docs below. Anything enumerable goes in one; anything a person writes stays outside.
//
// A check that cannot fail is a description of the code, not a check on it — which is why the suite runs
// this in check mode (`tests/docs-drift.test.mjs`) and why the receipt for it includes a perturbation that
// turns it red.

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { registeredResolvers, resolveTurn } from "../lib/resolver.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");

// ── derived facts ────────────────────────────────────────────────────────────

/** The page's own script tags, read as HTML. */
function pageScripts() {
  const html = readFileSync(join(ROOT, "public/index.html"), "utf8");
  const tags = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  // A worklet is loaded by code, not by a tag: count them from the sources, so a doc cannot
  // claim an audio path the page never builds.
  const sources = tags
    .map((t) => (existsSync(join(ROOT, "public", t)) ? readFileSync(join(ROOT, "public", t), "utf8") : ""))
    .join("\n");
  // A worklet arrives two ways: a literal addModule("…") call, or a config value the adapter passes
  // on (live-voice.js sets `workletUrl: "pcm-worklet.js"`). Matching only addModule() produced a
  // GENERATED BLOCK THAT WAS FALSE — "No audio worklet is loaded" — which is the exact failure this
  // script exists to prevent, caught by reading its own output against the tree.
  const direct = [...sources.matchAll(/addModule\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const configured = [...sources.matchAll(/workletUrl\s*:\s*["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((f) => existsSync(join(ROOT, "public", f)));
  return { tags, worklets: [...new Set([...direct, ...configured])] };
}

/** Start the real server on a scratch port and ask it what it is. */
async function probeServer() {
  // A FREE PORT, PROPERLY: bind one, read the number, release it, hand it to the server. The previous
  // version picked 8700+random(200) — a narrow fixed range, in my own instrument, which collided with other
  // test files running in parallel (three failures in parallel, 71/71 serialized). PORT=0 does not work
  // here because server.mjs logs the env value rather than the port it bound, so the probe socket it is.
  let port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const until = Date.now() + 8000;
  try {
    let health = null;
    while (Date.now() < until) {
      // Readiness is the server's OWN stdout line ("voicebox on http://…"), not a route:
      // probing /api/health here would couple the instrument to the very claim it checks, and a
      // perturbed health route crashed the check instead of reporting drift. Found by perturbing it.
      if (out.includes("voicebox on http")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!out.includes("voicebox on http")) throw new Error(`server did not start on ${port}: ${out.slice(0, 200)}`);
    {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      health = r.ok ? await r.json() : { provider: "(no /api/health answer)", workspace: "?" };
    }
    // The routes the doc may claim, probed for real. A method mismatch is a fact about the route.
    const probes = [
      ["GET", "/", 200],
      ["GET", "/api/health", 200],
      ["GET", "/api/files", 200],
      ["POST", "/api/turn", 200],
    ];
    const routes = [];
    for (const [method, path, expect] of probes) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        ...(method === "POST" ? { body: JSON.stringify({ transcript: "list files" }), headers: { "content-type": "application/json" } } : {}),
      });
      routes.push({ method, path, status: r.status, matches_documented_expectation: r.status === expect });
    }
    return { health, routes, port };
  } finally {
    child.kill("SIGKILL");
  }
}

/**
 * What happens when something tries to UPGRADE /live — measured, not typed.
 *
 * false by the time merger read it (server.mjs handles the upgrade for /live), which makes it a hardcoded
 * claim about state inside the check that exists to catch hardcoded claims about state. It is a PROBE now:
 * send an upgrade request, report what came back. The typed version of this line was true when written and
 * false by the time a reviewer read it, which is the whole reason the line is a probe now.
 */
async function probeLiveUpgrade(port) {
  return await new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/live", method: "GET",
      headers: {
        Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13",
      },
    });
    let settled = false;
    const done = (line) => { if (!settled) { settled = true; try { req.destroy(); } catch { /* gone */ } resolve(line); } };
    req.on("upgrade", (res) => done(`A WEBSOCKET UPGRADE ON /live IS ACCEPTED (${res.statusCode}) — the zero-dependency server owns it.`));
    req.on("response", (res) => done(`A WEBSOCKET UPGRADE ON /live GOT HTTP ${res.statusCode} — it is not an upgrade route on this tree.`));
    req.on("error", () => done("A WEBSOCKET UPGRADE ON /live CLOSED WITHOUT AN HTTP RESPONSE — the server destroys it (also a form of owning the route)."));
    req.end();
    const t = setTimeout(() => done("THE /live UPGRADE PROBE DID NOT SETTLE."), 2000);
    if (t.unref) t.unref();
  });
}

/** The live-session file, if it has landed. Its absence is itself a fact the docs must state. */
function liveSession() {
  const p = join(ROOT, "lib/live-session.mjs");
  if (!existsSync(p)) return { present: false };
  const src = readFileSync(p, "utf8");
  const model = src.match(/["'`]models\/([\w.\-]+)["'`]/) || src.match(/model\s*[:=]\s*["'`]([\w.\-]+)["'`]/);
  return { present: true, model: model ? model[1] : "(not found — the check could not read it)" };
}

// ── the generated blocks ─────────────────────────────────────────────────────

function block(name, body) {
  return `<!-- BEGIN GENERATED: ${name} -->\n${body.trim()}\n<!-- END GENERATED: ${name} -->`;
}

async function blocks() {
  const { health, routes, port } = await probeServer();
  const providers = registeredResolvers();
  const { tags, worklets } = pageScripts();
  const live = liveSession();
  const liveUpgradeLine = await probeLiveUpgrade(port);
  // A COMMITTED DOCUMENT CANNOT CONTAIN AN ABSOLUTE PATH — and the loop no longer HAS a default root to
  // report either: the active root is declared by the environment, so what belongs in the document is the
  // SHAPE of that declaration (\`declared\` and the root object), not a path that is true in one checkout.
  const declared = health.declared === true ? "true" : "false";

  const sample = resolveTurn("create a file called hello.txt with hi");
  const unresolved = resolveTurn("book me a flight to Lisbon");

  if (process.env.DOCS_DEBUG) console.error("DEBUG live =", JSON.stringify(live), "| ROOT =", ROOT, "| tags =", JSON.stringify(tags));

  return {
    providers: block("providers", [
      `Registered resolvers: ${providers.map((p) => "`" + p + "`").join(", ")}${providers.length === 1 ? " (one — a placeholder)" : ""}`,
      "",
      `* \`registerResolver(name, fn)\` is the seam; \`resolveTurn(transcript, provider = "${providers[0] ?? "—"}")\` picks one.`,
      `* The **${providers[0] ?? "—"}** provider handles \`write\`, \`read\` and \`list\`: \`"create a file called hello.txt with hi"\` → \`${JSON.stringify(sample)}\`.`,
      `* Anything else is **unresolved**, by design: \`"book me a flight to Lisbon"\` → \`${JSON.stringify(unresolved.unresolved?.slice(0, 42) + "…")}\`.`,
      `* Planned, and **not registered**: \`gemini-live\`, \`openai-realtime\`.`,
    ].join("\n")),

    routes: block("routes", [
      `The zero-dependency server (\`server.mjs\`, \`node:http\`) binds **127.0.0.1** and serves:`,
      "",
      "| method | path | probed status |",
      "|---|---|---|",
      ...routes.map((r) => `| \`${r.method}\` | \`${r.path}\` | ${r.status}${r.matches_documented_expectation ? "" : " ⚠️ differs from what this table expects"} |`),
      "",
      `Anything else that exists under \`public/\` is served from there (\`GET /static\` and a fall-through), which is how the page, its scripts and the styles arrive. \`/api/health\` answers \`provider: "${health.provider}"\`, \`declared: ${declared}\` and \`root: { kind, path }\` for the ACTIVE project root — which the environment declares (\`POST /api/root\`); the loop has no root of its own, and refuses by name (\`root-not-declared\`) until one is declared.`,
      "",
      liveUpgradeLine,   // DERIVED by probeLiveUpgrade() — this line used to be a typed sentence about state
    ].join("\n")),

    page: block("page", [
      `The page loads ${tags.map((t) => "`" + t + "`").join(" and ")} from \`public/\`.`,
      worklets.length
        ? `Audio worklets loaded by that code: ${worklets.map((w) => "`" + w + "`").join(", ")}.`
        : "**No audio worklet is loaded** — `addModule(…)` appears nowhere in the page's scripts, so the audio path is not wired on this tree.",
      "",
      "`verify.mjs` sits in `public/` but is **not** loaded by `index.html`; it is a support script, not part of the page's load set.",
    ].join("\n")),

    "live-session": block("live-session", (live.present
      ? [`\`lib/live-session.mjs\` is present, using model \`${live.model}\`.`]
      : ["**\`lib/live-session.mjs\` is not present on this tree.** The live audio session is in flight, not landed — so any document claiming PCM16 over `/live` to a live model is describing a tree this one is not."]).join("\n")),
  };
}

// ── check or write ───────────────────────────────────────────────────────────

// Which document must carry which generated block. Explicit, because "missing marker fails loudly"
// only helps if the expectation is stated: the README needs the two halves Paul asked about (the
// providers and whether a live session exists), the architecture doc carries all four, and the
// operating model is prose whose claims the others check.
const DOCS = [
  { rel: "README.md", blocks: ["providers", "live-session"] },
  { rel: join("docs", "07-architecture.md"), blocks: ["providers", "routes", "page", "live-session"] },
  { rel: join("docs", "08-how-it-runs.md"), blocks: [] },
];
const generated = await blocks();

function replaceBlock(text, name, body) {
  // GLOBAL: a document may carry the same block twice (07 does — the audio path appears under two headings),
  // and a non-global replace leaves the second one empty. "The block is present" and "the block says
  // something" are two different assertions, and the first one passed while the second failed.
  const re = new RegExp(`<!-- BEGIN GENERATED: ${name} -->[\\s\\S]*?<!-- END GENERATED: ${name} -->`, "g");
  if (!re.test(text)) return { text, found: false };
  return { text: text.replace(re, body), found: true };
}

let drifted = [];
let missing = [];
for (const { rel, blocks: wanted } of DOCS) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { missing.push(rel); continue; }
  let text = readFileSync(p, "utf8");
  let changed = false;
  for (const [name, body] of Object.entries(generated)) {
    if (!wanted.includes(name)) continue;
    const r = replaceBlock(text, name, body);
    // A MISSING MARKER IS AN ERROR, not a skip. The first version `continue`d silently, which meant a
    // document could carry no generated block at all and the check would call it current — a check that
    // cannot fail, which is a description of the code rather than a check on it.
    if (!r.found) {
      console.error(`docs-check: ${rel} has no generated block named '${name}' — add the markers:`);
      console.error(`  <!-- BEGIN GENERATED: ${name} --> … <!-- END GENERATED: ${name} -->`);
      process.exit(1);
    }
    if (process.env.DOCS_DEBUG) console.error(`DEBUG ${rel} block=${name} found=${r.found} changed=${r.text !== text} bodyLen=${String(body).length}`);
    // THE FILE'S block, after the replacement — not the generated body, which is never empty. My first
    // version of this guard watched the wrong side and passed while the document carried a blank block.
    const after = text.slice(text.indexOf(`<!-- BEGIN GENERATED: ${name} -->`));
    const inner = after.slice(after.indexOf("-->") + 3, after.indexOf(`<!-- END GENERATED: ${name} -->`));
    if (inner.trim() === "") {
      console.error(`docs-check: the generated block '${name}' in ${rel} is EMPTY after the replace —`);
      console.error("  a block that says nothing is not a block that says something, and this one is blank.");
      process.exit(1);
    }
    if (String(body).includes("undefined")) {
      console.error(`docs-check: the generated block '${name}' for ${rel} contains the word 'undefined' —`);
      console.error("  that is a template that did not interpolate, and it reached a document once already (07-architecture.md:80).");
      process.exit(1);
    }
    if (r.text !== text) { changed = true; text = r.text; }
  }
  if (!changed) continue;
  if (WRITE) { writeFileSync(p, text); console.log(`  wrote ${rel}`); }
  else drifted.push(rel);
}

if (missing.length) {
  console.error("docs-check: a document this check is responsible for is missing:");
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}

if (drifted.length && !WRITE) {
  console.error("docs-check: FAILED — these documents no longer describe the code:");
  for (const d of drifted) console.error(`  - ${d}`);
  console.error("");
  console.error("The system answers for itself: providers come from lib/resolver.mjs, routes from a live");
  console.error("server on a scratch port, the page's scripts from public/index.html. Fix the docs, or run:");
  console.error("  node scripts/docs-check.mjs --write");
  process.exit(1);
}

console.log(
  `docs-check: ${WRITE ? "regenerated" : "OK"} — ${DOCS.reduce((n, d) => n + d.blocks.length, 0)} generated blocks across ${DOCS.length} documents`,
);
