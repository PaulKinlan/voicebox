// browser/ui/ui.ts — the renderer: text transcript, asset gallery, confirmation prompt, and the
// explorer that has to say WHICH root it is showing.
//
// THE FIRST RULE THIS FILE KEEPS (§3.5a): nothing that came from a file or a model is interpolated
// into markup. Names are text nodes; SVG is rendered through a blob URL in an <img> (never inline,
// because an inline SVG carries script); text and HTML assets are shown AS TEXT, which for the
// `html` kind is not a limitation but the correct rendering — the gallery shows you the asset, it
// does not become the page. There is no innerHTML in this file, so that class of defect has
// nowhere to live.
//
// THE SECOND RULE IS N20/7cd's: the three roots have genuinely different authority — OPFS is
// origin-private with implicit access, a picked folder is the user's real filesystem granted once,
// and the server view is a real directory that survives the tab closing. A listing that silently
// mixes them cannot be reasoned about, so every panel names its root, its authority, its permission
// state and its recovery story, and it does so from the project RECORD rather than from a guess.
//
// THE THIRD: a listing is ONE bounded message. It never walks a tree and never issues a read per
// entry — the page that listed files by posting a `read <name>` turn per name is exactly the defect
// this shape prevents.

import { getHandle } from "../idb.ts";

type Reply = { id: number; ok: boolean } & Record<string, any>;

const worker = new Worker("/browser/worker.ts", { type: "module" });
const pending = new Map<number, (reply: Reply) => void>();
let nextId = 1;

worker.onmessage = (event: MessageEvent) => {
  const reply = event.data as Reply;
  const resolve = pending.get(reply.id);
  if (resolve) {
    pending.delete(reply.id);
    resolve(reply);
  }
};

const send = (message: Record<string, unknown>): Promise<Reply> => {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ ...message, id });
  });
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`the page is missing #${id}`);
  return node as T;
};

function line(text: string, kind = "note"): void {
  const item = document.createElement("li");
  item.className = `line ${kind}`;
  item.textContent = text; // a text node: the transcript never becomes markup
  $("transcript").appendChild(item);
}

/** Every failure is rendered with its CODE, because "internal error" is not a recovery story. */
function failure(reply: Reply): string {
  return `${reply.code ?? "error"}: ${reply.why ?? reply.error ?? "no reason given"}`;
}

// ---------------------------------------------------------------- the project header

function header(project?: Record<string, any>): void {
  const box = $("project");
  box.textContent = "";
  if (!project) {
    box.textContent = "no project open";
    return;
  }
  const kind = project.rootKind ?? project.location?.kind ?? "opfs";
  const rows: [string, string][] = [
    ["project", String(project.id)],
    ["placement", String(project.placement)],
    ["root kind", kind === "handle"
      ? `a picked folder — '${project.location.label}'`
      : kind === "machine"
        ? "a folder on the machine running the process"
        : "OPFS (origin-private)"],
    ["root", String(project.root)],
    // Who acts on this root is a FACT about the kind, and the page says it rather than letting the
    // user discover it by trying: a machine root's acts come from the loop, a picked folder's from
    // this page, an OPFS root's from this page.
    ["acts come from", kind === "machine" ? "the loop (a machine process) — this page can see it and cannot write it" : "this page (the browser host)"],
    ["recovery", kind === "handle"
      ? `the handle is persisted in IndexedDB, so a reload does not re-pick; permission is ${project.durability?.permission ?? "unknown"}, and restoring it takes a click`
      : kind === "machine"
        ? "a folder on that machine's own filesystem: it survives the tab because it never depended on the browser"
        : "re-resolved from the origin's storage at every open — no gesture, ever"],
    // Durability is a question the BROWSER asks about its own storage. A folder on the machine is
    // not the browser's to keep or evict, so answering with `persisted()` here would be a leftover
    // from the OPFS kind dressed up as a fact — exactly the dishonest recovery story N20 names.
    ["durability", kind === "machine"
      ? "the machine's own filesystem — the browser's persistence question does not apply to it"
      : project.durability?.persisted
        ? "held persistently"
        : "held until the browser decides otherwise (persisted() is false)"],
    ["undo", `${project.undoKind} — the written files are listed in ${project.root}/.undo.json`],
    ["audit", String(project.auditLocation ?? "(not reported)")],
  ];
  for (const [key, value] of rows) {
    const row = document.createElement("div");
    const label = document.createElement("span");
    label.className = "key";
    label.textContent = key;
    const text = document.createElement("span");
    text.textContent = value;
    row.append(label, text);
    box.appendChild(row);
  }
  const regrant = $("regrant");
  regrant.hidden = !(kind === "handle" && project.durability?.permission !== "granted");
  regrant.dataset.name = project.name;
}

