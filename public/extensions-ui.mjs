// ── THE EXTENSION SURFACE (voicebox-beads-vwb, extracted by voicebox-beads-v25a) ────────────────
// One source: the server's registry and ledger, read fresh on every render. The page keeps no
// copy, so it cannot drift from what the host enforces. Four states, four sections, never mixed:
//   Running            the host allowed it — green, and the plain words say what it may do
//   Waiting for review proposed from the conversation or the catalogue — amber, not running
//   Found here         in the extensions folder, never reviewed — grey, NEVER green, NEVER running
//   Refused            decided, with the human sentence saying why
// The page can stage and disclose, but cannot approve alone: a person must copy a one-use
// code from the host console. The long-lived host token never enters the page.
// PLAIN LANGUAGE RULE: internal rule ids never reach this panel. Where the API gives a human
// sentence (the `why`), that is what the person reads; where it gives a state name, the page
// renders the state's meaning instead.
//
// EXTRACTED VERBATIM from public/fused.js (voicebox-beads-v25a). The bodies below are unchanged;
// what changed is that the four things this surface used to reach for as fused.js locals —
// `els`, `request`, `on` and `installLightDismissFallback` — are now injected by fused.js through
// initExtensionsUI(). `lastToolStatus` deliberately did NOT move: it is owned by fused.js (written
// by the live websocket tool-call hook), so the module reads it through the injected
// getToolStatus() accessor. That accessor must be LIVE. HISTORY, because the earlier wording here was
// true when written and became false: a snapshot captured at init WOULD freeze the shelf latency
// readout, and before voicebox-beads-w1f9 that mistake was invisible — the suite stayed green with the
// readout wrong. It is no longer invisible. tests/extensions-ui-extraction.test.mjs drives the real
// page's own wiring and hook, so a captured accessor now turns that test RED rather than shipping.

let els = {};
let request = () => { throw new Error("extensions-ui: request() not injected — call initExtensionsUI first"); };
let on = () => { throw new Error("extensions-ui: on() not injected — call initExtensionsUI first"); };
let installLightDismissFallback = () => {};
// Live by contract: reads fused.js's own map on every call, never a copy of it.
let getToolStatus = () => null;

function plainCaps(declared, bounds) {
  const words = [];
  const caps = declared ?? [];
  if (caps.includes("read")) words.push("read files in this project");
  if (caps.includes("write")) words.push("write files in this project");
  if (caps.includes("delete")) words.push("delete files");
  if (caps.includes("network")) {
    const hosts = (bounds?.hosts ?? []).join(", ") || "no host";
    words.push(`fetch from ${hosts}${bounds?.maxRequests ? ` (at most ${bounds.maxRequests} requests)` : ""}`);
  }
  return words.length ? `It may ${words.join(", and ")}.` : "It needs no special ability.";
}

function extRow({ name, dotState, stateText, detail, disclose }) {
  const li = document.createElement("li");
  li.className = "env-item";
  const head = document.createElement("div");
  head.className = "env-head";
  const dot = document.createElement("span");
  dot.className = "env-dot";
  dot.dataset.ok = dotState; // "present" is its own state — never green, never red
  head.appendChild(dot);
  const label = document.createElement("span");
  label.className = "env-label";
  label.textContent = name;
  head.appendChild(label);
  const state = document.createElement("span");
  state.className = "env-state";
  state.textContent = stateText;
  head.appendChild(state);
  li.appendChild(head);
  if (detail) {
    const d = document.createElement("p");
    d.className = "ext-detail";
    d.textContent = detail;
    li.appendChild(d);
  }
  if (disclose) li.appendChild(disclose);
  return li;
}

function extSection(listEl, rows, emptyText) {
  listEl.replaceChildren();
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.className = "env-item env-empty";
    li.textContent = emptyText;
    listEl.appendChild(li);
    return;
  }
  for (const row of rows) listEl.appendChild(row);
}

