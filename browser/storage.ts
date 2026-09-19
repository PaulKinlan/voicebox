// browser/storage.ts — two storage shapes behind one interface.
//
// THE POINT OF THE INTERFACE: the tier table, the audit and the tool run must not care which kind
// of root they are working on. What they hand down is a path that has already been through
// core.resolveInsideRoot, and what they get back is the world — sizes, timestamps, missing files.
// The two adapters differ in where the bytes go (origin-private OPFS, or a folder the user picked)
// and in nothing else that the rest of the host can see.
//
// THE VIRTUAL ROOT: a rule's containment check is a string comparison against a root, and a picked
// folder has no path this origin may describe — its handle is not a path and `location.path` means
// nothing anywhere else (§2.1). So a handle root gets a VIRTUAL root string (`picked:atlas`) and
// the adapter strips that prefix. Containment therefore keeps one implementation for both kinds,
// which is exactly what "the same shape, so the core does not change" has to mean in practice.
//
// WRITES ARE THE HONEST PART: a picked root's write permission can be `prompt`, and a write
// attempt in that state BLOCKS on a prompt instead of failing (measured — see the receipt). So the
// adapter never gets the chance to hang: the host checks the permission state first and reports
// `needs-gesture` / `permission-denied` by name.

export interface Entry {
  name: string;
  kind: "file" | "directory";
  bytes?: number;
  mtime?: string;
}

export interface Observed {
  exists: boolean;
  bytes?: number;
  mtime?: string;
}

export interface Storage {
  /** The string every containment check measures against. */
  readonly root: string;
  readText(resolved: string): Promise<string>;
  readBytes(resolved: string): Promise<Uint8Array>;
  writeBytes(resolved: string, bytes: Uint8Array): Promise<void>;
  writeText(resolved: string, text: string): Promise<void>;
  appendLine(resolved: string, line: string): Promise<void>;
  readLines(resolved: string): Promise<string[]>;
  observe(resolved: string): Promise<Observed>;
  /**
   * Touch the root and let the platform's error out. A deleted folder, a renamed one and an
   * unmounted volume are three names for one fact — and swallowing that fact would make the
   * explorer show an empty list, which looks exactly like an empty folder.
   */
  probe(): Promise<void>;
  remove(resolved: string): Promise<boolean>;
  /**
   * ONE directory iteration, bounded. The explorer renders from this and never walks the tree.
   *
   * `strict` is the difference between "this directory is empty" and "this directory could not be
   * opened": the first version swallowed both into an empty list, and an empty list looks exactly
   * like an empty folder to the person reading it. A caller that is listing a directory somebody
   * asked for passes strict; a caller probing for optional content (a project's `assets/`) does
   * not, because there the absence is expected.
   */
  listChildren(resolved: string, limit: number, strict?: boolean): Promise<{ entries: Entry[]; truncated: boolean }>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

function relTo(root: string, resolved: string): string {
  if (resolved === root) return "";
  if (!resolved.startsWith(`${root}/`)) {
    // Unreachable if every caller resolved first — and if it is ever reached, it is a bug in the
    // host rather than a permission problem, so it must not be swallowed as "not found".
    throw new Error(`'${resolved}' is not inside '${root}'`);
  }
  return resolved.slice(root.length + 1);
}

// ---------------------------------------------------------------- OPFS

export async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  // No user gesture: measured at page load with `userActivation.isActive === false`
  // (docs/evidence/opfs-20260919/). Only a *picked* directory needs a prompt.
  return await navigator.storage.getDirectory();
}

export async function opfsStorage(rootPath: string): Promise<Storage> {
  const origin = await opfsRoot();
  // The walk starts AT THE ROOT, not at the origin: `relTo` hands this function a path relative to
  // the root it was built for, and an adapter that walked from the origin instead would write
  // every project's files into the origin's top level — a bug that stays invisible while all the
  // virtual paths agree, and shows up later as projects sharing one directory.
  const rootDir = async (create: boolean): Promise<FileSystemDirectoryHandle> => {
    let handle = origin;
    for (const segment of segments(rootPath)) handle = await handle.getDirectoryHandle(segment, { create });
    return handle;
  };
  const at = async (rel: string, create: boolean): Promise<FileSystemDirectoryHandle> => {
    let handle = await rootDir(create);
    for (const segment of segments(rel)) {
      handle = await handle.getDirectoryHandle(segment, { create });
    }
    return handle;
  };
  const file = async (rel: string, create: boolean): Promise<FileSystemFileHandle> => {
    const parts = segments(rel);
    const name = parts.pop();
    if (!name) throw new Error(`not a file path: ${rel}`);
    return await (await at(parts.join("/"), create)).getFileHandle(name, { create });
  };
  return adapter(rootPath, at, file);
}