// ---------------------------------------------------------------- the asset gallery

function renderAsset(asset: { name: string; kind: string; body: string }): void {
  const card = document.createElement("figure");
  card.className = "asset";
  card.dataset.name = asset.name;

  const caption = document.createElement("figcaption");
  caption.textContent = asset.name; // a name, not markup

  if (asset.kind === "svg") {
    const img = document.createElement("img");
    img.alt = asset.name;
    img.src = URL.createObjectURL(new Blob([asset.body], { type: "image/svg+xml" }));
    card.append(img);
  } else {
    const pre = document.createElement("pre");
    pre.className = `kind-${asset.kind}`;
    pre.textContent = asset.body; // text, always — even for kind "html"
    card.append(pre);
  }

  const remove = document.createElement("button");
  remove.className = "delete";
  remove.textContent = "Delete";
  remove.addEventListener("click", async () => {
    const reply = await send({ type: "deleteAsset", name: asset.name });
    if (reply.confirm) askConfirmation(reply.confirm);
    else line(failure(reply), "refused");
  });

  card.append(caption, remove);
  $("gallery").appendChild(card);
}

/**
 * The confirmation prompt: the RESOLVED plan, and a click. M0 can require a click, which is
 * strictly stronger than the spoken confirmation M1 will add (§7).
 */
function askConfirmation(confirm: { id: string; rule: string; why: string; plan: Record<string, any> }): void {
  const box = $("confirm");
  box.textContent = "";
  box.hidden = false;
  const plan = document.createElement("p");
  plan.textContent = `${confirm.plan.kind} ${confirm.plan.target} — ${confirm.why} (rule: ${confirm.rule})`;
  const yes = document.createElement("button");
  yes.id = "confirm-yes";
  yes.textContent = "Yes, delete it";
  const no = document.createElement("button");
  no.id = "confirm-no";
  no.textContent = "No";

  const settle = async (approved: boolean) => {
    box.hidden = true;
    box.textContent = "";
    const reply = await send({ type: "answer", confirmId: confirm.id, approved });
    if (reply.answered === "approved") {
      const card = document.querySelector(`figure.asset[data-name="${CSS.escape(confirm.plan.name)}"]`);
      if (card) card.remove();
      line(`deleted ${confirm.plan.name} (rule: ${confirm.rule})`, "ok");
      void renderView("picked");
    } else {
      line(`kept ${confirm.plan.name} — the confirmation was answered no`, "note");
    }
  };

  yes.addEventListener("click", () => void settle(true));
  no.addEventListener("click", () => void settle(false));
  box.append(plan, yes, no);
}

// ---------------------------------------------------------------- the explorer

const VIEWS = {
  opfs: { panel: "view-opfs", title: "origin storage (OPFS)", note: "one bounded listing" },
  picked: { panel: "view-picked", title: "the picked folder", note: "one bounded listing" },
  server: { panel: "view-server", title: "the server", note: "one HTTP call" },
} as const;

type ViewName = keyof typeof VIEWS;

/**
 * Render one root's listing. ONE message per render: a listing is a listing, not a walk, and the
 * page never turns a directory into a series of `read` turns.
 */
