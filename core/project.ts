// core/project.ts — the project record shape.
//
// CHANGED for the N20 review comments: the record could not REPRESENT the third root it advertises.
// `location` accepted only `kind: "opfs"`, `root` was an OPFS-relative string, and `durability` was a
// single boolean — so a picked-handle project had nowhere to record which folder it was, and the UI
// could not tell origin-storage persistence from a handle's persistence and permission. A record that
// cannot represent a case cannot support a claim about it.

/** Where a project's files live. Two kinds, because N20 added the second. */
export type ProjectLocation =
  | { kind: "opfs"; path: string } // origin-private, OPFS-relative, never a realpath
  | { kind: "handle"; id: string; label: string }; // a picked folder: the origin cannot describe its
// target, only remember the handle and the label the user gave it.

/** The execution root — the containment boundary. Tagged, for the same reason as the location. */
export type RootRef =
  | { kind: "opfs"; path: string }
  | { kind: "handle"; id: string };

/** Durability and permission are two different facts, and only one of them is a boolean. */
export type Durability =
  | { kind: "opfs"; persisted: boolean; checkedAt: string }
  | {
      kind: "handle";
      persisted: boolean;
      /** OPFS needs no gesture; a picked folder may need one on re-acquisition. */
      permission: "granted" | "prompt" | "denied" | "unknown";
      checkedAt: string;
    };

export interface ProjectRecord {
  id: string; // `${name}@${placementLabel}` — identity IS placement + location
  name: string;
  placement: string;
  location: ProjectLocation;
  root: RootRef; // the execution root: the containment boundary
  capabilities: string[];
  undoKind: string; // "written-file-list" for E1-M0
  createdAt: string;
  lastUsed: string;
  durability: Durability;
}

export function makeProjectRecord(name: string, placement: string): ProjectRecord {
  const now = new Date().toISOString();
  const path = `v1/projects/${name}`;
  return {
    id: `${name}@${placement}`,
    name,
    placement,
    location: { kind: "opfs", path },
    root: { kind: "opfs", path },
    capabilities: ["read", "write", "wasm"],
    undoKind: "written-file-list",
    createdAt: now,
    lastUsed: now,
    durability: { kind: "opfs", persisted: false, checkedAt: now },
  };
}