// ---------------------------------------------------------------- a picked directory handle

export function handleStorage(dir: FileSystemDirectoryHandle, virtualRoot: string): Storage {
  const at = async (rel: string, create: boolean): Promise<FileSystemDirectoryHandle> => {
    let handle = dir;
    for (const segment of segments(rel)) handle = await handle.getDirectoryHandle(segment, { create });
    return handle;
  };
  const file = async (rel: string, create: boolean): Promise<FileSystemFileHandle> => {
    const parts = segments(rel);
    const name = parts.pop();
    if (!name) throw new Error(`not a file path: ${rel}`);
    return await (await at(parts.join("/"), create)).getFileHandle(name, { create });
  };
  return adapter(virtualRoot, at, file);
}

/**
 * The methods both adapters share, because they share the browser's file-system API: what changes
 * between OPFS and a picked folder is only how the top-level directory handle is obtained.
 */
function adapter(
  root: string,
  at: (rel: string, create: boolean) => Promise<FileSystemDirectoryHandle>,
  file: (rel: string, create: boolean) => Promise<FileSystemFileHandle>,
): Storage {
  return {
    root,
    async readText(resolved) {
      return await (await file(relTo(root, resolved), false)).getFile().then((f) => f.text());
    },
    async readBytes(resolved) {
      const blob = await (await file(relTo(root, resolved), false)).getFile();
      return new Uint8Array(await blob.arrayBuffer());
    },
    async writeBytes(resolved, bytes) {
      const handle = await file(relTo(root, resolved), true);
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    },
    async writeText(resolved, text) {
      await this.writeBytes(resolved, encoder.encode(text));
    },
    async appendLine(resolved, line) {
      // Append-only: a rewrite would let a reader see a torn log, and a log that can be rewritten
      // is not a log.
      const handle = await file(relTo(root, resolved), true);
      const size = (await handle.getFile()).size;
      const writable = await handle.createWritable({ keepExistingData: true });
      await writable.seek(size);
      await writable.write(encoder.encode(`${line}\n`));
      await writable.close();
    },
    async readLines(resolved) {
      try {
        return (await (await file(relTo(root, resolved), false)).getFile())
          .text()
          .then((text) => text.split("\n").filter((l) => l.trim().length > 0));
      } catch {
        return []; // no log yet is not an error
      }
    },
    async observe(resolved) {
      try {
        const blob = await (await file(relTo(root, resolved), false)).getFile();
        return { exists: true, bytes: blob.size, mtime: new Date(blob.lastModified).toISOString() };
      } catch {
        return { exists: false };
      }
    },
    async probe() {
      const dir = await at(relTo(root, root), false);
      await dir.entries().next(); // NotFoundError when the folder is gone
    },
    async remove(resolved) {
      const parts = segments(relTo(root, resolved));
      const name = parts.pop();
      if (!name) return false;
      try {
        await (await at(parts.join("/"), false)).removeEntry(name);
        return true;
      } catch {
        return false;
      }
    },
    async listChildren(resolved, limit, strict = false) {
      const entries: Entry[] = [];
      let truncated = false;
      try {
        const dir = await at(relTo(root, resolved), false);
        let visited = 0;
        for await (const [name, child] of dir.entries() as AsyncIterable<[string, FileSystemHandle & { kind: string }]>) {
          visited++;
          if (visited > limit) {
            truncated = true;
            break; // stop iterating: the explorer lists a directory, it does not walk a tree
          }
          if (child.kind === "directory") {
            entries.push({ name, kind: "directory" });
          } else {
            const blob = await (child as unknown as FileSystemFileHandle).getFile();
            entries.push({ name, kind: "file", bytes: blob.size, mtime: new Date(blob.lastModified).toISOString() });
          }
        }
      } catch (e) {
        if (strict) throw e; // the caller asked for this directory; a failure is not an empty list
        return { entries: [], truncated: false };
      }
      entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
      return { entries, truncated };
    },
  };
}

export { decoder };
