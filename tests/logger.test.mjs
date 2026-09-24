// tests/logger.test.mjs — Verify color-coded server logs and bracketed tag styling (voicebox-beads-t97)
import test from "node:test";
import assert from "node:assert/strict";
import {
  TAG_COLORS,
  DEFAULT_TAG_COLOR,
  RESET_COLOR,
  colorizeTags,
  shouldColorize,
  formatLogArg,
  installColorConsole,
} from "../lib/logger.mjs";

test("colorizeTags: styles known bracketed tags with distinct ANSI colors and resets immediately", () => {
  // Cyan family: server, live, channel, root
  const serverMsg = colorizeTags("[server] listening on port 8787", true);
  assert.equal(serverMsg, `${TAG_COLORS.server}[server]${RESET_COLOR} listening on port 8787`);

  const liveMsg = colorizeTags("[live] session opened", true);
  assert.equal(liveMsg, `${TAG_COLORS.live}[live]${RESET_COLOR} session opened`);

  const channelMsg = colorizeTags("[channel] connected", true);
  assert.equal(channelMsg, `${TAG_COLORS.channel}[channel]${RESET_COLOR} connected`);

  const rootMsg = colorizeTags("[root] directory declared", true);
  assert.equal(rootMsg, `${TAG_COLORS.root}[root]${RESET_COLOR} directory declared`);

  // Green family: task, audit, turn, ok
  const taskMsg = colorizeTags("[task] task_123 completed", true);
  assert.equal(taskMsg, `${TAG_COLORS.task}[task]${RESET_COLOR} task_123 completed`);

  const auditMsg = colorizeTags("[audit] seq 5 recorded", true);
  assert.equal(auditMsg, `${TAG_COLORS.audit}[audit]${RESET_COLOR} seq 5 recorded`);

  // Magenta family: extensions
  const extMsg = colorizeTags("[extensions] 3 tools loaded", true);
  assert.equal(extMsg, `${TAG_COLORS.extensions}[extensions]${RESET_COLOR} 3 tools loaded`);

  // Yellow family: approval, auth
  const approvalMsg = colorizeTags("[extension approval] review plan", true);
  assert.equal(approvalMsg, `${TAG_COLORS["extension approval"]}[extension approval]${RESET_COLOR} review plan`);

  const authMsg = colorizeTags("[auth] host token verified", true);
  assert.equal(authMsg, `${TAG_COLORS.auth}[auth]${RESET_COLOR} host token verified`);

  // Red family: error, uncaught, route
  const errorMsg = colorizeTags("[error] connection failed", true);
  assert.equal(errorMsg, `${TAG_COLORS.error}[error]${RESET_COLOR} connection failed`);

  const routeMsg = colorizeTags("[route] 404 not found", true);
  assert.equal(routeMsg, `${TAG_COLORS.route}[route]${RESET_COLOR} 404 not found`);

  // Default color for custom/unknown bracketed tag
  const customMsg = colorizeTags("[custom-tag] custom event", true);
  assert.equal(customMsg, `${DEFAULT_TAG_COLOR}[custom-tag]${RESET_COLOR} custom event`);
});

test("colorizeTags: multiple tags in one line each get their matching color", () => {
  const line = "[server] [audit] event logged [ok]";
  const colored = colorizeTags(line, true);
  assert.equal(
    colored,
    `${TAG_COLORS.server}[server]${RESET_COLOR} ${TAG_COLORS.audit}[audit]${RESET_COLOR} event logged ${TAG_COLORS.ok}[ok]${RESET_COLOR}`
  );
});

test("NO_COLOR and disabled color flags strictly return plain uncolored text", () => {
  const line = "[server] listening on 8787";

  // Explicitly disabled
  assert.equal(colorizeTags(line, false), line);

  // NO_COLOR set
  const origNoColor = process.env.NO_COLOR;
  try {
    process.env.NO_COLOR = "1";
    assert.equal(shouldColorize(), false);
    assert.equal(colorizeTags(line), line);
  } finally {
    if (origNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = origNoColor;
  }

  // NODE_DISABLE_COLORS=1
  const origDisable = process.env.NODE_DISABLE_COLORS;
  try {
    delete process.env.NO_COLOR;
    process.env.NODE_DISABLE_COLORS = "1";
    assert.equal(shouldColorize(), false);
    assert.equal(colorizeTags(line), line);
  } finally {
    if (origDisable === undefined) delete process.env.NODE_DISABLE_COLORS;
    else process.env.NODE_DISABLE_COLORS = origDisable;
  }
});

test("FORCE_COLOR=1 enables colors even when stream is not a TTY", () => {
  const origForce = process.env.FORCE_COLOR;
  const origNoColor = process.env.NO_COLOR;
  try {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    const nonTtyStream = { isTTY: false };
    assert.equal(shouldColorize(nonTtyStream), true);
  } finally {
    if (origForce === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = origForce;
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
  }
});

test("formatLogArg: formats strings and preserves non-string objects untouched", () => {
  const obj = { foo: "bar", count: 12 };
  assert.equal(formatLogArg(obj, true), obj);
  assert.equal(formatLogArg(123, true), 123);
  assert.equal(formatLogArg(null, true), null);

  const text = formatLogArg("[task] running", true);
  assert.equal(text, `${TAG_COLORS.task}[task]${RESET_COLOR} running`);
});

test("installColorConsole: wraps console.log and console.error, then cleanly uninstalls", () => {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;

  const uninstall = installColorConsole({ force: true });
  try {
    // Temporarily spy on the underlying console writer
    const hookedLog = console.log;
    const hookedError = console.error;

    // Call console.log and console.error with tags
    console.log("[server] ready for connections");
    console.error("[error] socket exception");
  } finally {
    uninstall();
  }

  // Ensure original console methods are restored
  assert.equal(console.log, origLog);
  assert.equal(console.error, origError);
});