// The review panels the person has opened, by proposal id. Kept OUTSIDE the render because a
// background refresh rebuilds the list and must not discard what the person was reading
// (voicebox-beads-ujay).
const openPlanIds = new Set();

// The last plan text fetched per proposal id, so a rebuild restores what the person is reading
// instead of blanking the panel and re-asking the server on every background refresh.
const planCache = new Map();


function extensionApproval(id) {
  const wrap = document.createElement("div");
  wrap.className = "ext-review-controls";

  const actions = document.createElement("div");
  actions.className = "ext-actions";

  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "quiet ext-approve-btn";
  approve.textContent = "Approve & run";

  const refuse = document.createElement("button");
  refuse.type = "button";
  refuse.className = "quiet danger ext-refuse-btn";
  refuse.textContent = "Refuse";

  actions.append(approve, refuse);

  const details = document.createElement("details");
  details.className = "ext-plan";
  const summary = document.createElement("summary");
  summary.textContent = "Review permissions & plan";
  const note = document.createElement("p");
  note.setAttribute("role", "status");
  note.textContent = "Click 'Approve & run' to allow this extension in your workspace, or 'Refuse' to decline it.";
  const plan = document.createElement("pre");
  details.append(summary, note, plan);

  // READINESS IS NAMED, NOT INFERRED: "loading" -> "ready" | "error". A caller (and the test that
  // drives this panel) waits for a state instead of polling for text and calling the wait a timeout,
  // and an error keeps its own name so a refusal is reported as a refusal, not as slowness.
  // The last plan fetched per proposal is kept, so a rebuild RESTORES what the person is reading
  // instead of blanking the panel and re-asking the server on every 20s poll (the text blinked and
  // went "loading" under the reader's eyes). A silent revalidation still runs in the background, so
  // a plan that changed on the server is not shown stale for long; the authority is the server's own
  // plan digest at approve time anyway, which refuses a plan that moved (approval-plan-changed).
  const loadPlan = async ({ silent = false } = {}) => {
    if (details.dataset.planState === "loading") return;
    if (!silent) details.dataset.planState = "loading";
    try {
      const p = await request(`/api/extensions/proposals/${encodeURIComponent(id)}/plan`);
      const text = JSON.stringify(p, null, 2);
      plan.textContent = text;
      planCache.set(id, text);
      details.dataset.planState = "ready";
    } catch (err) {
      // A silent revalidation that failed must not erase the plan already on screen; a first load
      // that failed is the person's to see, named.
      if (silent) return;
      note.textContent = err.message;
      details.dataset.planState = "error";
    }
  };

  const post = (route, body) => request(`/api/extensions/${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  const showPlanForOpenPanel = () => {
    const cached = planCache.get(id);
    if (cached) {
      plan.textContent = cached;
      details.dataset.planState = "ready";
      void loadPlan({ silent: true });
      return;
    }
    void loadPlan();
  };

  details.addEventListener("toggle", () => {
    if (details.open) { openPlanIds.add(id); showPlanForOpenPanel(); }
    else openPlanIds.delete(id);
  });

  // A REFRESH MUST NOT CLOSE THE PANEL THE PERSON OPENED (voicebox-beads-ujay). renderExtensions()
  // rebuilds this list with replaceChildren(), and health() (a 20s poll) and a landing tool call both
  // call it — so a background refresh used to replace an open review panel with a fresh closed row
  // and its already-fetched plan vanished. The plan only ever loaded from the `toggle` event, and a
  // row that was never toggled never fires one: under load the plan simply never appeared, which is
  // the flake. The panel's open state belongs to the person, not to the render, so restore it here
  // and show its plan directly rather than waiting for an event this element will not get.
  if (openPlanIds.has(id)) {
    details.open = true;
    showPlanForOpenPanel();
  }

  approve.addEventListener("click", async () => {
    approve.disabled = true;
    try {
      await post("approve", { id, confirm: true });
      if (els.extNote) els.extNote.textContent = "Approved extension — it is now running.";
      await renderExtensions();
    } catch (err) {
      note.textContent = err.message;
      details.open = true;
    } finally {
      approve.disabled = false;
    }
  });

  refuse.addEventListener("click", async () => {
    refuse.disabled = true;
    try {
      await post("refuse", { id, why: "The host declined this extension from the room." });
      if (els.extNote) els.extNote.textContent = "You declined this proposal. It has been moved to Refused.";
      await renderExtensions();
    } catch (err) {
      note.textContent = err.message;
      details.open = true;
    } finally {
      refuse.disabled = false;
    }
  });

  wrap.append(actions, details);
  return wrap;
}

let lastRunningExtensions = [];

function openManageExt(ext, mode = "reconfigure") {
  if (!els.extManageDialog) return;
  if (els.extManageId) els.extManageId.value = ext.id;
  if (els.extManageMode) els.extManageMode.value = mode;
  if (els.extManageToken) els.extManageToken.value = "";
  if (els.extManageStatus) els.extManageStatus.textContent = "";

  if (mode === "reconfigure") {
    if (els.extManageTitle) els.extManageTitle.textContent = `Reconfigure ${ext.name ?? ext.id}`;
    if (els.extManageHint) els.extManageHint.textContent = "Update bounds to restore tool access or resolve configuration loops.";
    if (els.extManageFields) els.extManageFields.hidden = false;
    if (els.extManageRemoveWarning) els.extManageRemoveWarning.hidden = true;
    if (els.extManageHosts) els.extManageHosts.value = (ext.bounds?.hosts ?? []).join(", ");
    if (els.extManageMaxRequests) els.extManageMaxRequests.value = ext.bounds?.maxRequests ?? "";
    if (els.extManageSubmit) {
      els.extManageSubmit.textContent = "Save configuration";
      els.extManageSubmit.hidden = false;
    }
    if (els.extManageDelete) els.extManageDelete.hidden = false;
  } else {
    if (els.extManageTitle) els.extManageTitle.textContent = `Remove ${ext.name ?? ext.id}`;
    if (els.extManageHint) els.extManageHint.textContent = "Withdrawing an extension revokes its tools immediately.";
    if (els.extManageFields) els.extManageFields.hidden = true;
    if (els.extManageRemoveWarning) els.extManageRemoveWarning.hidden = false;
    const toolNames = (ext.tools ?? []).map((t) => (typeof t === "string" ? t : t.name)).join(", ");
    if (els.extManageWarningText) {
      els.extManageWarningText.textContent = `The extension's tools (${toolNames || "all tools"}) will stop being callable immediately.`;
    }
    if (els.extManageSubmit) {
      els.extManageSubmit.textContent = "Confirm removal";
      els.extManageSubmit.hidden = false;
    }
    if (els.extManageDelete) els.extManageDelete.hidden = true;
  }

  els.extManageDialog.showModal();
}

