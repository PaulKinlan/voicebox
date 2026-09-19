// browser/opfs.ts — the storage adapter: OPFS only, in M0.
//
// WHAT THIS FILE IS: the world the audit reads. Every `observed` in an audit entry comes from
// here, after the act — never from the caller's report of what it did. That is the whole reason
// these functions return sizes and timestamps instead of booleans: a boolean is something the
// tool could have told us, and §3.8's field evidence is a model that claimed a file existed.
//
// WHAT IT DELIBERATELY IS NOT: a path resolver. Every path it is handed has already been through
// core.resolveInsideRoot, and this file never tidies, joins or normalises one. If it did, the
// containment check would be repeated by a weaker implementation in a second place — which is
// how you end up with two answers to "is this inside the root".

/** Every path in this placement is OPFS-relative to the origin's private root. */
export async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  // No user gesture: measured at page load with `userActivation.isActive === false`
  // (docs/evidence/opfs-20260919/). Only a *picked* directory needs a prompt.
  return await navigator.storage.getDirectory();
}

function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

async function dirHandle(path: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  let handle = await opfsRoot();
  for (const segment of segments(path)) {
    handle = await handle.getDirectoryHandle(segment, { create });
  }
  return handle;
}

async function fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
  const parts = segments(path);
  const name = parts.pop();
  if (!name) throw new Error(`not a file path: ${path}`);
  const dir = await dirHandle(parts.join("/"), create);
  return await dir.getFileHandle(name, { create });
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await fileHandle(path, true);
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

export async function writeText(path: string, text: string): Promise<void> {
  await writeBytes(path, new TextEncoder().encode(text));
}

export async function readText(path: string): Promise<string> {
  const file = await (await fileHandle(path, false)).getFile();
  return await file.text();
}

export async function readBytes(path: string): Promise<Uint8Array> {
  const file = await (await fileHandle(path, false)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fileHandle(path, false);
    return true;
  } catch {
    return false;
  }
}

/**
 * Append one line. The audit's durability depends on this being append-only: a rewrite would
 * make a concurrent reader able to see a torn log, and a log that can be rewritten is not a log.
 */
export async function appendLine(path: string, line: string): Promise<void> {
  const handle = await fileHandle(path, true);
  const file = await handle.getFile();
  const writable = await handle.createWritable({ keepExistingData: true });
  await writable.seek(file.size);
  await writable.write(`${line}\n`);
  await writable.close();
}

export async function readLines(path: string): Promise<string[]> {
  try {
    const text = await readText(path);
    return text.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * What the world looks like AFTER an act. This is the audit's `observed` field and the only
 * source for it — the caller's account of its own success is not evidence.
 */
export async function observe(path: string): Promise<{ exists: boolean; bytes?: number; mtime?: string }> {
  try {
    const file = await (await fileHandle(path, false)).getFile();
    return { exists: true, bytes: file.size, mtime: new Date(file.lastModified).toISOString() };
  } catch {
    return { exists: false };
  }
}

export async function remove(path: string): Promise<boolean> {
  const parts = segments(path);
  const name = parts.pop();
  if (!name) return false;
  try {
    const dir = await dirHandle(parts.join("/"), false);
    await dir.removeEntry(name);
    return true;
  } catch {
    return false;
  }
}

export async function listNames(path: string): Promise<string[]> {
  try {
    const dir = await dirHandle(path, false);
    const names: string[] = [];
    // @ts-expect-error — OPFS async iteration is in all shipping browsers, not in every TS lib.
    for await (const [name, entry] of dir.entries()) names.push(name);
    return names.sort();
  } catch {
    return [];
  }
}

export async function listDirs(path: string): Promise<string[]> {
  try {
    const dir = await dirHandle(path, false);
    const names: string[] = [];
    // @ts-expect-error — as above.
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === "directory") names.push(name);
    }
    return names.sort();
  } catch {
    return [];
  }
}
