// d2ji review probe: measure the OUTPUT RING's seam and amplitude behaviour in a real browser.
//   node /tmp/d2ji-probe.mjs <tree>
const TREE = process.argv[2];
const { startServer } = await import(`${TREE}/tests/lib/server.mjs`);
const { launch } = await import(`${TREE}/tests/lib/cdp.mjs`);
const server = await startServer({ cwd: TREE, env: { VOICEBOX_INSTANCE: `d2ji-${process.pid}` } });
const page = await launch({ width: 1000, height: 900 });
try {
  await page.goto(`${server.base}/`);
  await page.waitFor(() => window.__voiceboxMeters !== undefined, { label: "the meters" });
  const result = await page.evaluate(async () => {
    const RING = 64;
    const quiet = () => Float32Array.from({ length: RING }, () => 0.02);
    // THE WRAP FIXTURE, made phase-independent: the ring is a smooth ramp (adjacent entries differ by
    // ~0.008) whose ONLY discontinuity is between the newest entry (n-1) and the oldest (0) — exactly the
    // adjacency the history wrap creates on screen. A smoother fixture cannot hide behind the sampling grid:
    // any jump above ~1 unit in the painted contour is the wrap, wherever the phase puts it.
    const stepAtWrap = () => Float32Array.from({ length: RING }, (_, i) => 0.55 - (i / (RING - 1)) * 0.53);
    const loud = () => Float32Array.from({ length: RING }, () => 0.5);

    const ring = quiet();
    window.__voiceboxLiveClient = { level: () => ({ capture: 0.05, input: new Float32Array(28), output: ring }) };
    document.getElementById("voice-ring-wrap").dataset.voice = "speaking";
    window.__voiceboxMeters.startMeters();

    // Recover the rendered point radii from the painted path: closedCurve emits M x,y then cubic C
    // triples whose LAST pair is the endpoint, so the endpoints + the M point are the ring's points.
    const radii = () => {
      const d = document.getElementById("output-path")?.getAttribute("d") ?? "";
      const nums = [...d.matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      const pts = nums.filter((_, i) => i === 0 || i % 3 === 0);
      return pts.map(([x, y]) => Math.hypot(x - 120, y - 120));
    };
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const means = [];
    const tick = async () => { await frame(); const r = radii(); means.push(r.reduce((a, b) => a + b, 0) / (r.length || 1)); return r; };

    // 1. WRAP SEAM: a loud-to-quiet step across the ring's oldest/newest boundary.
    ring.set(stepAtWrap());
    for (let i = 0; i < 8; i++) await tick();
    const seamRadii = await tick();
    // THE SEAM IS WHEREVER THE DATA WRAPS, not at the drawn closure (a closed ring ends where it started).
    // So measure the largest radial step between ADJACENT rendered points, closure included.
    let seam = 0;
    for (let i = 0; i < seamRadii.length; i++) {
      const a = seamRadii[i];
      const b = seamRadii[(i + 1) % seamRadii.length];
      seam = Math.max(seam, Math.abs(a - b));
    }
    const wrapSeam = seam;

    // 2. ONSET: silence → loud, per-frame mean-radius deltas.
    ring.set(quiet());
    for (let i = 0; i < 20; i++) await tick();
    const onsetFrom = means.length;
    ring.set(loud());
    for (let i = 0; i < 30; i++) await tick();
    const onset = means.slice(onsetFrom).map((v, i, a) => (i === 0 ? v - means[onsetFrom - 1] : v - a[i - 1]));
    const onsetMaxDelta = Math.max(...onset.map(Math.abs));

    // 3. PAUSE: loud → TRUE SILENCE (zeros), frames until the ring is back at the base radius.
    const decayFrom = means.length;
    ring.set(new Float32Array(RING));
    let framesToRest = null;
    for (let i = 0; i < 90; i++) {
      await tick();
      const r = radii();
      if (framesToRest === null && Math.max(...r) < 62.5) framesToRest = i + 1; // OUTPUT_BASE ~62 in viewBox units
    }
    const decay = means.slice(decayFrom).map((v, i, a) => (i === 0 ? means[decayFrom - 1] - v : a[i - 1] - v));
    const decayMaxDelta = Math.max(...decay.map(Math.abs));

    // 4. LIVENESS on a CONSTANT ring: the room's own carrier must keep the picture moving.
    ring.set(loud());
    for (let i = 0; i < 10; i++) await tick();
    const seen = new Set();
    for (let i = 0; i < 30; i++) { await tick(); seen.add(document.getElementById("output-path")?.getAttribute("d") ?? ""); }

    return {
      points: seamRadii.length,
      wrapSeamUnits: Number(wrapSeam.toFixed(2)),
      onsetMaxDeltaUnits: Number(onsetMaxDelta.toFixed(2)),
      decayMaxDeltaUnits: Number(decayMaxDelta.toFixed(2)),
      framesToRest,
      distinctPathsOnConstantRing: seen.size,
      baseRadius: 62,
      amplitude: 13,
    };
  });
  console.log(JSON.stringify({ tree: TREE, ...result }, null, 2));
} finally { await page.close(); await server.stop(); }