async function renderExtensions() {
  if (!els.extRunning) return;
  try {
    const [inv, cat] = await Promise.all([request("/api/extensions"), request("/api/extensions/catalogue")]);
    // WASM SHELF ROWS LIVE IN THEIR OWN SECTION (voicebox-beads-ri4k, coord ruling): the shelf's
    // digest-pinned tools are callable NOW — reconfig/remove and the running count are about
    // admitted-descriptor extensions, so shelf entries are excluded from both.
    const runningAll = inv.extensions ?? [];
    const running = runningAll.filter((e) => e.source !== "wasm-shelf");
    const shelfRunning = runningAll.filter((e) => e.source === "wasm-shelf");
    lastRunningExtensions = running;
    const waiting = (inv.proposals ?? []).filter((p) => p.state === "pending");
    // An id that is no longer reviewable leaves both pieces of panel state with it: otherwise an id a
    // later proposal reuses would come back unexpectedly open, and its old plan text with it. A
    // PRESENT file is reviewable too — it gets the same review panel — so it counts as still here.
    const reviewableIds = new Set([...waiting, ...(inv.present ?? [])].map((p) => p.id));
    for (const id of [...openPlanIds]) if (!reviewableIds.has(id)) { openPlanIds.delete(id); planCache.delete(id); }
    const refused = (inv.proposals ?? []).filter((p) => p.state === "refused");
    const present = inv.present ?? [];
    const catalogue = cat.catalogue ?? [];

    extSection(els.extRunning, running.map((e) => {
      const row = extRow({ name: e.name, dotState: "true", stateText: "Running", detail: plainCaps(e.declared, e.bounds) });
      const actions = document.createElement("div");
      actions.className = "ext-actions";

      const reconfigBtn = document.createElement("button");
      reconfigBtn.className = "quiet ext-reconfigure-btn";
      reconfigBtn.type = "button";
      reconfigBtn.textContent = "Reconfigure";
      reconfigBtn.setAttribute("data-id", e.id);
      reconfigBtn.addEventListener("click", () => openManageExt(e, "reconfigure"));
      actions.appendChild(reconfigBtn);

      const removeBtn = document.createElement("button");
      removeBtn.className = "quiet danger ext-remove-btn";
      removeBtn.type = "button";
      removeBtn.textContent = "Remove";
      removeBtn.setAttribute("data-id", e.id);
      removeBtn.addEventListener("click", () => openManageExt(e, "remove"));
      actions.appendChild(removeBtn);

      row.appendChild(actions);
      return row;
    }), "Nothing running yet.");

    // APPROVED, NOT RUNNING (voicebox-beads-qdo): an approved extension that failed to load is
    // named HERE, never silent — the row says what happened and what to do next, in the person's
    // words. Never green, never mixed into Running: half-loaded is a state the person must SEE.
    extSection(els.extFailed, (inv.failedLoads ?? []).map((f) =>
      extRow({ name: f.name ?? f.id, dotState: "false", stateText: "Approved · not running",
               detail: `${f.why} Next: ${f.next}` })
    ), "No approved extension is failing to load.");

    extSection(els.extWaiting, waiting.map((p) =>
      extRow({ name: p.name, dotState: "pending", stateText: "Waiting for the host's review", disclose: extensionApproval(p.id) })
    ), "Nothing is waiting for review.");

    // PRESENT, NOT RUNNING: visible, honest, and never green. A file the host has never
    // reviewed is not a running tool, and this panel must never blur that difference.
    extSection(els.extPresent, present.map((p) =>
      extRow({ name: p.name ?? p.id, dotState: "present", stateText: "Found here · never reviewed · not running",
               detail: "Found in the extensions folder. It has never run — approve it below to allow it, or refuse it.",
               disclose: extensionApproval(p.id) })), "No unreviewed files here.");

    extSection(els.extRefused, refused.map((p) =>
      extRow({ name: p.name, dotState: "false", stateText: "Refused", detail: p.refusal?.why ?? "The host declined this extension." })), "Nothing was refused.");

    // WASM SHELF (voicebox-beads-ri4k): these are NOT catalogue strangers awaiting review —
    // they are digest-pinned, admitted and callable right now, so they render in their own
    // section with their description and their last execution status (from the live tool
    // frames), never as a "would run after review" maybe.
    const shelfRows = shelfRunning.flatMap((e) => {
      const toolNames = e.tools ?? [];
      return toolNames.map((toolName) => {
        const last = getToolStatus(toolName);
        const ago = last ? ` · ${Math.max(1, Math.round((Date.now() - last.at) / 1000))}s ago` : "";
        // THE EXECUTION LATENCY (voicebox-beads-rgvi): how long the host executor ran the tool,
        // shown beside the ok/failed fact — a number measured at the executor, not a guess.
        const latency = Number.isFinite(last?.durationMs) ? ` · ${last.durationMs}ms` : "";
        const stateText = `Callable now · ${toolName}${last ? ` · last run ${last.ok ? "ok" : "failed"}${latency}${ago}` : " · not yet run in this session"}`;
        const detail = (e.toolDetails ?? []).find((td) => td.name === toolName)?.description ?? e.description ?? "";
        return extRow({ name: e.name, dotState: "true", stateText, detail });
      });
    });
    extSection(els.extShelf, shelfRows, "No wasm shelf tools are allowed yet. A digest-pinned manifest in the wasm shelf directory adds them here.");

    const isShelf = (c) => String(c.id ?? "").startsWith("wasm-shelf-");
    extSection(els.extCatalogue, catalogue.filter((c) => !isShelf(c)).map((c) => {
      // The preview's ENFORCEMENT MAP is what separates "would run here" from "cannot": an
      // admitted preview names the mechanisms it would get; a refusal names why it would not.
      const wouldRun = c.preview != null && c.preview.enforced !== undefined;
      const verdict = wouldRun
        ? "Would run here after review."
        : `Cannot run here — ${c.preview?.why ?? "this machine cannot give it what it asks for"}`;
      const row = extRow({ name: c.name ?? c.id, dotState: "pending", stateText: verdict, detail: c.description });
      if (wouldRun) {
        const add = document.createElement("button");
        add.className = "quiet";
        add.type = "button";
        add.textContent = "Add to review";
        add.addEventListener("click", async () => {
          try {
            const staged = await request("/api/extensions/sideload", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: c.id, confirm: true }),
            });
            if (els.extNote) els.extNote.textContent = `${staged.id ?? "It"} was added to the review list.`;
          } catch (err) {
            if (els.extNote) els.extNote.textContent = String(err?.message ?? "it could not be added");
          }
          await renderExtensions();
        });
        row.appendChild(add);
      }
      return row;
    }), "The catalogue is empty.");

    if (els.extCount) {
      const up = running.length;
      els.extCount.textContent = `Extensions · ${up} running · ${waiting.length} waiting`;
    }
    if (els.extNote && !els.extNote.textContent) els.extNote.textContent = "";
  } catch (err) {
    if (els.extCount) els.extCount.textContent = "Extensions";
    if (els.extNote) els.extNote.textContent = String(err?.message ?? "the extension list could not be read");
  }
}