async function renderView(view: ViewName): Promise<Reply> {
  const reply = await send({ type: "listView", view, limit: 200 });
  const panel = $(VIEWS[view].panel);
  panel.textContent = "";

  if (!reply.ok) {
    const failureLine = document.createElement("p");
    failureLine.className = "failure";
    failureLine.textContent = failure(reply); // the code, and the reason, in words
    panel.appendChild(failureLine);
    return reply;
  }

  const where = document.createElement("p");
  where.className = "authority";
  // The ROOT is named in the panel, always: a listing that cannot say what it is showing is the
  // failure this panel exists to prevent (bead 7cd), and "which folder" is the first thing to say.
  where.textContent = `${reply.label ?? ""} — ${reply.authority?.where ?? ""}. Root: ${reply.root ?? "unnamed"}. Visible to: ${
    reply.authority?.whoCanSee ?? ""
  }. ${reply.authority?.needsGesture ? "Re-acquiring access takes a click." : "No gesture needed."} Permission: ${
    reply.permission ?? "implicit"
  }.`;
  panel.appendChild(where);

  const list = document.createElement("ul");
  list.className = "entries";
  for (const entry of reply.entries ?? []) {
    const item = document.createElement("li");
    item.dataset.kind = entry.kind;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.kind === "directory" ? `${entry.name}/` : entry.name; // a name, not markup
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = entry.bytes === undefined ? "" : `${entry.bytes} bytes`;
    item.append(name, size);
    item.addEventListener("click", () => {
      // One more bounded listing per level, never a walk: the page asks for the directory the
      // user clicked and nothing else.
      if (entry.kind === "directory") void renderViewAt(view, [reply.path, entry.name].filter(Boolean).join("/"));
    });
    list.appendChild(item);
  }
  if (!(reply.entries ?? []).length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "empty";
    list.appendChild(empty);
  }
  if (reply.truncated) {
    const more = document.createElement("li");
    more.className = "truncated";
    more.textContent = "…more entries than this listing shows (the listing is bounded on purpose)";
    list.appendChild(more);
  }
  panel.appendChild(list);
  return reply;
}

async function renderViewAt(view: ViewName, path: string): Promise<void> {
  if (view === "server") return; // the server view is flat by design
  const reply = await send({ type: "listView", view, path, limit: 200 });
  const panel = $(VIEWS[view].panel);
  panel.textContent = "";
  if (!reply.ok) {
    const failureLine = document.createElement("p");
    failureLine.className = "failure";
    failureLine.textContent = failure(reply);
    panel.appendChild(failureLine);
    return;
  }
  const list = document.createElement("ul");
  list.className = "entries";
  for (const entry of reply.entries ?? []) {
    const item = document.createElement("li");
    item.dataset.kind = entry.kind;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.kind === "directory" ? `${entry.name}/` : entry.name;
    item.appendChild(name);
    list.appendChild(item);
  }
  panel.appendChild(list);
}

// ---------------------------------------------------------------- the shared view

/**
 * WHO IS HERE, from the log — the live answer N19 asks for, rather than something learned at a merge.
 *
 * Two things this panel refuses to blur. Presence is MEASURED at read time (`state` is the last beat
 * aged against the host's windows), so a stale "ready" cannot read as current; and "has not read
 * this yet" is distinguished from "has not run yet" — an agent with no marks says so in words
 * instead of showing an empty list, which would claim it knew nothing.
 */
