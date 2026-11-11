import type { DirectorySelection, HistoryDirectory } from "./directory-history";

export interface StoredDirectorySelection extends DirectorySelection {
  selectionId: string;
  displayName: string;
}
const DB = "wa-translate-directory-handles-v1";
const STORE = "handles";
const SELECTED = "selected";
const PENDING = "pending";
const APPROVED = "approved:";
const APPROVED_INDEX = "approved-index";
const OWNER = "installation";
const token = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("Directory selection storage unavailable"));
  });
}
async function read(key: string): Promise<any> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly"),
        request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error("Directory selection storage unavailable"));
    });
  } finally {
    db.close();
  }
}
async function write(key: string, value: unknown): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(new Error("Directory selection storage unavailable"));
      tx.onerror = () =>
        reject(new Error("Directory selection storage unavailable"));
    });
  } finally {
    db.close();
  }
}
async function installation(): Promise<string> {
  const db = await open();
  try {
    return await new Promise<string>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite"),
        store = tx.objectStore(STORE),
        request = store.get(OWNER);
      let id = "";
      request.onsuccess = () => {
        id =
          typeof request.result === "string" &&
          /^[a-f0-9]{32}$/.test(request.result)
            ? request.result
            : token();
        store.put(id, OWNER);
      };
      tx.oncomplete = () => resolve(id);
      tx.onabort = () =>
        reject(new Error("Directory selection storage unavailable"));
      tx.onerror = () =>
        reject(new Error("Directory selection storage unavailable"));
    });
  } finally {
    db.close();
  }
}
function normalizeSelection(value: any): StoredDirectorySelection | null {
  if (!value) return null;
  if (
    !value.directory ||
    value.directory.kind !== "directory" ||
    typeof value.directory.queryPermission !== "function" ||
    !/^[a-f0-9]{32}$/.test(value.namespace) ||
    !/^[a-f0-9]{32}$/.test(value.selectionId) ||
    typeof value.displayName !== "string"
  )
    throw new Error("Directory selection storage invalid");
  return value;
}
export async function loadDirectorySelection(
  selectionId?: string,
): Promise<StoredDirectorySelection | null> {
  if (selectionId !== undefined && !/^[a-f0-9]{32}$/.test(selectionId))
    return null;
  const value = normalizeSelection(
    await read(selectionId === undefined ? SELECTED : APPROVED + selectionId),
  );
  return selectionId === undefined || value?.selectionId === selectionId
    ? value
    : null;
}
export async function loadPendingDirectorySelection(
  selectionId: string,
): Promise<StoredDirectorySelection | null> {
  if (!/^[a-f0-9]{32}$/.test(selectionId)) return null;
  const pending = normalizeSelection(await read(PENDING));
  return pending?.selectionId === selectionId ? pending : null;
}
// Call only from the serialized, trusted background configure handler after
// checking the user's expected current settings/location. A picked candidate
// alone must never redirect ongoing writes or destructive maintenance.
export async function activateDirectorySelection(
  selectionId: string,
): Promise<StoredDirectorySelection | null> {
  if (!/^[a-f0-9]{32}$/.test(selectionId)) return null;
  const db = await open();
  try {
    return await new Promise<StoredDirectorySelection | null>(
      (resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite"),
          store = tx.objectStore(STORE),
          request = store.get(PENDING);
        let selected: StoredDirectorySelection | null = null;
        request.onsuccess = () => {
          try {
            const pending = normalizeSelection(request.result);
            if (pending?.selectionId !== selectionId) {
              const existing = store.get(APPROVED + selectionId);
              existing.onsuccess = () => {
                try {
                  const known = normalizeSelection(existing.result);
                  selected = known?.selectionId === selectionId ? known : null;
                } catch {
                  tx.abort();
                }
              };
              return;
            }
            const index = store.get(APPROVED_INDEX);
            index.onsuccess = () => {
              try {
                const previous = index.result ?? [];
                if (
                  !Array.isArray(previous) ||
                  previous.length > 20 ||
                  !previous.every(
                    (v) => typeof v === "string" && /^[a-f0-9]{32}$/.test(v),
                  )
                )
                  throw new Error();
                const keep = [
                  ...previous.filter((v) => v !== selectionId),
                  selectionId,
                ];
                while (keep.length > 20) store.delete(APPROVED + keep.shift()!);
                selected = pending;
                store.put(pending, APPROVED + selectionId);
                store.put(keep, APPROVED_INDEX);
                store.put(pending, SELECTED);
                store.delete(PENDING);
              } catch {
                tx.abort();
              }
            };
          } catch {
            tx.abort();
          }
        };
        tx.oncomplete = () => resolve(selected);
        tx.onabort = () =>
          reject(new Error("Directory selection activation unavailable"));
        tx.onerror = () =>
          reject(new Error("Directory selection activation unavailable"));
      },
    );
  } finally {
    db.close();
  }
}
/** Invoke synchronously from a user click. Never call this from the service worker. */
export async function chooseDirectoryForHistory(): Promise<StoredDirectorySelection> {
  const picker = (
    globalThis as unknown as {
      showDirectoryPicker?: (options: {
        mode: "readwrite";
        id: string;
      }) => Promise<HistoryDirectory>;
    }
  ).showDirectoryPicker;
  if (typeof picker !== "function")
    throw new Error("Directory picker unsupported");
  // Picker must precede IndexedDB awaits to retain transient user activation.
  const directory = await picker.call(globalThis, {
    mode: "readwrite",
    id: "wa-translation-history",
  });
  if ((await directory.queryPermission({ mode: "readwrite" })) !== "granted")
    throw new Error("Directory permission required");
  const namespace = await installation();
  const selected: StoredDirectorySelection = {
    directory,
    namespace,
    selectionId: token(),
    displayName: directory.name,
  };
  // One replaceable pending candidate bounds storage even after cancelled forms.
  await write(PENDING, selected);
  return selected;
}
/** Call only from a user gesture. Pass a previously loaded selection so awaiting
 * IndexedDB does not consume the browser's transient permission activation. */
export async function reauthorizeHistoryDirectory(
  selection: StoredDirectorySelection,
): Promise<boolean> {
  if (typeof selection.directory.requestPermission !== "function") return false;
  const granted =
    (await selection.directory.requestPermission({ mode: "readwrite" })) ===
    "granted";
  const current = await loadDirectorySelection(selection.selectionId);
  return granted && current?.selectionId === selection.selectionId;
}
