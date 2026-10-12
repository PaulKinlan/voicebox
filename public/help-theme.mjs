// public/help-theme.mjs — help.html's single link to the shared theme owner (voicebox-beads-ftqe).
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT A COPY. public/help.html has no fused.js, so nothing on that
// page would otherwise import public/theme.mjs — which is how it ended up with its own inline copy of the
// decision in the first place, and then with a pre-paint guard that resolved the system scheme only once.
// The guard is right for the FIRST frame and wrong for every frame after it: with "system" selected, an
// operating-system switch from light to dark while the page is open left help.html painted light, while
// the room followed it, because the room's owner installs a matchMedia listener.
//
// So this is not a fourth implementation — it is the same module the room uses, imported. initTheme() is
// null-safe and takes no controls, so the page gets the module's own tri-state, its storage key and,
// critically, its listener, without restating any of it. The classic guard in <head> keeps doing the
// part this deferred module cannot: applying the stored choice before the first paint.
//
// If this page ever grows a theme control, hand it to initTheme() here rather than teaching this file
// about themes.
import { initTheme } from "/theme.mjs";

initTheme();
