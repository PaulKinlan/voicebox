// tests/project-switch-outline.test.mjs — voicebox-beads-6omi: a project / folder / server-route switch is
// announced by a SUBTLE OUTLINE that settles, and by nothing that moves.
//
// THE DEFECT this pins (measured on the served page before the fix, 1100x1250): the switch ran
// `project-switch-flash` on the whole stage — a 650ms box-shadow ring that spread 0 → 8px with a 28px glow
// at the halfway point — and applied `border-radius: 20px` ONLY while flashing. The ring framed the entire
// stage as a ~1000x1100 rounded rectangle that grew and shrank once per switch, the corners popped in and
// out with the radius, and `.where` wore the same keyframe so the chip's own quiet `0 1px 3px` shadow was
// replaced by the ring and then vanished. Paul's report: "horrible jumping animation".
//
// WHAT THE INSTRUMENT MEASURES, and why it is shaped this way: frame by frame, NOTHING ever moved (no rect,
// width, height, padding or margin changed in any sample) — so a test that only asserted "no geometry moved"
// would have been GREEN on the defect. The witness therefore binds both halves:
//   · the cue IS there (a non-transparent accent outline appears during the animation) — so deleting the cue
//     fails the test rather than passing it by silence;
//   · the cue moves NOTHING and pops NOTHING: the stage's box, radius and shadow are invariant in every
//     sample, and the chip keeps its resting shadow.
//
//   node --test tests/project-switch-outline.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
test.before(async () => { server = await startServer({ env: { VOICEBOX_INSTANCE: "project-switch-outline" } }); });
test.after(async () => { await server?.stop?.(); });

