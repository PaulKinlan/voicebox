// tests/lib/cdp.mjs — a browser driver in ~120 lines, on the platform's own primitives.
//
// WHY NOT A FRAMEWORK: the runtime here is zero-dependency by policy, and the acceptance checks
// need exactly four things — launch a browser, open a page, run a script in it, click a real
// control. Node has `WebSocket` and `fetch` built in and Chromium speaks CDP over both, so the
// whole driver is one file with no install step. (Playwright would be a dependency the product
// then depends on being installable, for a test suite that runs on one machine.)
//
// The checks drive REAL input: `click()` dispatches an actual mouse event at the element's
// centre, and `type()` inserts text the way a keyboard does. A test that sets `.value` from
// script would pass through a page whose controls are not wired to anything at all.
//
// WAITS ARE EVENTS WHERE THE BROWSER CAN REPORT THEM (voicebox-beads-9mqc, 2026-09-28). 61 launch
// sites across 43 browser test files run one file at a time in the live lane, so every fixed
// millisecond in this file is paid in series. Where a sleep stood for something the browser can
// REPORT, the driver now waits for that report: the endpoint line on stderr, the frames that carry a
// viewport change into the page, and — before any settle — the navigated document's own `load`
// (named by its loaderId, so a previous document's cannot count). Each wait is bounded, and no bound
// throws where the old code carried on; a miss is named on stderr instead. The sleeps that stand for
// "the page has finished reacting" stay — after input, and after goto/reload — because only a caller
// can state that condition, and a full browser run showed callers leaning on them (see `goto`).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { findBrowserBinary } from "../../lib/browser-binaries.mjs";

/**
 * The browser binary this box can actually launch, or null. THE ONE DISCOVERY SITE for the test
 * side (`launch` asks here), so a case that needs a REAL browser can say so by name instead of
 * dying inside a spawn with a message about the network (voicebox-beads-80vw: the acceptance case
 * failed standalone as 'uncaught: spawn /usr/bin/chromium ENOENT' — which reads as a network
 * verdict, not as a missing precondition).
 */
export { findBrowserBinary }; // re-exported for the driver's callers — the list itself lives in the one owner (voicebox-beads-phs9)

const activeBrowserPids = new Set();

/**
 * Register a browser this module did not launch - a test body that spawns its own - so the exit and signal
 * reapers above tear it down too (voicebox-beads-selv). Returns the function that unregisters it.
 */
export function trackBrowserProcessGroup(pid) {
  if (!pid) return () => {};
  activeBrowserPids.add(pid);
  return () => activeBrowserPids.delete(pid);
}

function killBrowserProcessGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

// Ensure browser process groups are reaped synchronously if the Node runner exits unexpectedly (voicebox-beads-uv1q)
process.on("exit", () => {
  for (const pid of activeBrowserPids) {
    killBrowserProcessGroup(pid);
  }
});

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.once(sig, () => {
    for (const pid of activeBrowserPids) {
      killBrowserProcessGroup(pid);
    }
    const sigNum = os.constants.signals[sig] ?? 0;
    process.exit(128 + sigNum);
  });
}

