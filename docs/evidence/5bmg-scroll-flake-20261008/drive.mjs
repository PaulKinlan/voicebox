// docs/evidence/5bmg-scroll-flake-20261008/drive.mjs
//
// CONTROLLED DIAGNOSIS for voicebox-beads-5bmg: `tests/settings-dialog.test.mjs:227` failed once inside
// a full gate and passes standalone. This driver reproduces the test's exact sequence and ONE variable
// is changed per run, so the failure mode can be named instead of assumed:
//
//   node drive.mjs baseline   the test as written, instrumented (expect PASS standalone)
//   node drive.mjs end        the same, but the scroller is parked at its END before the free wheel
//   node drive.mjs reset      the same as baseline, plus the proposed fix (reset + condition wait)
//   node drive.mjs end_fixed  the hostile precondition AND the proposed fix: park at the END, then run
//                             the fixed sequence (reset -> wheel -> wait for the condition). This is the
//                             before/after control for the fix: `end` fails it, `end_fixed` must pass it.
//   node drive.mjs latency    the wheel->scrollY commit latency, sampled 6 times (run this under load)
//   node drive.mjs budget     for T in {50,100,200,400,800,1600}ms: dispatch a wheel, sleep T exactly
//                             (no polling, so the measurement cannot inflate itself), read scrollY. This
//                             is the test's own bet: `page.wheel()` sleeps 200ms and then decides
//                             "the page cannot scroll".
//
// It drives the REAL browser through the same helper the suite uses (`tests/lib/cdp.mjs`), so the
// gestures and sleeps are the test's, not a reconstruction. Every measurement the assertion depends on
// is printed as one JSON line, including what is actually under the wheel's fixed point (x=200,y=300):
// `page.wheel()` dispatches at that viewport coordinate and then sleeps 200ms, so the assertion
// `afterFree > beforeFree` is a bet on three things the test never checks — that the page is not
// already at its end, that the point is not over a scroll container that swallows the wheel, and that
// the closed dialog is no longer intercepting it.
//
// Exit code is 0 iff the test's own assertion would hold, mirroring the test.
import { startServer } from "../../../tests/lib/server.mjs";
import { launch } from "../../../tests/lib/cdp.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const mode = process.argv[2] ?? "baseline";

// The wheel's fixed landing point, straight from tests/lib/cdp.mjs: `page.wheel(deltaY, {x=200, y=300})`.
const WHEEL_X = 200;
const WHEEL_Y = 300;