async function renderAgents(mark = false): Promise<void> {
  const reply = await send({ type: "look", mark });
  const panel = $("agents");
  panel.textContent = "";
  if (!reply.ok) {
    const failureLine = document.createElement("p");
    failureLine.className = "failure";
    failureLine.textContent = failure(reply);
    panel.appendChild(failureLine);
    return;
  }

  const mine = document.createElement("p");
  mine.className = "authority";
  mine.textContent = `you are '${reply.viewer}'. ${reply.claimed?.length ? `caught up on ${reply.claimed.map((c) => `${c.of}→${c.upto}`).join(", ")}.` : "nothing new to claim."}`;
  panel.appendChild(mine);

  const list = document.createElement("ul");
  list.className = "entries";
  for (const agent of reply.agents ?? []) {
    const doing = (reply.doing ?? []).find((d) => d.instance === agent.instance);
    const knew = (reply.knew ?? []).find((k) => k.instance === agent.instance);
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${agent.instance} — ${agent.state}${doing ? `, ${doing.doing}${doing.current ? "" : " (stale)"}` : ""}`;
    const seen = document.createElement("span");
    seen.className = "size";
    seen.textContent = knew?.mark === null
      ? "has not read anything yet — it has not run"
      : Object.entries(knew?.mark ?? {}).map(([of, upto]) => `read ${of}→${upto}`).join(" ");
    item.append(name, seen);
    list.appendChild(item);
  }
  if (!(reply.agents ?? []).length) {
    const none = document.createElement("li");
    none.className = "empty";
    none.textContent = "no other agent has written here yet";
    list.appendChild(none);
  }
  for (const group of reply.unseen ?? []) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `new from ${group.writer}`;
    const count = document.createElement("span");
    count.className = "size";
    count.textContent = `${group.entries.length} entr${group.entries.length === 1 ? "y" : "ies"}`;
    item.append(name, count);
    list.appendChild(item);
  }
  if (reply.unseen === null) {
    const unknown = document.createElement("li");
    unknown.className = "empty";
    unknown.textContent = "you have not read the log yet — press Catch up";
    list.appendChild(unknown);
  }
  panel.appendChild(list);
}

// ---------------------------------------------------------------- the controls

async function open(name: string): Promise<Reply> {
  const reply = await send({ type: "openProject", name });
  if (!reply.ok) {
    line(failure(reply), "refused");
    return reply;
  }
  header(reply.project);
  line(`opened ${reply.project.id} — root: ${reply.project.root}`, "ok");
  await declareToLoop(reply.project);
  $("gallery").textContent = "";
  for (const asset of reply.assets ?? []) {
    const read = await send({ type: "readFile", path: `assets/${asset}` });
    renderAsset({ name: asset, kind: asset.endsWith(".svg") ? "svg" : asset.endsWith(".html") ? "html" : "text", body: read.text ?? "" });
  }
  await Promise.all([renderView("opfs"), renderView("picked"), renderView("server"), renderAgents(false)]);
  return reply;
}

async function create(name: string, kind: string, body: string): Promise<Reply> {
  const reply = await send({ type: "createAsset", args: { name, kind, body } });
  if (reply.ok) {
    line(`wrote ${reply.path} (${reply.bytes} bytes, rule writes-inside)`, "ok");
    renderAsset({ name, kind, body });
    void renderView("opfs");
    void renderView("picked");
  } else if (reply.refused) {
    // A refusal prints its rule and its why — the transcript line the user sees, not "denied".
    line(`refused: ${reply.rule} — ${reply.why}`, "refused");
  } else {
    line(failure(reply), "refused");
    if (reply.code === "needs-gesture") $("regrant").hidden = false;
  }
  return reply;
}

/**
 * Tell the loop which root this project is on. Whichever kind it is, the loop learns it — and learns
 * by name if it cannot act there. This is the page's half of the seam: without it the loop keeps
 * writing into whatever root was declared last, which is how two roots come back.
 */
async function declareToLoop(project: Record<string, any>): Promise<void> {
  const kind = project.rootKind ?? project.location?.kind ?? "opfs";
  const root =
    kind === "machine" ? { kind, path: String(project.root) }
    : kind === "handle" ? { kind, id: String(project.name) }
    : { kind: "opfs", path: String(project.root) };
  try {
    const response = await fetch("/api/root", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: project.name, root }),
    });
    const body = await response.json();
    line(
      body.reachableFromThisProcess
        ? `the loop will write into ${body.root?.path}`
        : `the loop cannot write here — ${body.why ?? body.refused ?? "no reason given"}`,
      body.reachableFromThisProcess ? "ok" : "note",
    );
  } catch {
    line("the loop was not told about this root (no server reachable from the page)", "note");
  }
}

/**
 * Declare a root on the machine's filesystem. The point is not that this page can write there — it
 * cannot — but that the LOOP writes into THIS project's root instead of a folder of its own, which is
 * what makes it one root rather than two.
 */
async function useMachineRoot(path: string, name = "loop-project"): Promise<Reply> {
  const reply = await send({ type: "useMachineRoot", path, name });
  if (!reply.ok) {
    line(failure(reply), "refused");
    return reply;
  }
  header(reply.project);
  line(
    `the loop now writes into ${reply.root.path}${reply.canonical ? " (resolved to its real path)" : ""} — acts on this root come from the machine, not this page`,
    "ok",
  );
  await Promise.all([renderView("opfs"), renderView("picked"), renderView("server"), renderAgents(false)]);
  return reply;
}

/** A picked root is adopted through the platform's own gesture, or by dropping a folder. */
async function adopt(handle: FileSystemDirectoryHandle): Promise<Reply> {
  const name = handle.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "picked";
  const reply = await send({ type: "adoptPickedProject", name, handle });
  if (!reply.ok) {
    line(failure(reply), "refused");
    return reply;
  }
  header(reply.project);
  line(
    `adopted '${handle.name}' as '${reply.project.id}' — the handle is persisted, permission is ${reply.permission}`,
    "ok",
  );
  if (reply.needsGesture) {
    line(
      "this folder can be read now: writing it needs one click on 'Restore write access', because the browser reports 'prompt' and only a gesture can change that",
      "note",
    );
  }
  await declareToLoop({ ...reply.project, rootKind: "handle", name: reply.project.name });
  await Promise.all([renderView("opfs"), renderView("picked"), renderView("server")]);
  return reply;
}

$("open-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = ($("project-name") as HTMLInputElement).value.trim();
  if (name) void open(name);
});

$("asset-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void create(
    ($("asset-name") as HTMLInputElement).value,
    ($("asset-kind") as HTMLSelectElement).value,
    ($("asset-body") as HTMLTextAreaElement).value,
  );
});

$("pick").addEventListener("click", async () => {
  if (!("showDirectoryPicker" in window)) {
    line("needs-gesture is not available: this browser has no showDirectoryPicker, so only OPFS projects are possible here", "refused");
    return;
  }
  try {
    const handle = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> })
      .showDirectoryPicker({ mode: "readwrite" });
    await adopt(handle);
  } catch (e) {
    const error = e as Error;
    line(`no folder adopted (${error?.name ?? "error"}: ${error?.message ?? ""})`, "note");
  }
});

$("regrant").addEventListener("click", async () => {
  const name = $("regrant").dataset.name;
  if (!name) return;
  const handle = await getHandle(name);
  if (!handle) {
    line(failure(await send({ type: "handleState", name })), "refused");
    return;
  }
  const state = await handle.requestPermission({ mode: "readwrite" });
  const reply = await send({ type: "regrantPicked", name, handle });
  if (!reply.ok) line(failure(reply), "refused");
  else {
    line(`write access to '${handle.name}' is ${state}`, "ok");
    header(reply.project);
  }
});

const dropzone = $("dropzone");
dropzone.addEventListener("dragover", (event) => event.preventDefault());
dropzone.addEventListener("drop", async (event) => {
  event.preventDefault();
  const item = (event as DragEvent).dataTransfer?.items?.[0];
  if (!item?.getAsFileSystemHandle) {
    line("that drop carried no directory handle — drop a folder, not a file", "refused");
    return;
  }
  const handle = await item.getAsFileSystemHandle();
  if (!handle || handle.kind !== "directory") {
    line("that drop was a file; a project root is a folder", "refused");
    return;
  }
  await adopt(handle as FileSystemDirectoryHandle);
});

// The programmatic surface the acceptance checks drive — the same worker the controls call.
$("catch-up").addEventListener("click", () => void renderAgents(true));

$("machine-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const path = ($("machine-path") as HTMLInputElement).value.trim();
  if (path) void useMachineRoot(path, ($("project-name") as HTMLInputElement).value.trim() || "loop-project");
});

const api = { ready: send({ type: "hello" }), send, open, create, adopt, useMachineRoot, renderView, renderAgents, header, line };
(window as unknown as Record<string, unknown>).e1m0 = api;
document.documentElement.dataset.e1m0 = "ready";
api.ready.then((reply: Reply) =>
  line(`host ready — instance ${reply.instance}, durability ${reply.durability?.persisted ? "persisted" : "not persisted"}`),
);
