/**
 * **Declare a project root, from the page** (`voicebox-beads-utj`).
 *
 * The seam answers and nothing could reach it: GET /api/root said
 * `refused: "root-not-declared"` with a remedy that named POST /api/root,
 * while the page that points people here offered a dropzone with no handler
 * and no way to declare anything. A remedy with no route reads as though the
 * way exists and you simply cannot find it.
 *
 * The body is the worker's own shape (`browser/worker.ts`, `useMachineRoot`),
 * and the server's refusals travel unchanged: `path-missing` and
 * `not-a-directory` are the same facts a person needs, and re-wording them
 * here would be a second vocabulary for one thing.
 *
 * WHY THIS FILE IS LOADED WITHOUT `defer` (`voicebox-beads-xggy.2`). It used to be
 * an inline script at the end of <body>, which ran while the document was still
 * parsing, so its listener always existed before anyone could click. A DEFERRED file
 * attaches once the document is already interactive, and a click landing in that
 * window is lost PERMANENTLY: a click leaves no state behind to re-apply, so unlike
 * the Help search filter (`voicebox-beads-aenb`), which can apply the value already
 * sitting in its box, nothing in code can recover it. So this stays a CLASSIC
 * parser-blocking script at the end of the body — one small same-origin fetch, the
 * same delay the inline original imposed for the same work, and no window in which
 * "Declare this folder" is silently inert.
 *
 * The elements are looked up at evaluation time, so this file must stay AFTER them:
 * a <head> or top-of-body placement would return nulls and the call below would throw.
 */
const pathInput = document.getElementById("root-path");
const hostTokenInput = document.getElementById("machine-host-token");
const declareButton = document.getElementById("declare-root");
const declareResult = document.getElementById("declare-result");

function say(text, ok) {
  declareResult.hidden = false;
  declareResult.dataset.ok = String(ok);
  declareResult.textContent = text;
}

declareButton.addEventListener("click", async () => {
  const path = pathInput.value.trim();
  if (path === "") {
    say("a folder needs a path — the folder the loop should write into", false);
    return;
  }
  const name = path.split("/").filter(Boolean).pop() ?? "project";
  const hostToken = hostTokenInput ? hostTokenInput.value.trim() : "";
  const headers = { "content-type": "application/json" };
  if (hostToken) headers["x-voicebox-host-token"] = hostToken;
  declareButton.disabled = true;
  try {
    const response = await fetch("/api/root", {
      method: "POST",
      headers,
      body: JSON.stringify({ project: name, root: { kind: "machine", path } }),
    });
    const answer = await response.json();
    if (answer && answer.ok) say("declared: " + answer.root.path + " — the loop writes here now.", true);
    else say((answer && answer.refused ? answer.refused : "refused") + ": " + ((answer && answer.why) || "the declaration was refused"), false);
  } catch (error) {
    say("could not reach the server: " + error.message, false);
  } finally {
    declareButton.disabled = false;
  }
});
