import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("footer prose moved into #status-help-popover and Help dialog is centered with blurred backdrop", () => {
  const html = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const css = readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
  const fused = readFileSync(path.join(ROOT, "public", "fused.js"), "utf8");

  // 1. <footer class="foot"> no longer contains the two turns/tools prose lines, but keeps #build.
  const footerMatch = html.match(/<footer\s+class="foot"[\s\S]*?<\/footer>/);
  assert.ok(footerMatch, '<footer class="foot"> exists in public/index.html');
  const footerHtml = footerMatch[0];
  assert.doesNotMatch(
    footerHtml,
    /Typed turns go to the local server/,
    "footer no longer repeats typed turns explanation",
  );
  assert.doesNotMatch(
    footerHtml,
    /Live voice runs through the same server/,
    "footer no longer repeats live voice tools explanation",
  );
  assert.match(footerHtml, /id="build"/, "footer preserves the #build stamp element");

  // 2. #status-help-backdrop exists and #status-help-popover contains both turns/tools explanations.
  assert.match(
    html,
    /<div\s+class="help-modal-backdrop"\s+id="status-help-backdrop"\s+hidden\s+aria-hidden="true"><\/div>/,
    "#status-help-backdrop is rendered right before #status-help-popover",
  );
  const helpStart = html.indexOf('id="status-help-popover"');
  const helpEnd = html.indexOf('<dialog class="envs" id="exts"');
  assert.ok(helpStart !== -1 && helpEnd > helpStart, "#status-help-popover section exists before #exts dialog");
  const helpHtml = html.slice(helpStart, helpEnd);
  assert.match(
    helpHtml,
    /Typed turns go to the local server, which reads and writes the project folder when the folder is one it can reach\./,
    "#status-help-popover contains the typed turns explanation",
  );
  assert.match(
    helpHtml,
    /Live voice runs through the same server and uses the same tools, so the model can write files while you talk/,
    "#status-help-popover contains the live voice tools explanation",
  );

  // 3. CSS centers .status-help-popover and blurs .help-modal-backdrop like other dialogs.
  const backdropBlock = css.match(/\.help-modal-backdrop\s*\{[^}]*\}/);
  assert.ok(backdropBlock, ".help-modal-backdrop rule exists in public/style.css");
  assert.match(backdropBlock[0], /position:\s*fixed/, ".help-modal-backdrop uses position: fixed");
  assert.match(backdropBlock[0], /backdrop-filter:\s*blur\(10px\)/, ".help-modal-backdrop applies backdrop-filter: blur(10px)");

  const popoverBlock = css.match(/\.status-help-popover\s*\{[^}]*\}/);
  assert.ok(popoverBlock, ".status-help-popover rule exists in public/style.css");
  assert.match(popoverBlock[0], /position:\s*fixed/, ".status-help-popover uses position: fixed");
  assert.match(popoverBlock[0], /inset-block-start:\s*50%/, ".status-help-popover sets inset-block-start: 50%");
  assert.match(popoverBlock[0], /inset-inline-start:\s*50%/, ".status-help-popover sets inset-inline-start: 50%");
  assert.match(popoverBlock[0], /transform:\s*translate\(-50%,\s*-50%\)/, ".status-help-popover centers with translate(-50%, -50%)");

  // 4. fused.js wires statusHelpBackdrop in WANTED and setHelpOpen.
  assert.match(fused, /statusHelpBackdrop:\s*"status-help-backdrop"/, "fused.js declares statusHelpBackdrop in WANTED");
  assert.match(fused, /if\s*\(els\.statusHelpBackdrop\)\s*els\.statusHelpBackdrop\.hidden\s*=\s*!open;/, "setHelpOpen toggles statusHelpBackdrop.hidden");
});