const server = await startServer({
  cwd: ROOT,
  env: { VOICEBOX_WORKSPACE: undefined, VOICEBOX_INSTANCE: "settings-scroll-diag" },
});
const page = await launch();
const result = { mode, wheel: { x: WHEEL_X, y: WHEEL_Y } };
try {
  // test.before, verbatim: a long page, so "the page does not scroll" is not a tautology.
  await page.goto(`${server.base}/`);
  await page.evaluate(() => {
    const filler = document.createElement("div");
    filler.style.height = "300vh";
    document.body.appendChild(filler);
  });
  await page.waitFor(() => window.__voiceboxHotkey !== undefined, { label: "the page to be interactive" });

  const probe = () =>
    page.evaluate(
      ([wx, wy]) => {
        const hit = document.elementFromPoint(wx, wy);
        const chain = [];
        for (let n = hit; n && chain.length < 4; n = n.parentElement) {
          const cs = getComputedStyle(n);
          chain.push({
            tag: n.tagName.toLowerCase(),
            id: n.id || null,
            cls: n.className && typeof n.className === "string" ? n.className.split(/\s+/)[0] : null,
            overflowY: cs.overflowY,
            overscrollBehaviorY: cs.overscrollBehaviorY,
            scrolls: n.scrollHeight > n.clientHeight + 1,
            scrollTop: n.scrollTop,
          });
        }
        const dialog = document.getElementById("settings");
        const rect = dialog.getBoundingClientRect();
        const dcs = getComputedStyle(dialog);
        return {
          scrollY: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          innerHeight: window.innerHeight,
          maxScroll: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
          htmlOverflowY: getComputedStyle(document.documentElement).overflowY,
          hitPointInDialog: hit ? dialog.contains(hit) || hit === dialog : false,
          hitChain: chain,
          dialog: {
            open: dialog.open,
            modal: dialog.matches(":modal"),
            display: dcs.display,
            visibility: dcs.visibility,
            pointerEvents: dcs.pointerEvents,
            rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) },
            pointInsideRect: wx >= rect.left && wx <= rect.right && wy >= rect.top && wy <= rect.bottom,
          },
        };
      },
      [WHEEL_X, WHEEL_Y],
    );

  // openSettings(), verbatim.
  await page.click("#settings-open");
  await page.waitFor(() => document.getElementById("settings").open, { label: "the settings dialog to open" });
  result.atOpen = await probe();

  // The locked half, verbatim.
  const beforeWheel = await page.evaluate(() => window.scrollY);
  await page.wheel(600);
  const afterWheel = await page.evaluate(() => window.scrollY);
  result.lockedWheel = { beforeWheel, afterWheel, moved: afterWheel - beforeWheel, held: afterWheel === beforeWheel };

  // Close, verbatim.
  await page.press("Escape");
  await page.waitFor(() => document.getElementById("settings").open === false, { label: "the dialog to close" });
  result.atClose = await probe();

  // THE ONE VARIABLE under test: where the scroller sits before the free wheel.
  if (mode === "end" || mode === "end_fixed") await page.evaluate(() => window.scrollTo(0, 1e6));
  if (mode === "reset" || mode === "end_fixed") await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(60);
  result.atFree = await probe();

  const beforeFree = await page.evaluate(() => window.scrollY);
  await page.wheel(400);
  let afterFree = await page.evaluate(() => window.scrollY);
  result.sampledImmediately = afterFree;
  if (mode === "end_fixed") {
    // The proposed fix's second half: assert the CONDITION with a deadline instead of one sample.
    const t0 = Date.now();
    for (let i = 0; i < 200 && afterFree <= beforeFree; i++) {
      await sleep(10);
      afterFree = await page.evaluate(() => window.scrollY);
    }
    result.waitedMs = Date.now() - t0;
  }
  result.freeWheel = { beforeFree, afterFree, moved: afterFree - beforeFree };
  result.assertionHolds = afterFree > beforeFree;

  // THE MECHANISM, measured rather than assumed: `page.wheel()` dispatches the gesture at (200,300),
  // then sleeps 200ms, and the test reads scrollY and treats "no increase yet" as "the page cannot
  // scroll". `Input.dispatchMouseEvent` resolves when the event is DELIVERED, not when the compositor
  // has committed the scroll, so the 200ms sleep is a bet. This times the bet: dispatch a wheel and
  // sample scrollY every ~5ms until it moves, six times. If the commit sometimes lands at or past
  // 200ms, the assertion is a race and the fix is to wait for the condition, not a longer sleep.
  result.wheelCommitLatencyMs = [];
  if (mode === "latency" || mode === "baseline" || mode === "reset") {    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const before = await page.evaluate(() => window.scrollY);
      const t0 = Date.now();
      await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: WHEEL_X, y: WHEEL_Y, deltaX: 0, deltaY: 400, pointerType: "mouse" });
      let landed = null;
      for (let s = 0; s < 200; s++) {
        if ((await page.evaluate(() => window.scrollY)) > before) {
          landed = Date.now() - t0;
          break;
        }
        await sleep(5);
      }
      result.wheelCommitLatencyMs.push(landed ?? ">1000 (no commit observed)");
    }
  }

  // THE TEST'S OWN BET, measured without self-interference: dispatch one wheel, sleep EXACTLY T, then
  // read scrollY once. No polling loop, so the number is the environment's, not this driver's.
  if (mode === "budget") {
    result.budget = {};
    for (const T of [50, 100, 200, 400, 800, 1600]) {
      const trials = [];
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollTo(0, 0));
        const before = await page.evaluate(() => window.scrollY);
        await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: WHEEL_X, y: WHEEL_Y, deltaX: 0, deltaY: 400, pointerType: "mouse" });
        await sleep(T);
        const after = await page.evaluate(() => window.scrollY);
        trials.push(after > before ? "committed" : "NOT committed");
      }
      result.budget[`${T}ms`] = trials;
    }
  }

  // What the fix would wait for, measured separately from the wheel: does the document accept a
  // programmatic scroll at all right now (i.e. is it the lock, or the gesture, or the point)?
  result.documentScrollable = await page.evaluate(() => {
    const before = window.scrollY;
    window.scrollBy(0, 50);
    const after = window.scrollY;
    window.scrollTo(0, before);
    return { before, after, moved: after - before };
  });
} finally {
  await page.close().catch(() => {});
  await server.stop().catch(() => {});
}
console.log(JSON.stringify(result));
process.exit(result.assertionHolds ? 0 : 1);
