// public/caption-fade.mjs — the caption's fade-out lifecycle (voicebox-beads-drcy).
//
// The caption shows the live turn: the user's transcript while they speak, then
// the model's reply. While the text is moving it stays fully visible; once it
// has stopped changing for the dwell time it fades out, keeping the voice
// section calm. New text (or an explicit reset) cancels the pending fade —
// active speech is never faded mid-word.
//
// The dwell is configurable: `__voiceboxCaptionDwellMs` on the page overrides
// the default (tests use a small value; the page default is 6 s, inside the
// 5-8 s window the bead calibrated). Dwell 0 disables the fade entirely.
//
// PURE apart from the timer: the element is resolved through a callback, so a
// test can drive the whole lifecycle with a fake element and real timers.

export const CAPTION_DWELL_MS_DEFAULT = 6000;
export const CAPTION_FADE_CLASS = "caption-fade";

export function createCaptionFade(resolveCaption, { dwellMs } = {}) {
  const dwell = Number.isFinite(dwellMs)
    ? dwellMs
    : Number(globalThis.__voiceboxCaptionDwellMs ?? CAPTION_DWELL_MS_DEFAULT);
  let timer = null;

  return {
    get pending() {
      return timer !== null;
    },
    get dwell() {
      return dwell;
    },
    // The caption text changed: visible again, and the dwell restarts.
    reset() {
      const caption = resolveCaption();
      if (caption) caption.classList.remove(CAPTION_FADE_CLASS);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (dwell > 0) {
        timer = setTimeout(() => {
          timer = null;
          resolveCaption()?.classList.add(CAPTION_FADE_CLASS);
        }, dwell);
      }
    },
    // The caption is being cleared (a new live session): no fade on empty.
    clear() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolveCaption()?.classList.remove(CAPTION_FADE_CLASS);
    },
  };
}
