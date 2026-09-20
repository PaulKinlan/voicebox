#!/usr/bin/env sh
# Prove the generated tool blocks go RED when a tool is added, removed or renamed, when a primitive's
# interface changes, when the live model starts declaring tools, when the /live handler is wired to the
# executor, when a new env var is read, or when a refusal is renamed — and GREEN again when each
# mutation is reverted byte-exact. A generated-blocks check that cannot fail is a description, not a check.
#
#   sh docs/evidence/tools-readme-20260920/mutate.sh      # from the repo root, on a CLEAN tree
set -u
run() { node scripts/docs-check.mjs >/tmp/docs-check.out 2>&1; echo $?; }
mut() { a=$(run); reason=$(grep -m1 -E 'FAILED|no generated block|undefined|EMPTY|Error' /tmp/docs-check.out | cut -c1-72); }
report() { printf '%-46s mutated: exit %s (%s) | restored: exit %s\n' "$1" "$a" "${reason:-no failure line}" "$b"; }
[ "$(git status --porcelain | wc -l)" = 0 ] || { echo "tree is not clean — refusing to mutate it"; exit 2; }
echo "tree: $(git rev-parse --short HEAD)   baseline: exit $(run)"

printf '%s' '{"id":"mutant","name":"Mutant","description":"","source":"catalogue","runsIn":"host","capabilities":[],"bounds":{},"tools":[{"name":"mutant_now","description":"","primitive":"now","params":{}}]}' > catalogue/mutant.json
mut; rm -f catalogue/mutant.json; b=$(run); report "1 tool ADDED (catalogue/mutant.json)"

mv -f catalogue/notes.json /tmp/notes.json.mut
mut; mv -f /tmp/notes.json.mut catalogue/notes.json; b=$(run); report "2 tool REMOVED (catalogue/notes.json)"

sed -i 's/"read_notes"/"read_note"/' catalogue/notes.json
mut; git checkout -q -- catalogue/notes.json; b=$(run); report "3 tool RENAMED (read_notes -> read_note)"

sed -i 's/read: "a root-scoped read function/read: "an unscoped read function/' core/extensions.ts
mut; git checkout -q -- core/extensions.ts; b=$(run); report "4 primitive interface CHANGED (GETS.read)"

sed -i 's/^      setup: {$/      setup: { tools: [{ functionDeclarations: [{ name: "mutant_tool" }] }],/' lib/live-providers/gemini.mjs
mut; git checkout -q -- lib/live-providers/gemini.mjs; b=$(run); report "5 live handshake DECLARES a tool (gemini)"

sed -i 's/^      if (msg?.type === "stop") { session.close(); ws.close(); }$/      if (msg?.type === "act") { void execute({ verb: "list" }); }\n&/' server.mjs
mut; git checkout -q -- server.mjs; b=$(run); report "6 /live handler CALLS execute()"

sed -i 's/^const PORT = Number(process.env.PORT ?? 8787);$/const PORT = Number(process.env.VOICEBOX_PORT ?? process.env.PORT ?? 8787);/' server.mjs
mut; git checkout -q -- server.mjs; b=$(run); report "7 env var ADDED (VOICEBOX_PORT)"

sed -i 's/rule: "network-unbounded"/rule: "network-unbound"/' core/extensions.ts
mut; git checkout -q -- core/extensions.ts; b=$(run); report "8 refusal RENAMED (network-unbounded)"

echo "tree after: $(git status --porcelain | wc -l) dirty files"
