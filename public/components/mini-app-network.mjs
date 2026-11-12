/**
 * @summary The room's side of the Mini-App network policy: remembered approvals, the Allow/Keep offline prompt and the blocked-load notice.
 */
// MINI-APP NETWORK ACCESS, DECIDED BY A PERSON (voicebox-beads-cwx5.16).
//
// A Mini-App runs with no network unless it declares the origins it needs (public/app-network-policy.mjs). A
// declaration is written by the app's author — often a model — so it is a REQUEST. This module is where the
// request is answered:
//
//   * `grantFor(appId, html)` reads the request and returns the grant the bridge may apply: the declared
//     origins if a person approved exactly this set for this app before, otherwise nothing.
//   * `ask(...)` shows a bar in the app card, outside the app's frame, naming every origin. Allow remembers
//     the approval and the caller remounts the app with it; Keep offline leaves the app running without.
//   * `blocked(origin)` shows which origin a running app was stopped from reaching, so an app that needs an
//     undeclared CDN says so instead of just looking broken.
//
// An approval is stored per app AND per exact origin set. If the app's file changes what it asks for, the old
// approval no longer matches and the person is asked again.
import { networkRequestKey, readAppNetworkRequest } from "../app-network-policy.mjs";

export const NETWORK_APPROVALS_KEY = "voicebox.mini_app_network_approvals.v1";
/** Approvals kept; the oldest is dropped past this. */
const MAX_APPROVALS = 64;

const hostOf = (origin) => String(origin).replace(/^[a-z]+:\/\//, "");

export function createMiniAppNetwork({ getHost, storage = globalThis.localStorage, doc = globalThis.document }) {
  let bar = null;
  let notice = null;
  const blockedOrigins = new Set();
  let declarationProblems = [];
  // "Keep offline" lasts for this page: asking again on every reload of the same app would train the click.
  const declinedThisSession = new Set();

  function readApprovals() {
    try {
      const parsed = JSON.parse(storage?.getItem(NETWORK_APPROVALS_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  function writeApproval(appId, key) {
    const approvals = readApprovals();
    delete approvals[appId];
    approvals[appId] = key; // re-inserted last, so the oldest key is first
    const ids = Object.keys(approvals);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_APPROVALS))) delete approvals[id];
    try { storage?.setItem(NETWORK_APPROVALS_KEY, JSON.stringify(approvals)); return true; } catch { return false; }
  }

  /** What this app asks for, whether a person already approved exactly that, and the grant to hand the bridge. */
  function grantFor(appId, html) {
    const request = readAppNetworkRequest(html);
    const key = networkRequestKey(request);
    const approved = request.declared && readApprovals()[appId] === key;
    return {
      request,
      approved,
      declined: declinedThisSession.has(`${appId}|${key}`),
      network: approved
        ? { connectDomains: request.connectDomains, resourceDomains: request.resourceDomains }
        : { connectDomains: [], resourceDomains: [] },
    };
  }

  function clear() {
    bar?.remove?.(); bar = null;
    notice?.remove?.(); notice = null;
    blockedOrigins.clear();
    declarationProblems = [];
  }

  function element(tag, className, text) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /** Ask the person. `onAllow` runs after the approval is stored; the caller remounts the app with the grant. */
  function ask({ appId, title, request, onAllow }) {
    const host = getHost();
    if (!host || !request?.declared) return;
    bar?.remove?.();
    bar = element("div", "mini-app-consent mini-app-network-ask");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Network access request");
    const what = element("p", "mini-app-consent-what");
    what.append(element("strong", "", String(title || appId || "This app")), doc.createTextNode(" asks to use the network. It is running offline until you allow it."));
    const lines = [];
    if (request.connectDomains.length) lines.push(`Send and receive data: ${request.connectDomains.map(hostOf).join(", ")}`);
    if (request.resourceDomains.length) lines.push(`Load scripts, styles, images and fonts: ${request.resourceDomains.map(hostOf).join(", ")}`);
    const detail = element("p", "mini-app-consent-detail", lines.join(" · "));
    const actions = element("div", "mini-app-consent-actions");
    const allow = element("button", "mini-app-consent-allow", "Allow");
    const deny = element("button", "mini-app-consent-deny", "Keep offline");
    allow.type = "button"; deny.type = "button";
    actions.append(allow, deny);
    bar.append(what, detail, actions);
    host.prepend(bar);
    const key = networkRequestKey(request);
    allow.addEventListener("click", () => {
      writeApproval(appId, key);
      declinedThisSession.delete(`${appId}|${key}`);
      bar?.remove?.(); bar = null;
      onAllow?.();
    });
    deny.addEventListener("click", () => {
      declinedThisSession.add(`${appId}|${key}`);
      bar?.remove?.(); bar = null;
    });
  }

  function renderNotice() {
    const host = getHost();
    if (!host) return;
    notice?.remove?.();
    const lines = [];
    if (blockedOrigins.size) {
      lines.push(`Blocked: this app tried to reach ${[...blockedOrigins].map(hostOf).join(", ")}. A Mini-App has no network access unless it declares the domain and you allow it.`);
    }
    for (const problem of declarationProblems.slice(0, 4)) lines.push(`Network declaration ignored: ${problem}`);
    if (!lines.length) { notice = null; return; }
    notice = element("div", "mini-app-network-notice");
    notice.setAttribute("role", "status");
    notice.append(element("p", "mini-app-consent-detail", lines.join(" ")));
    const dismiss = element("button", "mini-app-network-dismiss", "Dismiss");
    dismiss.type = "button";
    dismiss.addEventListener("click", () => { notice?.remove?.(); notice = null; });
    notice.append(dismiss);
    // After the Allow bar when there is one: the question stays on top.
    if (bar && bar.parentNode === host) bar.after(notice); else host.prepend(notice);
  }

  /** A running app was stopped from reaching `origin`. */
  function blocked(origin) {
    if (typeof origin !== "string" || !origin || blockedOrigins.has(origin) || blockedOrigins.size >= 8) return;
    blockedOrigins.add(origin);
    renderNotice();
  }

  /** Entries in the app's declaration that were refused, shown so its author can fix them. */
  function problems(list) {
    if (!Array.isArray(list) || !list.length) return;
    declarationProblems = list.map(String);
    renderNotice();
  }

  return { grantFor, ask, blocked, problems, clear };
}
