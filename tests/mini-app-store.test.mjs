import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  deleteMiniApp,
  discoverMiniApps,
  getMiniApp,
  normalizeAppId,
  saveMiniApp,
  slugifyMiniApp,
} from "../lib/mini-app-store.mjs";

describe("mini-app-store: persistence, in-place updates, deletion & cross-sandbox discovery", () => {
  const tempDirs = [];

  function makeScratchDir(prefix = "vb-mini-app-store-") {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("slugifyMiniApp and normalizeAppId produce deterministic slugs and IDs", () => {
    assert.equal(slugifyMiniApp("Pomodoro Timer"), "pomodoro-timer");
    assert.equal(slugifyMiniApp("pomodoro_timer.html"), "pomodoro-timer");
    assert.equal(slugifyMiniApp("app_pomodoro_timer"), "pomodoro-timer");
    assert.equal(normalizeAppId("Pomodoro Timer"), "app_pomodoro-timer");
    assert.equal(normalizeAppId("pomodoro_timer.html"), "app_pomodoro-timer");
    assert.equal(normalizeAppId("sandbox:boxA:calc.html"), "sandbox:boxA:calc.html");
  });

  it("a fileName that climbs or carries a path is REFUSED, not silently rewritten (voicebox-beads-owit)", () => {
    const rootPath = makeScratchDir("vb-ws-refuse-");
    const hostDir = makeScratchDir("vb-host-refuse-");
    // The case the re-review drove live: basename turned this into 'escaped.html' + ok:true,
    // so a caller could not tell a rejected name from an accepted one.
    const escape = saveMiniApp({ title: "Escape", html: "<h1>x</h1>", fileName: "../escaped.html", rootPath, hostDir });
    assert.equal(escape.ok, false, "a climbing name must not pass");
    assert.equal(escape.refused, "outside-root", "refused by name, in the loop's own vocabulary");
    assert.equal(existsSync(path.join(rootPath, "escaped.html")), false, "nothing landed at the rewritten name");
    assert.equal(existsSync(path.join(hostDir, "mini-apps", "escaped.html")), false, "nor on the shelf");
    // A sub-path, an absolute path, and — review round 2 — the shapes the first cut's
    // empty-segment filter let through ('/app.html', trailing separators, './' forms): a
    // separator character ANYWHERE in the name is a placement decision, refused verbatim.
    for (const bad of ["sub/app.html", "/etc/app.html", "C:\\app.html", "/app.html", "/tmp", "/tmp/", "app.html/", "./app.html", ".", ".."]) {
      const r = saveMiniApp({ title: `Sub ${bad}`, html: "<h1>x</h1>", fileName: bad, rootPath, hostDir });
      assert.equal(r.ok, false, `'${bad}' must refuse`);
      assert.equal(r.refused, "outside-root", `'${bad}' refused by name`);
    }
    // Review round 2, the identity bypass: a climbing name must refuse EVEN WHEN its basename
    // matches an existing app (the first cut checked the name only after matching, so
    // '../escaped.html' updated the existing 'escaped.html' in place with ok:true).
    const seed = saveMiniApp({ title: "Seed Identity", html: "<h1>v1</h1>", fileName: "bypassed.html", rootPath, hostDir });
    assert.equal(seed.ok, true, "the seed must save");
    const climb = saveMiniApp({ title: "Climb Identity", html: "<h1>v2</h1>", fileName: "../bypassed.html", rootPath, hostDir });
    assert.equal(climb.ok, false, "a climbing name refuses even when the basename matches an existing app");
    assert.equal(climb.refused, "outside-root");
    const after = getMiniApp("bypassed.html", { rootPath, hostDir });
    assert.equal(after.ok, true, "the existing app is untouched");
    if (after.ok) assert.match(after.miniApp.html, /v1/, "its content was not overwritten by the refused save");
    // THE CONTROL, because a refusal set with no control proves nothing: an ordinary name still
    // saves, and an existing app's stored fileName still updates in place untouched by this rule.
    const control = saveMiniApp({ title: "Fine", html: "<h1>y</h1>", fileName: "fine-app.html", rootPath, hostDir });
    assert.equal(control.ok, true, `an ordinary name must still save (got ${JSON.stringify(control)})`);
    assert.equal(control.miniApp.fileName, "fine-app.html");
    assert.ok(existsSync(path.join(rootPath, "fine-app.html")), "the control landed on disk, not just in the result");
    // A name that needs the .html appended still gets it (the basename path did this too),
    // and the appended file lands on disk (review round 2 test nit):
    const bare = saveMiniApp({ title: "Bare", html: "<h1>z</h1>", fileName: "bare-name", rootPath, hostDir });
    assert.equal(bare.ok, true);
    assert.equal(bare.miniApp.fileName, "bare-name.html");
    assert.ok(existsSync(path.join(rootPath, "bare-name.html")), "the .html append landed on disk");
  });

  it("a save with NO USABLE workspace root still authorizes the shelf write — the CONDITION is the pin (voicebox-beads-6gyv)", () => {
    // The gap this closes was a CONDITIONAL SKIP, not a near-copy: when rootPath names a directory
    // that does not exist (a declared root that vanished between request and save), resolvedRoot is
    // null and the workspace branch — the only authorized branch — never ran, so the shelf copy was
    // written with no authorization at all. A dotfile fileName landed on the shelf, invisible to
    // discovery (dotfile-skipping scan), unaudited.
    const hostDir = makeScratchDir("vb-host-6gyv-");
    const vanishedRoot = path.join(makeScratchDir("vb-gone-"), "deleted"); // never created: no usable root

    // BEFORE (landed main) this answered ok:true and wrote <hostDir>/mini-apps/.hidden.html.
    const dot = saveMiniApp({ title: "Orphan", html: "<h1>x</h1>", fileName: ".hidden.html", rootPath: vanishedRoot, hostDir });
    assert.equal(dot.ok, false, "a dotfile fileName must refuse even when no usable workspace root exists");
    assert.equal(dot.refused, "dotfile-refused", "refused by name, the one vocabulary");
    assert.match(dot.why, /host shelf/, "the why names WHICH copy was refused — the shelf door, not the workspace door");
    assert.equal(existsSync(path.join(hostDir, "mini-apps", ".hidden.html")), false, "no unauthorized shelf orphan was written");
    assert.equal(existsSync(path.join(vanishedRoot, ".hidden.html")), false, "and nothing landed in the vanished root either");

    // THE CONDITION STILL SAVES WHAT IS LEGITIMATE: with no usable root, a clean name saves to the
    // shelf ONLY (source host) — the no-root path is a working path, not a refused one.
    const hostDir2 = makeScratchDir("vb-host-6gyv-ok-");
    const clean = saveMiniApp({ title: "Legit Shelf", html: "<h1>y</h1>", fileName: "legit.html", rootPath: path.join(hostDir2, "no-such-root"), hostDir: hostDir2 });
    assert.equal(clean.ok, true, `a clean name with no usable root still saves to the shelf (got ${JSON.stringify(clean)})`);
    assert.equal(clean.miniApp.source, "host", "shelf-only, honestly labelled");
    assert.ok(existsSync(path.join(hostDir2, "mini-apps", "legit.html")), "the shelf copy landed");
    assert.equal(clean.miniApp.fileName, "legit.html");

    // And with a USABLE root the same dotfile refusal names the WORKSPACE door (the two doors are
    // distinguishable, so a reader can tell which ask was refused).
    const rootPath = makeScratchDir("vb-ws-6gyv-");
    const hostDir3 = makeScratchDir("vb-host-6gyv-ws-");
    const ws = saveMiniApp({ title: "Ws Dot", html: "<h1>z</h1>", fileName: ".hidden.html", rootPath, hostDir: hostDir3 });
    assert.equal(ws.ok, false);
    assert.equal(ws.refused, "dotfile-refused");
    assert.match(ws.why, /workspace root/, "with a usable root, the refusal names the workspace door");
    assert.equal(existsSync(path.join(hostDir3, "mini-apps", ".hidden.html")), false, "and nothing was written anywhere");
  });

  it("saveMiniApp creates a mini-app once and updates the same appId and file in place without duplicating", () => {
    const rootPath = makeScratchDir("vb-ws-");
    const hostDir = makeScratchDir("vb-host-");
    const sandboxRootDir = makeScratchDir("vb-sb-empty-");

    // 1. Initial launch / save
    const first = saveMiniApp({
      title: "Score Counter",
      html: "<!doctype html><title>Score Counter</title><h1>v1</h1>",
      rootPath,
      hostDir,
    });
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.updated, false);
    assert.equal(first.miniApp.appId, "app_score-counter");
    assert.equal(first.miniApp.slug, "score-counter");
    assert.equal(first.miniApp.fileName, "score-counter.html");
    assert.equal(first.miniApp.source, "workspace");
    assert.ok(existsSync(path.join(rootPath, "score-counter.html")));
    assert.ok(existsSync(path.join(hostDir, "mini-apps", "score-counter.html")));
    assert.ok(existsSync(path.join(hostDir, "mini-apps", "score-counter.meta.json")));

    // 2. Subsequent update by title updates in place (same appId and file, no duplicate)
    const second = saveMiniApp({
      title: "Score Counter",
      html: "<!doctype html><title>Score Counter</title><h1>v2</h1>",
      rootPath,
      hostDir,
    });
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(second.updated, true);
    assert.equal(second.miniApp.appId, "app_score-counter");
    assert.equal(second.miniApp.fileName, "score-counter.html");
    assert.match(readFileSync(path.join(rootPath, "score-counter.html"), "utf8"), /<h1>v2<\/h1>/);
    assert.match(
      readFileSync(path.join(hostDir, "mini-apps", "score-counter.html"), "utf8"),
      /<h1>v2<\/h1>/,
    );

    // 3. Verify only 1 mini-app exists in discovery
    const listed = discoverMiniApps({ rootPath, hostDir, sandboxRootDir });
    assert.equal(listed.ok, true);
    assert.equal(listed.count, 1);
    assert.equal(listed.miniApps[0].appId, "app_score-counter");
    assert.match(listed.miniApps[0].html, /<h1>v2<\/h1>/);

    // 4. Empty HTML is refused cleanly
    const refused = saveMiniApp({ title: "Score Counter", html: "   ", rootPath, hostDir });
    assert.equal(refused.ok, false);
    assert.equal(refused.refused, "missing-html");
  });

  it("discoverMiniApps and getMiniApp find and load mini-apps across workspace, host shelf, and multiple sandboxes", () => {
    const rootPath = makeScratchDir("vb-ws-disc-");
    const hostDir = makeScratchDir("vb-host-disc-");
    const sandboxRootDir = makeScratchDir("vb-sandboxes-");

    // 1. Save a workspace app and a host-only app
    saveMiniApp({
      title: "Workspace Kanban",
      html: "<!doctype html><title>Workspace Kanban</title><div>board</div>",
      rootPath,
      hostDir,
    });
    saveMiniApp({
      title: "Host Notes",
      html: "<!doctype html><title>Host Notes</title><div>notes</div>",
      rootPath: null,
      hostDir,
    });

    // 2. Create two sandboxes inside sandboxRootDir with HTML apps
    const sandboxA = path.join(sandboxRootDir, "sandboxA");
    const sandboxB = path.join(sandboxRootDir, "sandboxB", "widgets");
    mkdirSync(sandboxA, { recursive: true });
    mkdirSync(sandboxB, { recursive: true });

    writeFileSync(
      path.join(sandboxA, "calc.html"),
      "<!doctype html><html><head><title>Sandbox Calculator</title></head><body><button>1+1=2</button></body></html>",
      "utf8",
    );
    writeFileSync(
      path.join(sandboxB, "flappy_bird.html"),
      "<!doctype html><html><body><canvas id='game'>flappy</canvas></body></html>",
      "utf8",
    );

    // 3. Discover across all three sources
    const discovered = discoverMiniApps({ rootPath, hostDir, sandboxRootDir });
    assert.equal(discovered.ok, true);
    assert.equal(discovered.count, 4);

    const byId = new Map(discovered.miniApps.map((app) => [app.appId, app]));
    assert.ok(byId.has("app_workspace-kanban"));
    assert.equal(byId.get("app_workspace-kanban").source, "workspace");

    assert.ok(byId.has("app_host-notes"));
    assert.equal(byId.get("app_host-notes").source, "host");

    assert.ok(byId.has("sandbox:sandboxA:calc.html"));
    assert.equal(byId.get("sandbox:sandboxA:calc.html").source, "sandbox");
    assert.equal(byId.get("sandbox:sandboxA:calc.html").sandbox, "sandboxA");
    assert.equal(byId.get("sandbox:sandboxA:calc.html").title, "Sandbox Calculator");

    assert.ok(byId.has("sandbox:sandboxB:widgets/flappy_bird.html"));
    assert.equal(byId.get("sandbox:sandboxB:widgets/flappy_bird.html").source, "sandbox");
    assert.equal(byId.get("sandbox:sandboxB:widgets/flappy_bird.html").sandbox, "sandboxB");
    assert.equal(byId.get("sandbox:sandboxB:widgets/flappy_bird.html").title, "Flappy Bird");

    // 4. getMiniApp resolves by sandbox appId, fileName, slug, or title
    const bySandboxId = getMiniApp("sandbox:sandboxA:calc.html", {
      rootPath,
      hostDir,
      sandboxRootDir,
    });
    assert.equal(bySandboxId.ok, true);
    assert.match(bySandboxId.miniApp.html, /1\+1=2/);

    const byFileName = getMiniApp("calc.html", {
      rootPath,
      hostDir,
      sandboxRootDir,
    });
    assert.equal(byFileName.ok, true);
    assert.equal(byFileName.miniApp.appId, "sandbox:sandboxA:calc.html");

    const byHumanTitle = getMiniApp("Flappy Bird", {
      rootPath,
      hostDir,
      sandboxRootDir,
    });
    assert.equal(byHumanTitle.ok, true);
    assert.equal(byHumanTitle.miniApp.appId, "sandbox:sandboxB:widgets/flappy_bird.html");
    assert.match(byHumanTitle.miniApp.html, /canvas id='game'/);
  });

  it("deleteMiniApp removes the mini-app from storage and discovery no longer lists it", () => {
    const rootPath = makeScratchDir("vb-ws-del-");
    const hostDir = makeScratchDir("vb-host-del-");
    const sandboxRootDir = makeScratchDir("vb-sb-del-");

    saveMiniApp({
      title: "Temp Widget",
      html: "<h1>temp</h1>",
      rootPath,
      hostDir,
    });
    assert.equal(discoverMiniApps({ rootPath, hostDir, sandboxRootDir }).count, 1);

    const delRes = deleteMiniApp("Temp Widget", { rootPath, hostDir, sandboxRootDir });
    assert.equal(delRes.ok, true);
    assert.equal(delRes.deleted, true);
    assert.equal(delRes.miniApp.appId, "app_temp-widget");

    assert.equal(existsSync(path.join(rootPath, "temp-widget.html")), false);
    assert.equal(existsSync(path.join(hostDir, "mini-apps", "temp-widget.html")), false);
    assert.equal(existsSync(path.join(hostDir, "mini-apps", "temp-widget.meta.json")), false);

    const after = discoverMiniApps({ rootPath, hostDir, sandboxRootDir });
    assert.equal(after.count, 0);

    const missing = deleteMiniApp("Temp Widget", { rootPath, hostDir, sandboxRootDir });
    assert.equal(missing.ok, false);
    assert.equal(missing.refused, "mini-app-not-found");
  });

  it("discovery starts clean with zero default apps, and deleting unregisters all shelf metadata without resurrecting defaults", () => {
    const rootPath = makeScratchDir("vb-ws-clean-");
    const hostDir = makeScratchDir("vb-host-clean-");
    const sandboxRootDir = makeScratchDir("vb-sb-clean-");

    // Fresh environment must not discover any built-in/default apps
    const initial = discoverMiniApps({ rootPath, hostDir, sandboxRootDir });
    assert.equal(initial.count, 0, "no default apps exist in fresh discovery");
    assert.deepEqual(initial.miniApps, []);

    // Save an app with custom title and file to test shelf metadata cleanup
    const saveRes = saveMiniApp({
      title: "Custom Tracker",
      fileName: "custom-tracker.html",
      html: "<h1>custom tracker</h1>",
      rootPath,
      hostDir,
    });
    assert.equal(saveRes.ok, true);

    const shelfDir = path.join(hostDir, "mini-apps");
    assert.ok(existsSync(path.join(shelfDir, "custom-tracker.html")));
    assert.ok(existsSync(path.join(shelfDir, "custom-tracker.meta.json")));

    // Delete by title
    const delRes = deleteMiniApp("Custom Tracker", { rootPath, hostDir, sandboxRootDir });
    assert.equal(delRes.ok, true);
    assert.equal(delRes.deleted, true);

    // Verify all shelf artifacts are cleanly wiped
    assert.equal(existsSync(path.join(shelfDir, "custom-tracker.html")), false);
    assert.equal(existsSync(path.join(shelfDir, "custom-tracker.meta.json")), false);
    assert.equal(existsSync(path.join(rootPath, "custom-tracker.html")), false);

    // Discovery after deletion must be completely empty, no resurrection of defaults
    const finalDiscovery = discoverMiniApps({ rootPath, hostDir, sandboxRootDir });
    assert.equal(finalDiscovery.count, 0, "zero apps discovered after deletion, no defaults resurrected");
    assert.deepEqual(finalDiscovery.miniApps, []);
  });

  it("deleting a mini-app does not destroy an unrelated app that shares a title slug", () => {
    const rootPath = makeScratchDir("vb-ws-iso-");
    const hostDir = makeScratchDir("vb-host-iso-");
    const sandboxRootDir = makeScratchDir("vb-sb-iso-");

    // App B is saved as counter.html with title "Counter"
    const appB = saveMiniApp({
      title: "Counter",
      fileName: "counter.html",
      html: "<h1>Counter Widget</h1>",
      rootPath,
      hostDir,
    });
    assert.equal(appB.ok, true);

    // App A is saved as report.html with <title>Counter</title> in HTML
    const appA = saveMiniApp({
      fileName: "report.html",
      html: "<!doctype html><html><head><title>Counter</title></head><body><h1>Report</h1></body></html>",
      rootPath,
      hostDir,
    });
    assert.equal(appA.ok, true);

    const shelfDir = path.join(hostDir, "mini-apps");
    assert.ok(existsSync(path.join(shelfDir, "counter.html")), "App B HTML on shelf");
    assert.ok(existsSync(path.join(shelfDir, "counter.meta.json")), "App B meta on shelf");
    assert.ok(existsSync(path.join(shelfDir, "report.html")), "App A HTML on shelf");
    assert.ok(existsSync(path.join(shelfDir, "report.meta.json")), "App A meta on shelf");

    // Deleting App A (by its specific file or ID) must NOT wipe App B's shelf artifacts
    const delRes = deleteMiniApp("report.html", { rootPath, hostDir, sandboxRootDir });
    assert.equal(delRes.ok, true);

    // App A artifacts are gone
    assert.equal(existsSync(path.join(shelfDir, "report.html")), false);
    assert.equal(existsSync(path.join(shelfDir, "report.meta.json")), false);
    assert.equal(existsSync(path.join(rootPath, "report.html")), false);

    // App B artifacts must survive untouched!
    assert.ok(existsSync(path.join(shelfDir, "counter.html")), "App B shelf HTML must survive");
    assert.ok(existsSync(path.join(shelfDir, "counter.meta.json")), "App B shelf meta must survive");
    assert.ok(existsSync(path.join(rootPath, "counter.html")), "App B workspace HTML must survive");

    const afterDiscovery = discoverMiniApps({ rootPath, hostDir, sandboxRootDir });
    assert.equal(afterDiscovery.count, 1, "App B still discovered after App A deletion");
    assert.equal(afterDiscovery.miniApps[0].fileName, "counter.html");
  });

  it("every discovered entry carries a kind: a bare workspace .html is a Page, a saved one is an App (voicebox-beads-rtsr)", () => {
    const rootPath = makeScratchDir("vb-ws-kind-");
    const hostDir = makeScratchDir("vb-host-kind-");
    const sandboxRootDir = makeScratchDir("vb-sb-kind-");

    // A .html file in the workspace that nobody saved: a page, not a mini-app.
    writeFileSync(
      path.join(rootPath, "meeting-notes.html"),
      "<!doctype html><html><head><title>Meeting Notes</title></head><body><p>raw</p></body></html>",
      "utf8",
    );
    // A file saved through the API: an app.
    const saved = saveMiniApp({
      title: "Kanban",
      html: "<!doctype html><html><head><title>Kanban</title></head><body><p>board</p></body></html>",
      rootPath,
      hostDir,
    });
    assert.equal(saved.ok, true);
    // A shelf-only app (saved with no workspace root).
    assert.equal(
      saveMiniApp({
        title: "Host Notes",
        html: "<!doctype html><html><head><title>Host Notes</title></head><body></body></html>",
        rootPath: null,
        hostDir,
      }).ok,
      true,
    );
    // A sandbox file — user-authored inside a fence, so it stays an app (voicebox-beads-rtsr).
    const sandboxA = path.join(sandboxRootDir, "boxA");
    mkdirSync(sandboxA, { recursive: true });
    writeFileSync(path.join(sandboxA, "calc.html"), "<!doctype html><html><head><title>Calc</title></head></html>", "utf8");

    const discovered = discoverMiniApps({ rootPath, hostDir, sandboxRootDir });
    const byFile = new Map(discovered.miniApps.map((app) => [app.fileName, app]));
    assert.equal(byFile.get("meeting-notes.html")?.kind, "page", "an unsaved workspace .html file is a page");
    assert.equal(byFile.get("meeting-notes.html")?.title, "Meeting Notes", "a page keeps its own title, not a shelf app's");
    assert.equal(byFile.get("kanban.html")?.kind, "app", "a saved workspace app is an app");
    assert.equal(byFile.get("host-notes.html")?.kind, "app", "a shelf app is an app");
    assert.equal(byFile.get("calc.html")?.kind, "app", "a sandbox file stays an app");

    // The shelf record names the workspace file it was saved from, which is what proves it later.
    const meta = JSON.parse(readFileSync(path.join(hostDir, "mini-apps", "kanban.meta.json"), "utf8"));
    assert.equal(meta.workspacePath, "kanban.html", "a workspace save records the file it came from");

    // A page is still resolvable — classification separates the LIST, it does not restrict launching.
    assert.equal(getMiniApp("Meeting Notes", { rootPath, hostDir, sandboxRootDir }).ok, true);
  });

  it("a workspace page that only shares a slug with a shelf app is a Page and keeps its own identity (voicebox-beads-rtsr)", () => {
    const rootPath = makeScratchDir("vb-ws-collide-");
    const hostDir = makeScratchDir("vb-host-collide-");
    const sandboxRootDir = makeScratchDir("vb-sb-collide-");
    const shelfDir = path.join(hostDir, "mini-apps");
    mkdirSync(shelfDir, { recursive: true });

    // 1. An OLDER record (written before this change, so no workspacePath) whose shelf copy IS the
    // workspace file byte for byte: proved by the bytes. This is the backward-compatibility branch.
    const legacyHtml = "<!doctype html><html><head><title>Legacy App</title></head><body><p>same</p></body></html>";
    writeFileSync(path.join(rootPath, "legacy-app.html"), legacyHtml, "utf8");
    writeFileSync(path.join(shelfDir, "legacy-app.html"), legacyHtml, "utf8");
    writeFileSync(
      path.join(shelfDir, "legacy-app.meta.json"),
      JSON.stringify({ appId: "app_legacy-app", slug: "legacy-app", title: "Legacy App", fileName: "legacy-app.html" }),
      "utf8",
    );

    // 2. An OLDER record whose shelf copy is a DIFFERENT file: the workspace page merely happens to
    // share the slug. It must not steal the app's identity, and the shelf app must still be listed.
    writeFileSync(
      path.join(rootPath, "collision.html"),
      "<!doctype html><html><head><title>Unrelated Page</title></head><body><p>page</p></body></html>",
      "utf8",
    );
    writeFileSync(
      path.join(shelfDir, "collision.html"),
      "<!doctype html><html><head><title>Collision App</title></head><body><p>app</p></body></html>",
      "utf8",
    );
    writeFileSync(
      path.join(shelfDir, "collision.meta.json"),
      JSON.stringify({ appId: "app_collision", slug: "collision", title: "Collision App", fileName: "collision.html" }),
      "utf8",
    );

    const discovered = discoverMiniApps({ rootPath, hostDir, sandboxRootDir });

    const legacy = discovered.miniApps.filter((app) => app.fileName === "legacy-app.html");
    assert.equal(legacy.length, 1, "the legacy app is listed once, not twice");
    assert.equal(legacy[0].kind, "app", "an identical shelf copy proves the legacy record");
    assert.equal(legacy[0].title, "Legacy App");

    const colliding = discovered.miniApps.filter((app) => app.fileName === "collision.html");
    assert.equal(colliding.length, 2, "the page and the shelf app are two entries, not one");
    const page = colliding.find((app) => app.kind === "page");
    const app = colliding.find((app) => app.kind === "app");
    assert.ok(page, "the workspace page is listed as a page");
    assert.ok(app, "the shelf file is still discovered as the app it is");
    assert.equal(page.title, "Unrelated Page", "the page keeps its own title");
    assert.equal(page.source, "workspace");
    assert.equal(app.title, "Collision App", "the app keeps the shelf title");
    assert.equal(app.source, "host");
  });
});