export async function launch({ width = 1000, height = 800, profile = null, fakeMedia = false, fakeAudioFile = null } = {}) {
  const binary = findBrowserBinary();
  if (!binary) throw new Error("no Chromium/Chrome binary found; set VOICEBOX_CHROME");

  // A caller may hand in a prepared profile — the only way to give the page a REAL platform
  // answer (a blocked permission) rather than a constructed one.
  const ownProfile = !profile;
  profile = profile ?? mkdtempSync(path.join(os.tmpdir(), "voicebox-cdp-"));
  const child = spawn(
    binary,
    [
      "--headless=new",
      // --no-zygote prevents Chrome from creating an internal zygote PID namespace, where PID 1
      // drops signal handlers and can become an unkillable zombie if parent aborts abruptly.
      // Note: On Linux, --no-sandbox is a required companion flag for --no-zygote to start up.
      "--no-sandbox",
      "--no-zygote",
      "--disable-crash-reporter",
      ...(fakeMedia ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] : []),
      // A wav file the fake microphone PLAYS (voicebox-beads-ldxa): the only way to give the page real,
      // deterministic mic input — a quiet passage and then a spoken one — so a detector can be driven
      // through the REAL capture worklet instead of a synthetic frame.
      ...(fakeAudioFile
        ? [`--use-file-for-fake-audio-capture=${fakeAudioFile}`, "--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox"]
        : []),
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      `--window-size=${width},${height}`,
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  activeBrowserPids.add(child.pid);
  child.on("exit", () => {
    activeBrowserPids.delete(child.pid);
  });
  // Node loads its WebSocket lazily, on first touch (~10ms, measured): touching it here overlaps
  // that with the browser's own start-up instead of adding it after the endpoint is known.
  void globalThis.WebSocket;
  // A browser that dies, never answers, or refuses the socket is killed and its scratch profile
  // removed — not left running behind the error (voicebox-beads-9mqc).
  const abandon = () => {
    activeBrowserPids.delete(child.pid);
    killBrowserProcessGroup(child.pid);
    try {
      if (ownProfile) rmSync(profile, { recursive: true, force: true });
    } catch {}
  };

  // THE ENDPOINT IS AN EVENT (voicebox-beads-9mqc): this settles on the stderr chunk that completes
  // Chromium's "DevTools listening on ws://…" line — nothing polls between the browser printing it
  // and the driver acting on it. The match wants the whitespace AFTER the id, because a pipe read can
  // end mid-line and a truncated id connects to a 404. (The ~120ms that follows, before the socket
  // opens, is the browser finishing its own start-up: measured, a raw TCP connect is accepted at once
  // and /json/version answers only when the socket would.)
  const wsUrl = await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error) return resolve(url);
      abandon();
      reject(error);
    };
    const timer = setTimeout(() => settle(new Error("chromium did not print a DevTools endpoint")), 20000);
    let buffer = "";
    const scan = (chunk) => {
      if (settled) return; // keep draining the pipes; stop accumulating them
      buffer += String(chunk);
      const match = buffer.match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+(?=\s)/);
      if (match) settle(null, match[0]);
    };
    child.stderr.on("data", scan);
    child.stdout.on("data", scan);
    child.on("exit", (code) => settle(new Error(`chromium exited early (${code})`)));
  });

  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const events = [];
  // Waits that must not poll register a watcher here and see every protocol event as it arrives;
  // a watcher removes itself when it is satisfied or its bound expires (voicebox-beads-9mqc).
  const watchers = new Set();

  await new Promise((resolve, reject) => {
    // Only a socket that never OPENS is abandoned: once it is open the listener goes, so a later
    // error does what it always did here — nothing — and the browser stays the caller's to close.
    const failed = () => {
      abandon();
      reject(new Error("devtools websocket failed"));
    };
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener(
      "open",
      () => {
        socket.removeEventListener("error", failed);
        resolve();
      },
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data));
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(`${data.error.message} (${JSON.stringify(data.error.data ?? "")})`));
      else resolve(data.result);
    } else if (data.method) {
      events.push(data);
      for (const watch of watchers) watch(data);
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  // Sent together: the session runs them in order either way, so three round trips bought nothing.
  // Lifecycle events carry the loaderId that ties a `load` to ONE document — what goto() and
  // reload() wait on (voicebox-beads-9mqc).
  await Promise.all([
    send("Page.enable", {}, sessionId),
    send("Runtime.enable", {}, sessionId),
    send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId),
  ]);

  const page = {
    sessionId,
    pid: child.pid,
    send: (method, params) => send(method, params, sessionId),
    // Read-only protocol evidence: observe real frames without patching the page's WebSocket.
    events: (method) => events.filter((event) => event.sessionId === sessionId && event.method === method).map((event) => event.params),
    async close() {
      try {
        socket.close();
      } catch {}
      activeBrowserPids.delete(child.pid);
      killBrowserProcessGroup(child.pid);
      try {
        if (ownProfile) rmSync(profile, { recursive: true, force: true });
      } catch {}
    },
  };

  /**
   * Resolve when ONE document's own `load` fires (voicebox-beads-9mqc). A document is named by its
   * loaderId: `Page.navigate` returns the new one and every lifecycle event carries one, so a `load`
   * from the document being navigated AWAY from — still finishing when the command went out — cannot
   * satisfy the wait. (The poll this replaces accepted ANY `Page.loadEventFired` after the call,
   * that one included, then slept a fixed 150ms on top.) `isOurs` picks the main-frame commit that
   * starts the wait; if the page navigates again by itself before loading (a redirect in script),
   * the wait follows the newest committed document, as a person watching would. Events are read
   * from `from`, an index taken BEFORE the command was sent, so nothing that arrived ahead of the
   * command's own reply can be missed.
   *
   * Bounded, and the bound does not throw: it resolves `false`, exactly as the poll it replaces did
   * (`resolve(false)` after 20s, then carry on). A page whose `load` never fires — a subresource that
   * never finishes — was carried past silently before, and a throw here would fail callers that pass
   * today; the caller now names the miss on stderr instead of sitting through it in silence.
   */
  const documentLoad = (frameId, isOurs, from, timeout) =>
    new Promise((resolve) => {
      let current = null; // the committed document the wait is for, once one has committed
      const sees = (event) => {
        if (event.sessionId !== sessionId) return false;
        if (event.method === "Page.frameNavigated" && event.params.frame.id === frameId) {
          if (current !== null || isOurs(event.params.frame.loaderId)) current = event.params.frame.loaderId;
          return false;
        }
        return (
          event.method === "Page.lifecycleEvent" &&
          event.params.name === "load" &&
          event.params.frameId === frameId &&
          current !== null &&
          event.params.loaderId === current
        );
      };
      for (let i = from; i < events.length; i++) if (sees(events[i])) return resolve(true);
      const finish = () => {
        clearTimeout(timer);
        watchers.delete(watch);
      };
      const watch = (event) => {
        if (!sees(event)) return;
        finish();
        resolve(true);
      };
      const timer = setTimeout(() => {
        finish();
        resolve(false);
      }, timeout);
      watchers.add(watch);
    });

  /**
   * THE SETTLE AFTER `load` STAYS (voicebox-beads-9mqc — measured, not assumed). `load` does not wait
   * for what a page does next: the room restores its folders from IndexedDB, fetches its root state
   * and re-renders its headline, and callers read that state straight after goto without waiting for
   * it. With the 150ms removed, a full browser run failed three tests on exactly that (room-page-
   * owned-root read the headline before its fetch landed; room-folders' clean slate raced the folder
   * restore; settings-dialog's phone check clicked a control that had not settled) — the same "the
   * page has finished reacting" the sleeps after input stand for, which only a caller can name. So
   * the wait is now for the right document's `load`, and the settle is measured from THAT; the old
   * poll could start it from the previous document's.
   */
  const SETTLE_AFTER_LOAD_MS = 150;

  page.goto = async (url, { timeout = 20000 } = {}) => {
    const from = events.length; // before the command: the reply may trail the events it caused
    const nav = await page.send("Page.navigate", { url });
    // Nothing to wait for in two cases, both of which the poll sat out for its full 20s: no loaderId
    // is a same-document navigation (a #fragment), which fires no load; net::ERR_ABORTED committed
    // nothing (a 204, a download, a navigation cancelled by another), so the old document is still
    // the page. Every other failure commits an error page under the SAME loaderId and fires its
    // load, so it is waited for like any document — as before, a failed navigation is not a throw.
    if (nav.loaderId && nav.errorText !== "net::ERR_ABORTED") {
      const loaded = await documentLoad(nav.frameId, (loaderId) => loaderId === nav.loaderId, from, timeout);
      if (!loaded) console.warn(`cdp: goto ${url}: the page's load event did not fire within ${timeout}ms — carrying on, as goto always has`);
    }
    await sleep(SETTLE_AFTER_LOAD_MS);
  };

  /**
   * A device viewport: width, height, DPR-downscaled touch device. Used for the mobile half of a UI
   * check, because "it pushes the page on a phone" is not a claim a desktop window can falsify.
   */
  let touchActive = false;
  // The window's own metrics, read before an override replaces them, so clearViewport can tell
  // when they are back (voicebox-beads-9mqc).
  let natural = null;
  let overridden = false;

  /**
   * WHAT THE FIXED SLEEPS AFTER AN OVERRIDE STOOD FOR (voicebox-beads-9mqc; emulateViewport slept
   * 150ms, clearViewport 100ms). Measured on Chrome 154: the override is visible to the page the
   * moment its command resolves (innerWidth, devicePixelRatio, matchMedia — 0 stale reads in 40),
   * but the page's own REACTIONS to it — `resize` events, media-query `change` listeners,
   * ResizeObserver callbacks — run at its next rendering opportunity (0 resize events on the
   * immediate read, 1 after two frames). So the wait is for exactly that, inside the page: the
   * metrics to read as the override says (bounded at 1s, for a browser that applies it later),
   * then two animation frames. Each frame is bounded at 75ms, so a page that is not producing
   * frames costs what the old sleep did rather than hanging. WHICH metrics, measured per shape: a
   * MOBILE override sets the screen, while innerWidth follows the page's viewport meta (a page
   * without one — about:blank — lays out 980px whatever the device); a DESKTOP override leaves the
   * screen alone and sets innerWidth/innerHeight exactly. Best-effort by design: the override itself
   * has already succeeded, and the sleep it replaces could not fail either. A page that cannot be
   * asked at all (its document is mid-navigation) gets the old fixed sleep instead, `fallbackMs`,
   * so no caller is ever given less settling than it had before.
   */
  const viewportApplied = (want, fallbackMs) =>
    page
      .evaluate(async (want) => {
        const frame = () =>
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 75);
            requestAnimationFrame(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        const applied = () =>
          !want ||
          (devicePixelRatio === want.scale &&
            (!want.screen || (screen.width === want.screen[0] && screen.height === want.screen[1])) &&
            (!want.inner || (innerWidth === want.inner[0] && innerHeight === want.inner[1])));
        const until = performance.now() + 1000;
        while (!applied() && performance.now() < until) await frame();
        await frame();
        await frame();
        return applied();
      }, want)
      .catch(() => sleep(fallbackMs).then(() => false));

  page.emulateViewport = async ({ width, height, mobile = true, scale = 2 }) => {
    if (!overridden) {
      natural = await page
        .evaluate(() => ({ scale: devicePixelRatio, screen: [screen.width, screen.height], inner: [innerWidth, innerHeight] }))
        .catch(() => null);
    }
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: scale,
      mobile,
    });
    overridden = true;
    if (mobile) {
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      touchActive = true;
    }
    await viewportApplied(mobile ? { scale, screen: [width, height] } : { scale, inner: [width, height] }, 150);
  };

  page.clearViewport = async () => {
    await page.send("Emulation.clearDeviceMetricsOverride");
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    touchActive = false;
    overridden = false;
    await viewportApplied(natural, 100);
  };

  page.screenshot = async (filePath, { fullPage = false } = {}) => {
    const params = { format: "png", captureBeyondViewport: fullPage };
    if (fullPage) {
      const metrics = await page.send("Page.getLayoutMetrics");
      const size = metrics.cssContentSize;
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    const { data } = await page.send("Page.captureScreenshot", params);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, Buffer.from(data, "base64"));
    if (fullPage) await page.send("Emulation.clearDeviceMetricsOverride");
    return filePath;
  };

  /**
   * Reload and wait for the NEW document's own `load` (voicebox-beads-9mqc). This slept a fixed
   * 600ms and never looked: under load the old document could still be the page when it returned,
   * and a following `waitFor(() => window.e1m0 !== undefined)` was then satisfied by the document
   * being replaced. The replaced document is named by its loaderId, read before the command goes
   * out; only a main-frame commit with a DIFFERENT loaderId can start the wait, so its late `load`
   * cannot be mistaken for the new one's. Like goto, a bound that expires carries on (reload never
   * threw for a slow page, and does not start now) and says so.
   *
   * THE 600ms STAYS, AS A FLOOR (measured): opfs-persistence reads the room's restored folders right
   * after its second reload, waiting only for an element the HTML already has, and failed as soon as
   * reload returned at `load`. So reload returns no sooner than it did — 600ms after the command's
   * reply — and no sooner than the new document's `load` plus goto's settle. The event can only move
   * the return LATER, in the slow case where the fixed sleep handed back the old document.
   */
  page.reload = async ({ timeout = 20000 } = {}) => {
    const { frameTree } = await page.send("Page.getFrameTree");
    const replaced = frameTree.frame.loaderId;
    const from = events.length; // after the snapshot, before the command
    await page.send("Page.reload", { ignoreCache: false });
    const replied = Date.now();
    const loaded = await documentLoad(frameTree.frame.id, (loaderId) => loaderId !== replaced, from, timeout);
    if (!loaded) console.warn(`cdp: reload: the new document's load event did not fire within ${timeout}ms — carrying on`);
    await sleep(Math.max(SETTLE_AFTER_LOAD_MS, 600 - (Date.now() - replied)));
  };

  /** Run a function in the page and return its value. Throws the page's own error if it throws. */
  page.evaluate = (fn, ...args) => page.evaluateWith(fn, args, false);

  /**
   * The same, but as a REAL user gesture (`userGesture: true`), which is what the platform
   * requires before a page may ask for a picked directory's permission. Using this where a
   * gesture is not required would hide the very bug the checks are looking for, so it is opt-in.
   */
  page.evaluateWithGesture = (fn, ...args) => page.evaluateWith(fn, args, true);

  page.evaluateWith = async (fn, args, userGesture) => {
    const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`;
    const result = await page.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result.value;
  };

  /**
   * The centre of an element, AFTER scrolling it into view.
   *
   * The scroll matters: a real mouse event is dispatched at viewport coordinates, and an element
   * below the fold gets a click at coordinates where it is not — the page simply does nothing, and
   * the failure looks like a broken handler rather than a misplaced pointer. (Found exactly that
   * way: adding one panel to the page pushed the form out of the viewport.)
   */
  const rect = (selector) =>
    page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      node.scrollIntoView({ block: "center", inline: "center" });
      // An inline element split across line fragments reports a UNION box, and the union's
      // centre can fall on blank text outside any fragment — a real click there hits the
      // PARENT (measured: the build-stamp "change log" anchor wrapped "change"/"log" at a
      // 1000x800 window; the click hit P#build and the dialog never opened). Click a
      // fragment whose centre actually contains the element; fall back to the union box.
      const boxes = node.getClientRects().length ? [...node.getClientRects()] : [node.getBoundingClientRect()];
      for (const fragment of boxes) {
        const fx = fragment.x + fragment.width / 2;
        const fy = fragment.y + fragment.height / 2;
        const hit = document.elementFromPoint(fx, fy);
        if (hit && (hit === node || node.contains(hit))) return { x: fx, y: fy };
      }
      const box = node.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }, selector);

  /** A real mouse click at the element's centre. */
  // THE SLEEPS AFTER INPUT STAY — here and in type/press/wheel/clickAt/dropFolder (voicebox-beads-9mqc).
  // `Input.dispatch*` resolves after the page's handlers have RUN, so there is no delivery left to
  // wait for; what the 80-400ms after a gesture stands for is "the page has finished reacting" (a
  // fetch, a re-render, a dialog), and only the caller can name that condition — `waitFor` it.
  // Shortening them here would silently shorten every caller that leans on them today.
  page.click = async (selector) => {
    const at = await rect(selector);
    if (!at) throw new Error(`no element matches ${selector}`);
    const x = Math.round(at.x);
    const y = Math.round(at.y);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(120);
  };

  /**
   * Real keyboard input: focus the field by clicking it, select what is there, then insert text.
   * The select-all matters — a field with a default value would otherwise silently concatenate,
   * and a test that types "check1.svg" into "atlas.svg" and then looks for "check1.svg" fails for
   * a reason that has nothing to do with the code under test.
   */
  page.type = async (selector, text) => {
    await page.click(selector);
    const selectMod = process.platform === "darwin" ? 4 : 2;
    for (const type of ["keyDown", "keyUp"]) {
      await page.send("Input.dispatchKeyEvent", {
        type,
        modifiers: selectMod,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        ...(type === "keyDown" ? { commands: ["selectAll"] } : {}),
      });
    }
    await page.send("Input.insertText", { text });
    await sleep(80);
  };

  /** A real key press — for Esc-to-cancel and Tab-order checks, which cannot be faked from script. */
  const KEYS = {
    Escape: { keyCode: 27, code: "Escape", key: "Escape" },
    Tab: { keyCode: 9, code: "Tab", key: "Tab" },
    Enter: { keyCode: 13, code: "Enter", key: "Enter" },
  };
  page.press = async (key, { modifiers = 0 } = {}) => {
    const spec = KEYS[key] ?? { keyCode: 0, code: key, key };
    for (const type of ["keyDown", "keyUp"]) {
      await page.send("Input.dispatchKeyEvent", { type, modifiers, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode });
    }
    await sleep(120);
  };

  /** A real wheel gesture — the only way to test that the page behind a modal does not scroll for a
   *  USER (programmatic window.scrollBy still moves an overflow:hidden root, by design). */
  page.wheel = async (deltaY, { x = 200, y = 300, deltaX = 0 } = {}) => {
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY, pointerType: "mouse" });
    await sleep(200);
  };

  /** A real click at viewport coordinates — how a check clicks the BACKDROP rather than an element. */
  page.clickAt = async (x, y) => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    await sleep(200);
  };

  /**
   * Drop a real folder on the page. This is a genuine platform path to a directory handle
   * (`DataTransferItem.getAsFileSystemHandle`), and it is how these checks get a handle to a REAL
   * folder without a native picker dialog — which cannot be driven from a script at all.
   */
  page.dropFolder = async (selector, folderPath) => {
    const at = await rect(selector);
    if (!at) throw new Error(`no element matches ${selector}`);
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await page.send("Input.dispatchDragEvent", {
        type,
        x: Math.round(at.x),
        y: Math.round(at.y),
        data: { items: [], files: [folderPath], dragOperationsMask: 1 },
      });
    }
    await sleep(400);
  };

  /**
   * Poll the page until `fn` returns something truthy.
   *
   * `args` exists because the function is stringified and run in the page: a closure over the
   * test's own variables is not there when it arrives, and the failure it produces is a timeout
   * with no error in it — the worst kind of test bug.
   *
   * Every 20ms for the first second, then every 120ms as before (voicebox-beads-9mqc). A condition
   * that turns true just after a check pays the whole interval, and 186 wait sites across a serial
   * lane pay it in series; most conditions turn true within a second, where 20ms is a local round
   * trip or two. A wait still going after a second is waiting on something slow — a server, a
   * worker, a model — and there the old rate keeps the predicate's own cost where it was, because
   * not every predicate is free: confirm-gate's asks the worker to reopen a project, which appends
   * to the audit on every call. Still a poll by round trip rather than an in-page loop, so a wait
   * that spans a navigation keeps asking whichever document is current.
   */
  page.waitFor = async (fn, { timeout = 15000, label = "condition", args = [] } = {}) => {
    const started = Date.now();
    const deadline = started + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await page.evaluate(fn, ...args);
      if (last) return last;
      await sleep(Date.now() - started < 1000 ? 20 : 120);
    }
    throw new Error(`timed out waiting for ${label}; last value ${JSON.stringify(last)}`);
  };

  return page;
}
