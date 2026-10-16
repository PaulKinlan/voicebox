// tests/lib/css-bundle.mjs — load and concatenate composed CSS stylesheets (voicebox-beads-4gyw)
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PUBLIC = path.join(ROOT, "public");

/**
 * Recursively resolves @import rules to return the fully composed CSS stylesheet text.
 */
export function readComposedCss(filePath = path.join(PUBLIC, "style.css")) {
  const content = readFileSync(filePath, "utf8");
  const dir = path.dirname(filePath);
  return content.replace(/@import\s+(?:url\()?["']([^"']+)["']\)?\s*;/g, (_match, relPath) => {
    const targetPath = path.resolve(dir, relPath);
    if (existsSync(targetPath)) {
      return readComposedCss(targetPath);
    }
    return "";
  });
}
