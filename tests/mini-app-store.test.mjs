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
});
