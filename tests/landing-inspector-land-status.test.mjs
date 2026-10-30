// tests/landing-inspector-land-status.test.mjs — the branch inspector's landing claim is earned by the
// server's ANSWER (voicebox-beads-ulhi).
//
// THE DEFECT this pins. `public/apps/landing-inspector.js`'s `landBranch` POSTed, DISCARDED the response, and
// then printed "Landed <branch> cleanly into main." and marked the branch `landed` locally — so it said the
// branch was in main when the merge had been refused, when the request never reached a server, and even when
// there was no such route: it POSTed `/api/branches/land` and the host route is `POST /api/branches/merge`
// (lib/routes/branches.mjs), so the ONLY thing that ever happened on a real host was a 404 followed by a
// success message. `keepBranchSeparateAction`, one function down, claimed the host had recorded a
// "keep separate" decision without making any request at all.
//
// WHY A UNIT TEST AT A TOOL SEAM RATHER THAN A BROWSER RUN: the module is an IIFE over `window`/`document`,
// and it hands its three Web MCP tools to `window.voicebox.registerTool`. That registration is the real seam
// the page uses, so this test evaluates the SHIPPED SOURCE in a `vm` context with a fake window/document and a
// fetch that returns exactly what each case needs — which is the only way to make a 200-with-`ok:false`, a
// rejection and a 404 deterministic. The browser tier cannot be made to produce those on demand.
//
//   node --test tests/landing-inspector-land-status.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(path.join(ROOT, "public/apps/landing-inspector.js"), "utf8");
const BRANCH_ROUTES = readFileSync(path.join(ROOT, "lib/routes/branches.mjs"), "utf8");

/** The branch the module ships with, and the one every case below acts on. */
const BRANCH = "feat/voice-greeting-polish";

/** Just enough of an element for this module's render path: it sets text, appends children, takes listeners. */
function fakeElement(tag = "div") {
  return {
    tagName: String(tag).toUpperCase(),
    className: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    type: "",
    dataset: {},
    style: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append(...nodes) {
      this.children.push(...nodes);
    },
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
    },
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    _listeners: {},
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    fire(type) {
      for (const fn of this._listeners[type] ?? []) fn({ type, preventDefault() {}, stopPropagation() {} });
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
  };
}

/**
 * Load the SHIPPED source with a fake window/document and the given fetch. Returns the tools the module
 * registered (the seam the page and the voice assistant both use) plus the element its status text lands in.
 */
