// What a dynamic tool can DO under a given permission set. One line per capability,
// each printed as ALLOWED or DENIED with the error name, so the substrate's own words
// are the evidence rather than my summary of it.
const R = Deno.args[0];
const out: string[] = [];
async function attempt(label: string, fn: () => unknown | Promise<unknown>) {
  try { const v = await fn(); out.push(`${label}: ALLOWED ${typeof v === "string" ? v.slice(0, 40) : ""}`); }
  catch (e) { out.push(`${label}: DENIED ${(e as Error).name}`); }
}
await attempt("read inside root", () => Deno.readTextFile(`${R}/sub/file.txt`));
await attempt("read OUTSIDE root", () => Deno.readTextFile("/tmp/vb-secret-outside.txt"));
await attempt("read through symlink INSIDE", () => Deno.readTextFile(`${R}/link-inside`));
await attempt("read through symlink OUTSIDE", () => Deno.readTextFile(`${R}/link-outside`));
await attempt("write OUTSIDE root", () => Deno.writeTextFile("/tmp/vb-escape.txt", "x"));
await attempt("list dir outside", async () => { let n = 0; for await (const _ of Deno.readDir("/etc")) n++; return `${n} entries`; });
await attempt("network", async () => { const r = await fetch("https://example.com", { signal: AbortSignal.timeout(3000) }); return `status ${r.status}`; });
await attempt("network other host", async () => { const r = await fetch("https://example.org", { signal: AbortSignal.timeout(3000) }); return `status ${r.status}`; });
await attempt("spawn process (prints the child's read)", () => { const o = new Deno.Command("/bin/sh", { args: ["-c", "cat /tmp/vb-secret-outside.txt"] }).outputSync(); return new TextDecoder().decode(o.stdout).trim(); });
await attempt("run deno child", () => new Deno.Command(Deno.execPath(), { args: ["eval", "console.log(1)"] }).outputSync().code);
await attempt("env read", () => Deno.env.get("HOME") ?? "(none)");
await attempt("ffi", () => (Deno as any).dlopen("/lib/x86_64-linux-gnu/libc.so.6", {}) ? "opened" : "no");
const IMP = `https://deno.land/std@0.224.0/version.ts?run=${Date.now()}`;
await attempt("dynamic remote import", async () => { await import(IMP); return "imported"; });
await attempt("write inside root", () => Deno.writeTextFile(`${R}/sub/written.txt`, "ok"));
console.log(out.join("\n"));