// The dialogs open like settings: showModal() for modality, focus trapping, an inert
// background and Esc, with focus returned to the trigger on close. The platform provides all
// of it, so this module adds no visibility logic of its own - it only wires the triggers and
// keeps the native <dialog> semantics (and their focus behaviour) intact.

// ── LISTENER WIRING. Single entry point: this is the ONLY place this surface attaches listeners.
export function initExtensionsUI(deps = {}) {
  if (deps.els) els = deps.els;
  if (deps.request) request = deps.request;
  if (deps.on) on = deps.on;
  if (deps.installLightDismissFallback) installLightDismissFallback = deps.installLightDismissFallback;
  if (deps.getToolStatus) getToolStatus = deps.getToolStatus;

on(els.extsOpen, "click", () => {
  if (!els.exts || els.exts.open) return;
  els.exts.showModal();
  els.extsOpen?.setAttribute("aria-expanded", "true");
  void renderExtensions();
});
on(els.extsClose, "click", () => els.exts?.close());
on(els.exts, "close", () => {
  els.extsOpen?.setAttribute("aria-expanded", "false");
  els.extsOpen?.focus();
});


on(els.extCreateForm, "submit", async (event) => {
  event.preventDefault();
  const id = els.extCreateId?.value?.trim();
  const name = els.extCreateName?.value?.trim();
  const description = els.extCreateDesc?.value?.trim();
  const primitive = els.extCreatePrimitive?.value ?? "http-get";
  const target = els.extCreateTarget?.value?.trim() ?? "";
  if (!id || !name || !description) return;

  const capabilities = [];
  const bounds = {};
  const params = {};
  if (primitive === "http-get") {
    capabilities.push("network");
    const host = target || "127.0.0.1";
    bounds.hosts = [host];
    bounds.maxRequests = 50;
  } else if (primitive === "read-file" || primitive === "list-files") {
    capabilities.push("read");
  } else if (primitive === "write-file") {
    capabilities.push("write");
    bounds.maxBytes = 65536;
  }

  const descriptor = {
    id,
    name,
    description,
    source: "local",
    runsIn: "host",
    capabilities,
    bounds,
    tools: [
      {
        name: id.replace(/-/g, "_"),
        description,
        primitive,
        params,
      },
    ],
  };

  if (els.extCreateBtn) els.extCreateBtn.disabled = true;
  try {
    const resp = await request("/api/extensions/local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ descriptor }),
    });
    if (resp.ok) {
      if (els.extNote) els.extNote.textContent = `Local extension '${id}' staged as pending proposal. Review and approve below.`;
      els.extCreateForm.reset();
      await renderExtensions();
    } else {
      if (els.extNote) els.extNote.textContent = resp.why ?? resp.error ?? "Failed to stage local extension";
    }
  } catch (err) {
    if (els.extNote) els.extNote.textContent = err.message;
  } finally {
    if (els.extCreateBtn) els.extCreateBtn.disabled = false;
  }
});

