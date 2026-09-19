// browser/idb.ts — where a picked directory handle is PERSISTED, not held in a variable.
//
// N20: "an IndexedDB record, not a variable. A reload must not ask the user to find their folder
// again." That sentence is the whole file. A FileSystemDirectoryHandle is structured-cloneable, so
// the browser will keep the handle itself across a reload — and the permission that came with it
// is queried (not assumed) when the handle is read back, because it can regress to `prompt`.
//
// Both the worker and the page use this: the worker to store and read handles, the page to ask
// for permission, which the platform only allows a page with a user gesture to do.

const DB = "voicebox";
const STORE = "roots";
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function tx(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    run(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
}

export async function putHandle(name: string, handle: FileSystemDirectoryHandle): Promise<void> {
  await tx("readwrite", (store) => store.put(handle, name));
}

export async function getHandle(name: string): Promise<FileSystemDirectoryHandle | null> {
  const db = await open();
  const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(name);
    request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return handle;
}

export async function deleteHandle(name: string): Promise<void> {
  await tx("readwrite", (store) => store.delete(name));
}

export async function listHandleNames(): Promise<string[]> {
  const db = await open();
  const names = await new Promise<string[]>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result.map(String));
    request.onerror = () => reject(request.error);
  });
  db.close();
  return names;
}
