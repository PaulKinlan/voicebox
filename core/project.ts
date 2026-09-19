// core/project.ts — the project record shape.

export interface Durability {
  persisted: boolean;
  checkedAt: string; // ISO — when the browser was last asked
}

export interface ProjectLocation {
  kind: "opfs";
  path: string; // OPFS-relative, never a realpath
}

export interface ProjectRecord {
  id: string; // `${name}@${placementLabel}` — identity IS placement + location
  name: string;
  placement: string;
  location: ProjectLocation;
  root: string; // the execution root: the containment boundary
  capabilities: string[];
  undoKind: string; // "written-file-list" for E1-M0
  createdAt: string;
  lastUsed: string;
  durability: Durability;
}

export function makeProjectRecord(name: string, placement: string): ProjectRecord {
  const now = new Date().toISOString();
  const root = `v1/projects/${name}`;
  return {
    id: `${name}@${placement}`,
    name,
    placement,
    location: { kind: "opfs", path: root },
    root,
    capabilities: ["read", "write", "wasm"],
    undoKind: "written-file-list",
    createdAt: now,
    lastUsed: now,
    durability: { persisted: false, checkedAt: now },
  };
}