on(els.extManageClose, "click", () => els.extManageDialog?.close());
installLightDismissFallback(els.extManageDialog);

on(els.extManageDelete, "click", () => {
  const id = els.extManageId?.value;
  const current = lastRunningExtensions.find((e) => e.id === id);
  if (current) openManageExt(current, "remove");
});

on(els.extManageForm, "submit", async (event) => {
  event.preventDefault();
  const id = els.extManageId?.value;
  const mode = els.extManageMode?.value;
  const token = els.extManageToken?.value.trim();

  if (els.extManageSubmit) els.extManageSubmit.disabled = true;
  if (els.extManageStatus) els.extManageStatus.textContent = "Applying...";

  const headers = { "content-type": "application/json" };
  const roomSessionToken = document.querySelector('meta[name="voicebox-session-token"]')?.content;
  if (roomSessionToken && roomSessionToken !== "__VOICEBOX_SESSION_TOKEN__") {
    headers["x-voicebox-session-token"] = roomSessionToken;
  }
  if (token) {
    headers["x-voicebox-host-token"] = token;
  }

  try {
    if (mode === "remove") {
      const resp = await request(`/api/extensions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers,
      });
      if (resp.ok) {
        els.extManageDialog?.close();
        if (els.extNote) els.extNote.textContent = `'${id}' was removed. Tools are no longer callable.`;
        await renderExtensions();
      } else {
        if (els.extManageStatus) els.extManageStatus.textContent = resp.why ?? resp.refused ?? "Could not remove extension.";
      }
    } else {
      const hosts = els.extManageHosts?.value.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
      const maxReqVal = els.extManageMaxRequests?.value.trim() ?? "";
      const bounds = {};
      if (hosts.length > 0) bounds.hosts = hosts;
      if (maxReqVal) {
        bounds.maxRequests = Number(maxReqVal);
      }

      const resp = await request("/api/extensions/reconfigure", {
        method: "POST",
        headers,
        body: JSON.stringify({ id, bounds, confirm: true }),
      });
      if (resp.ok) {
        els.extManageDialog?.close();
        if (els.extNote) els.extNote.textContent = `'${id}' was reconfigured with updated bounds.`;
        await renderExtensions();
      } else {
        if (els.extManageStatus) els.extManageStatus.textContent = resp.why ?? resp.refused ?? "Could not reconfigure extension.";
      }
    }
  } catch (err) {
    if (els.extManageStatus) els.extManageStatus.textContent = err?.why ?? err?.refused ?? err?.message ?? "An error occurred.";
  } finally {
    if (els.extManageSubmit) els.extManageSubmit.disabled = false;
  }
});

  return { renderExtensions, openManageExt, extensionApproval };
}

export { plainCaps, extRow, extSection, extensionApproval, openManageExt, renderExtensions };