function loadInspector(fetchImpl) {
  const elements = new Map();
  for (const id of ["review-action-status", "branch-list", "selected-branch-heading", "merge-compatibility-badge", "totals-summary", "changed-files-list", "diff-viewer", "land-branch-btn", "keep-separate-btn", "refresh-branches-btn"]) {
    elements.set(id, fakeElement(id.endsWith("-btn") ? "button" : "div"));
  }
  const tools = new Map();
  const document = {
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => fakeElement(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = {
    JSON,
    voicebox: {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      ready() {},
    },
    addEventListener() {},
  };
  // calls = the ACTION POSTs only. The module now also GETs /api/branches/candidates at boot
  // (that boot fetch IS the v1k6 fix — real candidates instead of fabricated rows); this suite's
  // subject is the POST contract ("nothing is POSTed for a refused land", "every POST hits a route
  // the host serves"), so the boot GET is not counted here.
  const calls = [];
  const fetch = async (url, options = {}) => {
    if ((options.method ?? "GET") !== "GET") calls.push({ url, options });
    return fetchImpl(url, options);
  };
  vm.runInNewContext(SOURCE, { window, document, fetch, console, setTimeout, clearTimeout }, { filename: "public/apps/landing-inspector.js" });
  /** The real UI path: click the button the page renders, then let the promise chain it started finish. */
  const click = async (id) => {
    elements.get(id).fire("click");
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  return { tools, elements, calls, click, statusText: () => elements.get("review-action-status").textContent };
}

/** A Response-alike: the module reads `.ok`, `.status` and `.text()`, and nothing else. */
function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const landTool = (loaded) => loaded.tools.get("land_candidate_branch");

test("the module registers the landing tool at the seam this test drives", () => {
  const loaded = loadInspector(async () => response(200, { ok: true }));
  for (const name of ["list_candidate_branches", "inspect_branch_diff", "land_candidate_branch"]) {
    assert.ok(loaded.tools.has(name), `the module no longer registers ${name} — this test would be driving nothing`);
  }
});

test("a refused land (409 with a body) is reported as a failure and never as 'Landed … cleanly'", async () => {
  const loaded = loadInspector(async () => response(409, { ok: false, refused: "merge-conflict", why: "Candidate branch has conflicts with main." }));
  const result = await landTool(loaded).execute({ branch: BRANCH });

  assert.equal(result.ok, false, "a refused merge must not report ok");
  assert.equal(result.refused, "merge-conflict", "the server's own refusal name must reach the caller");
  assert.equal(result.status, 409);
  assert.doesNotMatch(loaded.statusText(), /cleanly/i, `the screen claimed a landing that did not happen: ${loaded.statusText()}`);
  assert.match(loaded.statusText(), /Could not land/, `the failure must be shown, not swallowed: ${loaded.statusText()}`);
});

test("a 200 whose body says it did NOT land is still a failure — the body decides, not the status", async () => {
  // The trap a status-only check leaves open: an intermediary or a future route answering 200 with a refusal
  // body. `ok: false` inside the answer is the branch NOT being in main.
  const loaded = loadInspector(async () => response(200, { ok: false, refused: "checkout-failed", why: "Could not switch to base branch main." }));
  const result = await landTool(loaded).execute({ branch: BRANCH });

  assert.equal(result.ok, false);
  assert.equal(result.refused, "checkout-failed");
  assert.doesNotMatch(loaded.statusText(), /cleanly/i);
});

test("a request that never completes is a failure, not an optimistic local landing", async () => {
  const loaded = loadInspector(async () => {
    throw new Error("network down");
  });
  const result = await landTool(loaded).execute({ branch: BRANCH });

  assert.equal(result.ok, false, "a rejected fetch must not report ok");
  assert.match(String(result.error), /network down/, "the transport error must be named, not discarded");
  assert.doesNotMatch(loaded.statusText(), /cleanly/i);
});

test("a missing route (404) is a failure — this is the defect's own case, POSTed at a route that did not exist", async () => {
  const loaded = loadInspector(async () => response(404, "<html>not found</html>"));
  const result = await landTool(loaded).execute({ branch: BRANCH });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.match(loaded.statusText(), /HTTP 404/, `an unparseable 404 must still name the status: ${loaded.statusText()}`);
  assert.doesNotMatch(loaded.statusText(), /cleanly/i);
});

test("a real landing is reported only when the host says ok, and it is POSTed at the route the host serves", async () => {
  const loaded = loadInspector(async () => response(200, { ok: true, action: "landed", branch: BRANCH, baseBranch: "main", headCommit: "abc1234" }));
  const result = await landTool(loaded).execute({ branch: BRANCH });

  assert.equal(result.ok, true);
  assert.equal(result.action, "landed");
  assert.equal(result.headCommit, "abc1234", "the landed commit the host named must reach the caller");
  assert.match(loaded.statusText(), new RegExp(`Landed ${BRANCH.replace(/[/-]/g, (c) => `\\${c}`)} cleanly into main`));
  assert.match(loaded.statusText(), /abc1234/, "the confirmation should name the commit the host landed");

  assert.equal(loaded.calls.length, 1);
  const [{ url, options }] = loaded.calls;
  assert.equal(url, "/api/branches/merge", `landBranch must POST the route the host actually serves (POST /api/branches/merge, lib/routes/branches.mjs) — /api/branches/land does not exist, which is why every landing 'succeeded' against a 404`);
  assert.equal(options.method, "POST");
  assert.deepEqual(JSON.parse(options.body), { branch: BRANCH, baseBranch: "main" });
  assert.match(String(options.headers["Content-Type"]), /application\/json/);
});

test("keep-separate asks the host before it claims the host recorded anything (driven by the button)", async () => {
  // No MCP tool exists for keep-separate, so this drives the surface the person actually presses.
  const refused = loadInspector(async () => response(400, { ok: false, refused: "bad-request", why: "branch field is required" }));
  await refused.click("keep-separate-btn");
  assert.equal(refused.calls.length, 1, "the keep button must actually reach the host");
  assert.equal(refused.calls[0].url, "/api/branches/keep-separate");
  assert.match(refused.statusText(), /^Could not keep/, `a refused keep must be shown: ${refused.statusText()}`);
  assert.doesNotMatch(refused.statusText(), /Kept .* for later review/, `the screen claimed a record the host refused: ${refused.statusText()}`);

  const kept = loadInspector(async () => response(200, { ok: true, action: "kept-separate", branch: BRANCH }));
  await kept.click("keep-separate-btn");
  assert.match(kept.statusText(), /Kept .* for later review/, `a recorded keep must be shown: ${kept.statusText()}`);
});

test("the land BUTTON tells the same truth as the tool (the defect was what the screen said)", async () => {
  const loaded = loadInspector(async () => response(409, { ok: false, refused: "merge-failed", why: "Could not merge into main." }));
  await loaded.click("land-branch-btn");
  assert.equal(loaded.calls[0].url, "/api/branches/merge");
  assert.doesNotMatch(loaded.statusText(), /cleanly/i, `the button claimed a landing the host refused: ${loaded.statusText()}`);
  assert.match(loaded.statusText(), /Could not land/);
});

test("every route this module POSTs is a route the host actually serves", async () => {
  // THE ORIGINAL DEFECT, one level up: `landBranch` POSTed `/api/branches/land`, which no route answers, and
  // the discarded 404 became a success message. This reads the host's own route table rather than trusting a
  // copy of it, so a rename on either side fails here instead of on a person's branch.
  const served = new Set([...BRANCH_ROUTES.matchAll(/"(POST|GET) (\/api\/[^"]+)"/g)].map((m) => m[1] + " " + m[2]));
  assert.ok(served.has("POST /api/branches/merge"), `lib/routes/branches.mjs no longer serves POST /api/branches/merge; served: ${[...served].join(", ")}`);

  const loaded = loadInspector(async () => response(200, { ok: true, action: "landed", branch: BRANCH, baseBranch: "main" }));
  await landTool(loaded).execute({ branch: BRANCH });
  await loaded.click("keep-separate-btn");

  assert.equal(loaded.calls.length, 2, `both actions must actually reach the host, or this check proves nothing: ${JSON.stringify(loaded.calls.map((c) => c.url))}`);
  for (const call of loaded.calls) {
    assert.ok(
      served.has("POST " + call.url),
      `the inspector POSTs ${call.url}, which the host does not serve (served: ${[...served].filter((r) => r.startsWith("POST")).join(", ")}). A 404 here is what made every landing claim a success it never made.`,
    );
  }
});

test("an unknown branch is refused before any request is made", async () => {
  const loaded = loadInspector(async () => response(200, { ok: true }));
  const result = await landTool(loaded).execute({ branch: "feat/does-not-exist" });
  assert.equal(result.ok, false);
  assert.equal(result.refused, "branch-not-found");
  assert.equal(loaded.calls.length, 0, "nothing should be POSTed for a branch that is not in the list");
});