test("a switch is announced by a fading outline, and the stage's box, radius and shadow never move (voicebox-beads-6omi)", { timeout: 60000 }, async () => {
  const page = await launch({ width: 1100, height: 1000 });
  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => window.__voiceboxFlashProjectChange !== undefined, { label: "the room's switch cue" });

    // ── PHASE A: the production cue with the content held CONSTANT — the geometry question, isolated ──
    const phaseA = await page.evaluate(async () => {
      const node = (sel) => (sel === "made-list" ? document.getElementById("made-list") : document.querySelector(sel));
      const targets = [".stage", ".where", ".room", "made-list"];
      const snap = () => targets.map((sel) => {
        const el = node(sel);
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          sel,
          w: Number(r.width.toFixed(2)), h: Number(r.height.toFixed(2)),
          x: Number(r.x.toFixed(2)), y: Number(r.y.toFixed(2)),
          radius: s.borderTopLeftRadius,
          shadow: s.boxShadow === "none" ? "none" : s.boxShadow,
          outlineStyle: s.outlineStyle, outlineColor: s.outlineColor,
          animation: s.animationName,
        };
      });
      const tick = () => new Promise((r) => requestAnimationFrame(() => r()));
      const samples = [{ at: "before", rows: snap() }];
      window.__voiceboxFlashProjectChange("probe"); // fused.js:374 — the function every switch path calls
      for (let i = 0; i < 45; i++) { await tick(); samples.push({ at: `f${i}`, rows: snap() }); }
      await new Promise((r) => setTimeout(r, 200));
      samples.push({ at: "after", rows: snap() });
      return { samples };
    });

    const first = phaseA.samples[0].rows;
    const stageIdx = first.findIndex((r) => r.sel === ".stage");
    const geometry = ["w", "h", "x", "y"];
    const drifts = [];
    for (const sample of phaseA.samples) {
      sample.rows.forEach((row, i) => {
        for (const key of geometry) {
          if (row[key] !== first[i][key]) drifts.push({ at: sample.at, sel: row.sel, key, from: first[i][key], to: row[key] });
        }
      });
    }
    assert.deepEqual(drifts, [], `the switch cue moved a box — the defect was a ring and a radius pop, not geometry, so ANY movement here is new: ${JSON.stringify(drifts.slice(0, 6))}`);

    // The two signatures of the old defect, sampled across the whole animation.
    const radii = phaseA.samples.map((s) => s.rows[stageIdx].radius);
    const shadows = phaseA.samples.map((s) => s.rows[stageIdx].shadow);
    assert.deepEqual([...new Set(radii)], ["0px"], `the stage's radius changed while flashing — the corners popped: ${JSON.stringify([...new Set(radii)])}`);
    assert.deepEqual([...new Set(shadows)], ["none"], `the stage grew a shadow ring while flashing: ${JSON.stringify([...new Set(shadows)])}`);
    const whereShadows = [...new Set(phaseA.samples.map((s) => s.rows.find((r) => r.sel === ".where").shadow))];
    assert.equal(whereShadows.length, 1, `the chip's shadow changed during the cue (it used to wear the ring): ${JSON.stringify(whereShadows)}`);

    // THE CUE IS REAL: the outline animation runs, and at some point it is actually visible (not transparent).
    const animations = [...new Set(phaseA.samples.map((s) => s.rows[stageIdx].animation))];
    assert.ok(animations.includes("project-switch-outline"), `the stage does not run the outline animation: ${JSON.stringify(animations)}`);
    const visible = phaseA.samples.some((s) => {
      const row = s.rows[stageIdx];
      return row.outlineStyle === "solid" && row.outlineColor !== "rgba(0, 0, 0, 0)" && row.outlineColor !== "transparent";
    });
    assert.ok(visible, "the outline was never visible during the cue — a cue nobody can see is not a cue");
    // …and it is an OUTLINE: the width is declared, and it ends transparent so the rule's arrival and
    // departure are both invisible (the attribute is dropped at 650ms by fused.js's timer).
    const stageAfter = phaseA.samples.at(-1).rows[stageIdx];
    assert.equal(stageAfter.animation, "none", "the outline animation is still running after the cue window");
    // AT REST the painting is gone — either the rule is gone (outline-style: none) or its colour animated
    // back to transparent. Asserting the COLOUR alone would be wrong: with style none the computed colour
    // falls back to the initial `currentColor`, which is not a painted outline at all (found by this test's
    // first run, which read rgb(35, 38, 43) and called it a leak).
    const settled = stageAfter.outlineStyle === "none" || ["rgba(0, 0, 0, 0)", "transparent"].includes(stageAfter.outlineColor);
    assert.ok(settled, `the outline is still painted after the cue window: style=${stageAfter.outlineStyle} colour=${stageAfter.outlineColor}`);

    // ── PHASE B: the REAL switch (the Browser scratchpad button) still works, and carries the same cue ──
    const phaseB = await page.evaluate(async () => {
      const stage = document.querySelector(".stage");
      const tick = () => new Promise((r) => requestAnimationFrame(() => r()));
      const seen = [];
      document.getElementById("open-opfs-folder").click();
      for (let i = 0; i < 45; i++) {
        await tick();
        const s = getComputedStyle(stage);
        seen.push({ radius: s.borderTopLeftRadius, shadow: s.boxShadow === "none" ? "none" : s.boxShadow, animation: s.animationName });
      }
      const line = document.getElementById("listing-root")?.textContent ?? "";
      return { seen, line };
    });
    assert.match(phaseB.line, /scratchpad/i, `the real switch did not land — the cue must accompany a real action: ${JSON.stringify(phaseB.line)}`);
    assert.deepEqual([...new Set(phaseB.seen.map((s) => s.radius))], ["0px"], "a real switch popped the stage's corners");
    assert.deepEqual([...new Set(phaseB.seen.map((s) => s.shadow))], ["none"], "a real switch grew a shadow ring on the stage");
    assert.ok(phaseB.seen.some((s) => s.animation === "project-switch-outline"), `the real switch did not run the outline cue: ${JSON.stringify([...new Set(phaseB.seen.map((s) => s.animation))])}`);
  } finally {
    await page.close();
  }
});
