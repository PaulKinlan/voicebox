// tests/lib/click-diagnostic.mjs — one line saying where a real-mouse click actually went (voicebox-beads-joxy).
//
// WHY THE NO-EVENT CASE HAS THREE WORDINGS. gate-recover measured the click their eight-way run lost and found
// the target still PRESENT, still ENABLED, with the page state untouched: the event was dispatched and simply did
// not take effect. That is **displacement**. A **removed** target also produces no click event — a click needs
// press and release to share a target — and a target that went hidden or non-interactive produces another. They
// are different faults with different fixes. The first draft of this diagnostic said "the pointer was not over
// anything clickable" for all of them, which reports a cause it cannot know and re-creates, one level down, the
// very conflation it was written to remove. So the wording is chosen from the target's own state, and the event
// count is always stated.
//
// Pure on purpose: the displacement case cannot be produced deterministically in a browser (Chrome either
// dispatches the click or it does not), so it is unit-tested here while the removal case is driven end to end in
// tests/cdp-click-diagnostics.test.mjs.
//
// Input:
//   selector  the element the click was aimed at
//   at        { x, y } — where the mouse event was dispatched
//   events    the capture-phase clicks the probe saw, in order: [{ received, text, toIntended }]
//   target    the intended element's state afterwards: { hadIntended, present, enabled, interactive, now }
export function describeClick({ selector, at, events = [], target = {} }) {
  const where = `at (${at.x}, ${at.y})`;
  const now = target.now ? `(${target.now.x}, ${target.now.y})` : null;

  if (events.length === 0) {
    if (target.present && target.enabled && target.interactive) {
      return (
        `the click on ${selector} ${where} reached no listener: 0 click events reached the document although the target ` +
        `is still present, still enabled and at ${now} — the dispatched event did not take effect (displacement, not removal)`
      );
    }
    if (!target.present) {
      return (
        `the click on ${selector} ${where} reached no listener: 0 click events reached the document and the target is ` +
        `no longer in it — a click needs press and release to share a target, so a target that vanishes dispatches nothing`
      );
    }
    return (
      `the click on ${selector} ${where} reached no listener: 0 click events reached the document and the target, though ` +
      `still in the document, is not interactive (hidden, disabled or zero-sized)`
    );
  }

  const hit = events[0];
  const named = `${hit.received}${hit.text ? `, "${hit.text}"` : ""}`;
  const extra = events.length > 1 ? ` (${events.length} click events reached the document)` : "";
  const place = target.now
    ? `; the target is now at ${now}${target.interactive ? "" : " but is hidden or no longer interactive"}`
    : target.hadIntended
      ? "; the target has since left the document"
      : "";
  if (hit.toIntended) return `the click on ${selector} ${where} did reach the target (received by ${named})${extra}${place}`;
  return `the click on ${selector} ${where} was received by ${named} instead of the target${extra}${place}`;
}
