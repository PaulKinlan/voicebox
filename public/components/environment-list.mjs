/**
 * @summary Environment inventory list and active root status renderer.
 */
// public/components/environment-list.mjs — the environment list (voicebox-beads-uei2.10, scoped by
// voicebox-beads-uei2.8 from the voicebox-beads-uei2 decomposition).
//
// Owns the list of environments the host knows about and the active-root readout that shares its source:
// the `/api/environments` read, the rows (reachable / unreachable, with their plain-language notes), the
// per-row Re-probe and Remove actions, the auto-probe of a reachable environment that has never been
// probed, and the three states of `#env-active-root-val` (a picked folder, the browser-storage scratchpad,
// and "no folder chosen yet"). It reads /api/environments on every render and keeps no copy, so it cannot
// drift from what the host enforces.
//
// WHY THE SEAM LOOKS LIKE THIS:
//   * The renderer builds its own rows with document.createElement and attaches its own handlers to those
//     created buttons, so it needs no element-wiring helper from the host.
//   * It reads only five names from the host. `els` (the page's element map), `request` and
//     `SCRATCHPAD_NAME` are plain values.
//   * `roomFolder` and `activeRoot` are LIVE ACCESSORS, because the host REASSIGNS both while the page
//     lives (a new folder picked, a root adopted, the scratchpad swapped): a snapshot would paint a stale
//     root for the rest of the session. This renderer only READS them — verified, no writes.
//   * `renderEnvironments` is returned because four places outside the list call it: the health poll, two
//     root/room changes, and a settings path.
export function initEnvironmentList({ els, request, SCRATCHPAD_NAME, getRoomFolder, getActiveRoot }) {
async function renderEnvironments() {
  if (els.envActiveRootVal) {
    if (getRoomFolder()) {
      const isOpfs = getRoomFolder().name === SCRATCHPAD_NAME;
      const kindPlain = isOpfs ? "browser storage" : "picked folder";
      els.envActiveRootVal.textContent = `${kindPlain} · ${getRoomFolder().name}`;
    } else if (getActiveRoot() === null) {
      els.envActiveRootVal.textContent = "no folder chosen yet";
    } else if (getActiveRoot()) {
      const fullPath = getActiveRoot().root?.path ?? getActiveRoot().root?.name ?? getActiveRoot().root?.label ?? "";
      const kind = getActiveRoot().root?.kind ?? "";
      const kindPlain = { machine: "machine folder", opfs: "browser storage", handle: "picked folder" }[kind]
        ?? getActiveRoot().facts?.where ?? kind ?? "a root";
      els.envActiveRootVal.textContent = fullPath ? `${kindPlain} · ${fullPath}` : kindPlain;
    }
  }
  if (!els.envList) return;
  try {
    const answer = await request("/api/environments");
    const list = answer.environments ?? [];
    els.envList.replaceChildren();
    // The BROWSER environment is a host too — the page worker — and it is the one you are standing
    // in: reachable by construction, always listed first. Its tools are a different set from a
    // machine's, which is exactly what the capability report exists to show.
    const browserRow = document.createElement("li");
    browserRow.className = "env-item";
    const bHead = document.createElement("div");
    bHead.className = "env-head";
    const bDot = document.createElement("span");
    bDot.className = "env-dot";
    bDot.dataset.ok = "true";
    bHead.appendChild(bDot);
    const bName = document.createElement("span");
    bName.className = "env-label";
    bName.textContent = "this browser";
    bHead.appendChild(bName);
    const bState = document.createElement("span");
    bState.className = "env-state";
    bState.textContent = "this page";
    bHead.appendChild(bState);
    browserRow.appendChild(bHead);
    const bCap = document.createElement("span");
    bCap.className = "env-cap-none";
    bCap.textContent = "OPFS + picked folders";
    browserRow.appendChild(bCap);
    els.envList.appendChild(browserRow);
    for (const env of list) {
      const li = document.createElement("li");
      li.className = "env-item";
      // The ROW'S HEAD: name, reachability, and the controls — always visible, never pushed by a report.
      const head = document.createElement("div");
      head.className = "env-head";
      const dot = document.createElement("span");
      dot.className = "env-dot";
      dot.dataset.ok = env.reachable === true ? "true" : env.reachable === false ? "false" : "pending";
      head.appendChild(dot);
      const name = document.createElement("span");
      name.className = "env-label";
      name.textContent = env.label ?? "an environment";
      head.appendChild(name);
      const state = document.createElement("span");
      state.className = "env-state";
      if (env.reachable === true) state.textContent = "reachable";
      else if (env.reachable === false) {
        // "not reachable" is what a person needs; WHICH refusal it was is a diagnostic, and the row
        // already carries one as its title (voicebox-beads-0ye: the identifier was the visible label).
        state.textContent = "not reachable";
        state.title = [env.refused, env.why].filter(Boolean).join(" — ");
      } else state.textContent = env.why ?? "always here";
      head.appendChild(state);
      if (env.key === "local") {
        const reprobeBtn = document.createElement("button");
        reprobeBtn.type = "button";
        reprobeBtn.className = "quiet env-reprobe-btn";
        reprobeBtn.textContent = "Re-probe";
        reprobeBtn.addEventListener("click", async () => {
          reprobeBtn.disabled = true;
          reprobeBtn.textContent = "Probing…";
          try {
            await request("/api/probe", { method: "POST" });
            await renderEnvironments();
            // Written AFTER the refresh, not before it: renderEnvironments() clears the note as it paints, so a
            // confirmation written first is wiped in the same turn and the user never sees it
            // (voicebox-beads-2qxi — measured at 4 ms). The error paths below already write after the render.
            if (els.envNote) els.envNote.textContent = `Re-probed ${env.label ?? "this machine"}.`;
          } catch (err) {
            if (els.envNote) els.envNote.textContent = String(err?.message ?? "could not re-probe this machine");
          } finally {
            reprobeBtn.disabled = false;
            reprobeBtn.textContent = "Re-probe";
          }
        });
        head.appendChild(reprobeBtn);
      } else if (env.key) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "quiet danger env-remove-btn";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", async () => {
          removeBtn.disabled = true;
          try {
            await request(`/api/environments/${encodeURIComponent(env.key)}`, { method: "DELETE" });
            await renderEnvironments();
            // Same ordering as the Re-probe path, and for the same reason (voicebox-beads-2qxi).
            if (els.envNote) els.envNote.textContent = `Removed '${env.label ?? env.key}'.`;
          } catch (err) {
            if (els.envNote) els.envNote.textContent = String(err?.message ?? "could not remove environment");
          } finally {
            removeBtn.disabled = false;
          }
        });
        head.appendChild(removeBtn);
      }
      li.appendChild(head);
      // WHERE the row points, in plain sight (voicebox-beads-mrr7): two "Worker Alpha" rows on two
      // different hosts are legitimate declarations, and indistinguishable without the origin.
      if (env.key !== "local" && env.origin) {
        const origin = document.createElement("p");
        origin.className = "env-origin";
        origin.textContent = env.origin;
        li.appendChild(origin);
      }
      // The capability report is CONTAINED and SCROLLABLE, and it SUMMARISES: a long probe is a count
      // with the full list behind an expansion, so it never overwrites the name or the actions.
      // voicebox-beads-1jk: presence is not capability. The probe measured what the HOST has; the
      // executor has no program-execution verb, so the row must not read as "my agent can use these".
      const tools = env.capability?.tools;
      if (tools && typeof tools === "object") {
        const present = Object.entries(tools).filter(([, v]) => v && v.value).map(([k]) => k);
        const cap = document.createElement("details");
        cap.className = "env-cap";
        const summary = document.createElement("summary");
        summary.textContent = present.length ? `${present.length} host programs — present, not invocable` : "no programs found on this host";
        cap.appendChild(summary);
        if (present.length) {
          const note = document.createElement("p");
          note.className = "env-cap-note";
          note.textContent = "Present on this host when probed. Voicebox tasks act on files — read, write, list, grep, edit, diff, delete — they cannot run these programs. A delegated harness runs its own tools under its own grants.";
          const full = document.createElement("div");
          full.className = "env-cap-list";
          full.textContent = present.join(", ");
          cap.append(note, full);
        }
        cap.title = `probed ${env.capability.when ?? "at an unknown time"}`;
        li.appendChild(cap);
      } else if (env.reachable !== false) {
        // "not probed" is only worth saying about a host that COULD answer (voicebox-beads-mrr7):
        // a host that is not running cannot be probed, so under an unreachable row the line was
        // noise on top of the state that already says so.
        const cap = document.createElement("span");
        cap.className = "env-cap-none";
        cap.textContent = "not probed";
        li.appendChild(cap);
      }
      els.envList.appendChild(li);
    }
    if (els.envCount) {
      const up = list.filter((e) => e.reachable === true).length;
      els.envCount.textContent = `${list.length + 1} environments · ${up + 1} reachable`;
    }
    if (els.envNote) els.envNote.textContent = "";
    // AUTO-PROBE: a reachable environment that has never been probed is asked to probe itself, on
    // first reach (Paul: automatically, not a button). The act is recorded in the environment's own
    // audit by the host; here we only re-render once the report exists. This loop is the local
    // server today; a remote environment's report rides its own /api/probe the same way.
    const unprobed = list.filter((e) => e.reachable === true && !e.capability);
    if (unprobed.some((e) => e.key === "local")) {
      request("/api/probe").then(() => renderEnvironments()).catch(() => {});
    }
  } catch (err) {
    // The registry could not be read, or the server is not answering: the refusal is named, not blank.
    if (els.envCount) els.envCount.textContent = "Environments";
    if (els.envNote) els.envNote.textContent = err?.refused === "loopback-unauthenticated"
      ? "This page has no session on this origin. Redeem a bootstrap ticket here, or restart without VOICEBOX_LOOPBACK_AUTH."
      : String(err?.message ?? "the environment list could not be read");
    throw err;
  }
}

  return { renderEnvironments };
}
