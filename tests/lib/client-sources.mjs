// tests/lib/client-sources.mjs — the browser client's sources as ONE searchable set (voicebox-beads-uei2.14).
//
// WHY THIS EXISTS. A pin written as `readFileSync("public/fused.js")` is coupled to a FILE, not to the fact it
// asserts. When a slice extracts that code into `public/components/*.mjs` — as voicebox-beads-uei2.7 and
// voicebox-beads-uei2.10 did, with more coming — the pin breaks while the behaviour is unchanged. That is a
// landmine: it turns a correct refactor red and pushes the next lane into editing an unrelated test.
//
// The rule this helper exists to support: a wiring FACT should survive its code moving between client files.
// Assertions search the whole client source set, and strength comes from the MARKER being specific (a named
// key, an exact guard), never from the marker happening to live in fused.js. This is the same correction
// `tests/icon-sprite.test.mjs` needed for voicebox-beads-uei2.7, generalised so the next pin cannot repeat it.
//
// The file set is discovered by GLOB, never a hardcoded list, for the same reason: a list is one more thing to
// forget when a slice adds a module.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

/** Every client source: public/*.js and public/*.mjs plus public/components/*.mjs, sorted for stable output. */
export function clientSourcePaths(root) {
  const publicDir = path.join(root, "public");
  const dirs = [publicDir, path.join(publicDir, "components")];
  const files = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      // Directories (the `components` entry itself) and non-JS files fall out here: it is a name filter,
      // so there is no list of files to forget when a slice adds a module.
      if (!/\.m?js$/.test(name)) continue;
      if (name.endsWith(".min.js") || name.endsWith(".min.mjs")) continue;
      files.push(path.join(dir, name));
    }
  }
  return files;
}

/** The same set with their text, as { file, text } where file is relative to the repository root. */
export function clientSources(root) {
  return clientSourcePaths(root).map((file) => ({ file: path.relative(root, file), text: readFileSync(file, "utf8") }));
}

/** Every client source whose text matches. A global regex is re-created per file so lastIndex cannot leak. */
export function findInClientSources(root, pattern) {
  const flags = pattern.flags.replace(/g/g, "");
  return clientSources(root)
    .filter(({ text }) => new RegExp(pattern.source, flags).test(text))
    .map(({ file }) => file);
}

/** Every match of a pattern across the client sources, with the file it came from. */
export function matchInClientSources(root, pattern) {
  const flags = `${pattern.flags.replace(/g/g, "")}g`;
  const out = [];
  for (const { file, text } of clientSources(root)) {
    const re = new RegExp(pattern.source, flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      out.push({ file, match });
      if (match[0] === "") break;
    }
  }
  return out;
}

/**
 * Assert the fact is present somewhere in the client sources, and say where.
 *
 * `message` is the FACT being asserted, phrased so a failure reads: "<fact> — not found in any client source
 * (fused.js, public/*.mjs, public/components/*.mjs): searched N files".
 */
export function assertInClientSources(root, pattern, message) {
  const files = clientSourcePaths(root);
  const where = findInClientSources(root, pattern);
  assert.ok(
    where.length > 0,
    `${message} — not found in any client source (${files.length} searched: fused.js, public/*.mjs, public/components/*.mjs)`,
  );
  return where;
}

/** The number of matches across the client sources — for wiring facts that must be wired exactly once. */
export function countInClientSources(root, pattern) {
  return matchInClientSources(root, pattern).length;
}

/**
 * The brace-matched body of a function DECLARATION, found in any client source.
 *
 * For a pin that is scoped to a code REGION — `fused.slice(fused.indexOf("function a"), fused.indexOf("function b"))`
 * is the worst offender, because moving either neighbour breaks it — the extraction-proof equivalent is "this fact
 * is inside that function", located wherever the function now lives. The body is brace-matched, so the assertion
 * keeps the function-level scoping it had, and gains independence from whichever function comes next.
 */
export function functionBodyInClientSources(root, name) {
  const declaration = new RegExp(`(?:^|\\n)[ \\t]*(?:async[ \\t]+)?function[ \\t]+${name}[ \\t]*\\(`, "");
  for (const { file, text } of clientSources(root)) {
    const match = declaration.exec(text);
    if (!match) continue;
    const open = text.indexOf("{", match.index + match[0].length);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return { file, body: text.slice(open, i + 1) };
      }
    }
  }
  return null;
}

/** Assert a fact holds inside a named function's body, wherever that function lives. */
export function assertInFunctionBody(root, name, pattern, message) {
  const found = functionBodyInClientSources(root, name);
  assert.ok(found, `${name}() is no longer declared in any client source (fused.js, public/*.mjs, public/components/*.mjs)`);
  assert.match(found.body, pattern, `${message} — inside ${name}() in ${found.file}`);
  return found.file;
}

/** The negative form: the fact must NOT hold anywhere inside a named function's body. */
export function assertAbsentInFunctionBody(root, name, pattern, message) {
  const found = functionBodyInClientSources(root, name);
  assert.ok(found, `${name}() is no longer declared in any client source (fused.js, public/*.mjs, public/components/*.mjs)`);
  assert.doesNotMatch(found.body, pattern, `${message} — inside ${name}() in ${found.file}`);
  return found.file;
}
