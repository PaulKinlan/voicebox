// The room's file list: native read/filter/folder controls plus width/theme coverage.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const longName = "meeting-notes-and-follow-up-actions-for-the-next-project-planning-session.txt";

test("room explorer: scannable rows, native actions, narrow containers and both themes", { timeout: 60000 }, async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-room-explorer-"));
  const root = path.join(scratch, "project");
  const extensions = path.join(scratch, "extensions");
  mkdirSync(root);
  writeFileSync(path.join(root, longName), "A real, long-named file.\n");
  for (let i = 0; i < 14; i++) writeFileSync(path.join(root, `notes-${i}.txt`), `Note ${i}\n`);
  mkdirSync(path.join(root, "drafts"));
  const evidence = process.env.VOICEBOX_EXPLORER_EVIDENCE;
  if (evidence) mkdirSync(evidence, { recursive: true });
  let server, page;
  const observations = [];
  const failures = [];
  const screen = async (name) => { if (evidence) await page.screenshot(path.join(evidence, name + ".png")); };
  try {
    server = await startServer({ extensionsDir: extensions, env: { VOICEBOX_WORKSPACE: root } });
    page = await launch({ width: 1200, height: 1000 });
    await page.goto(server.base);
    await page.waitFor(() => document.querySelector(".file-open[data-file='notes-0.txt']"));
    await page.type("#file-filter", "notes-0");
    await page.waitFor(() => document.querySelectorAll(".file-open").length === 1);
    await page.click(".file-open[data-file='notes-0.txt']");
    await page.waitFor(() => document.querySelector("#file-body").textContent === "Note 0\n");
    assert.equal(await page.evaluate(() => document.querySelector(".file-open[data-file='notes-0.txt']").getAttribute("aria-current")), "true");
    await screen("native-read");
    await page.type("#file-filter", "there-is-no-such-file");
    await page.waitFor(() => document.querySelector("#list-bound").textContent.includes("No file here matches"));
    assert.equal(await page.evaluate(() => document.querySelectorAll(".file-open").length), 0);
    await screen("no-matches");
    await page.type("#file-filter", "");
    await page.click("#reader-close");

    // Seed real origin storage through the existing folder API, not fake permission answers.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for (const name of ["first-folder", "another-folder-with-a-long-descriptive-name"]) {
        const folder = await root.getDirectoryHandle(name, { create: true });
        const file = await folder.getFileHandle("from-folder.txt", { create: true });
        const writer = await file.createWritable();
        await writer.write(name); await writer.close();
        await window.__voiceboxAdoptFolder(folder);
      }
    });
    await page.click("[data-folder='first-folder'] .folder-select-btn");
    await page.click(".file-open[data-file='from-folder.txt']");
    await page.waitFor(() => document.querySelector("#file-body").textContent === "first-folder");
    await screen("native-folder-read");
    await page.click("#reader-close");
    await page.click("#close-folder");
    await page.waitFor(() => document.querySelector(".file-open[data-file='notes-0.txt']"));

    await page.waitFor(() => !document.querySelector(".file-open[data-arrived]"), { timeout: 5000 });
    for (const theme of ["light", "dark"]) {
      for (const [name, width, container] of [["desktop", 1200, ""], ["narrow-container", 1200, "320px"], ["phone", 390, ""]]) {
        await page.emulateViewport({ width, height: 900, mobile: false, scale: 1 });
        await page.evaluate((theme, size) => {
          document.documentElement.dataset.theme = theme;
          document.querySelector("#made-list").style.inlineSize = size;
          document.querySelector("#made-list").scrollIntoView({ block: "start" });
        }, theme, container);
        await screen(`${theme}-${name}`);
        const layout = await page.evaluate(() => {
          const made = document.querySelector("#made-list"), list = document.querySelector("#files");
          const box = made.getBoundingClientRect();
          return {
            width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
            containerWidth: box.width, columns: getComputedStyle(list).gridTemplateColumns, display: getComputedStyle(list).display,
            listHeight: list.getBoundingClientRect().height, viewportHeight: innerHeight,
            chipBackground: getComputedStyle(document.querySelector(".folder-chip")).backgroundColor,
            rows: [...document.querySelectorAll(".file-open")].map(el => {
              const r = el.getBoundingClientRect(), meta = el.querySelector(".file-meta").getBoundingClientRect();
              return { name: el.dataset.file, height: r.height, inside: r.left >= box.left - 1 && r.right <= box.right + 1,
                metadataInside: meta.right <= r.right + 1, text: el.querySelector(".file-name").textContent };
            }),
          };
        });
        observations.push({ theme, name, ...layout });
        if (layout.overflow) failures.push(`${theme}/${name}: horizontal document overflow`);
        if (layout.display !== "grid") failures.push(`${theme}/${name}: file names do not share a grid`);
        if (layout.listHeight > Math.min(layout.viewportHeight * .4, 384) + 1) failures.push(`${theme}/${name}: list pushes the room away instead of scrolling`);
        if (layout.containerWidth >= 576 && layout.columns.split(" ").length !== 2) failures.push(`${theme}/${name}: wide component did not choose two columns`);
        if (layout.rows.some(row => row.height < 44 || !row.inside || !row.metadataInside)) failures.push(`${theme}/${name}: a file row is clipped or below a 44px hit target`);
        assert(layout.rows.some(row => row.name === longName && row.text === longName), "long names stay verbatim");
        if (layout.containerWidth <= 400 && layout.columns.split(" ").length !== 1) failures.push(`${theme}/${name}: narrow component did not choose one column`);
      }
    }
    assert.notEqual(observations.find(o => o.theme === "light").chipBackground, observations.find(o => o.theme === "dark").chipBackground, "folder chips follow the selected theme");
    await page.click(".file-open[data-file='notes-9.txt']");
    await page.waitFor(() => document.querySelector("#file-body").textContent === "Note 9\n");
    await page.click("#reader-close");
    // A newly created file still gets its real arrival marker; no synthetic attribute.
    writeFileSync(path.join(root, "arrived.txt"), "new file\n");
    await page.click("#refresh");
    await page.waitFor(() => document.querySelector(".file-open[data-file='arrived.txt'][data-arrived='true']"));
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".file-open[data-file='arrived.txt']")).animationName), "none");
    await page.waitFor(() => !document.querySelector(".file-open[data-file='arrived.txt']").hasAttribute("data-arrived"), { timeout: 5000 });
    // Native keyboard focus/activation, not element.click().
    await page.type("#file-filter", "notes-0");
    await page.press("Tab");
    for (let i = 0; i < 10 && !(await page.evaluate(() => document.activeElement?.matches(".file-open"))); i++) await page.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.file), "notes-0.txt");
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "none");
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.waitFor(() => document.querySelector("#file-body").textContent === "Note 0\n");
    await screen("keyboard-read");
    await page.click("#reader-close");
    await page.type("#file-filter", "");
    const emptyRoot = path.join(scratch, "empty-project");
    mkdirSync(emptyRoot);
    const headers = { "content-type": "application/json", "x-voicebox-host-token": server.hostToken };
    assert.equal((await fetch(server.base + "/api/root", { method: "POST", headers, body: JSON.stringify({ project: "empty", root: { kind: "machine", path: emptyRoot } }) })).status, 200);
    await page.click("#refresh");
    await page.waitFor(() => document.querySelector("#made-list").dataset.state === "empty");
    await page.evaluate(() => document.querySelector("#made-list").scrollIntoView({ block: "start" }));
    await screen("empty-project");
    // Close the persisted browser folders too: otherwise reload truthfully restores one,
    // and a hidden server-root remedy is not evidence of a visible no-project state.
    while (await page.evaluate(() => document.querySelector(".folder-close-btn") !== null)) await page.click(".folder-close-btn");
    assert.equal((await fetch(server.base + "/api/root", { method: "DELETE", headers })).status, 200);
    await page.reload();
    await page.waitFor(() => document.querySelector("#empty-link").checkVisibility());
    assert.match(await page.evaluate(() => document.querySelector("#empty-link").getAttribute("href")), /environment\.html/);
    await page.evaluate(() => document.querySelector("#made-list").scrollIntoView({ block: "start" }));
    await screen("no-project");
    await page.click("#empty-link");
    await page.waitFor(() => location.pathname === "/environment.html");
    assert.deepEqual(failures, []);
  } finally {
    if (evidence) writeFileSync(path.join(evidence, "layout.json"), JSON.stringify({ observations, failures }, null, 2) + "\n");
    await page?.close();
    if (server) { const exited = once(server.child, "exit"); await server.stop(); await exited; }
    rmSync(scratch, { recursive: true, force: true });
  }
});
