import assert from "node:assert/strict";
import {
  chooseDirectoryForHistory,
  loadDirectorySelection,
  loadPendingDirectorySelection,
  activateDirectorySelection,
  reauthorizeHistoryDirectory,
} from "../src/shared/directory-selection";
// Narrow asynchronous IndexedDB mock; no real browser profile or filesystem.
function fakeIndexedDB() {
  const values = new Map<string, unknown>();
  let created = false;
  class Transaction {
    oncomplete: null | (() => void) = null;
    onabort: null | (() => void) = null;
    onerror: null | (() => void) = null;
    pending = 0;
    aborted = false;
    queue<T>(work: () => T): any {
      this.pending++;
      const request: any = {};
      setTimeout(() => {
        if (this.aborted) return;
        request.result = work();
        request.onsuccess?.();
        this.pending--;
        setTimeout(() => {
          if (!this.pending && !this.aborted) this.oncomplete?.();
        }, 0);
      }, 0);
      return request;
    }
    objectStore() {
      return {
        get: (key: string) => this.queue(() => values.get(key)),
        put: (value: unknown, key: string) =>
          this.queue(() => values.set(key, value)),
        delete: (key: string) => this.queue(() => values.delete(key)),
      };
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
  }
  const db = {
    createObjectStore() {},
    transaction() {
      return new Transaction();
    },
    close() {},
  };
  return {
    values,
    api: {
      open() {
        const request: any = { result: db };
        setTimeout(() => {
          if (!created) {
            created = true;
            request.onupgradeneeded?.();
          }
          request.onsuccess?.();
        }, 0);
        return request;
      },
    },
  };
}
export async function runDirectorySelectionTests(): Promise<number> {
  const oldIDB = globalThis.indexedDB,
    oldPicker = (globalThis as any).showDirectoryPicker;
  const fake = fakeIndexedDB();
  globalThis.indexedDB = fake.api as any;
  let name = "A",
    permission: PermissionState = "granted",
    prompts = 0;
  (globalThis as any).showDirectoryPicker = async () => ({
    kind: "directory",
    name,
    queryPermission: async () => permission,
    requestPermission: async () => {
      prompts++;
      return permission;
    },
  });
  try {
    const a = await chooseDirectoryForHistory();
    assert.equal(
      await loadDirectorySelection(),
      null,
      "picker only stages, cannot redirect writes",
    );
    assert.equal(
      (await loadPendingDirectorySelection(a.selectionId))?.displayName,
      "A",
    );
    assert.equal(
      (await activateDirectorySelection(a.selectionId))?.selectionId,
      a.selectionId,
    );
    assert.equal((await loadDirectorySelection())?.selectionId, a.selectionId);
    name = "B";
    const b = await chooseDirectoryForHistory();
    assert.equal(
      (await loadDirectorySelection())?.selectionId,
      a.selectionId,
      "old selection remains during confirmation",
    );
    name = "C";
    const c = await chooseDirectoryForHistory();
    assert.equal(
      await activateDirectorySelection(b.selectionId),
      null,
      "superseded picker cannot activate a different candidate",
    );
    assert.equal((await loadDirectorySelection())?.selectionId, a.selectionId);
    assert.equal(
      (await activateDirectorySelection(c.selectionId))?.selectionId,
      c.selectionId,
    );
    assert.equal(
      c.namespace,
      a.namespace,
      "same installation keeps its isolated namespace across selected directories",
    );
    assert.equal(
      await loadPendingDirectorySelection(c.selectionId),
      null,
      "successful activation consumes candidate",
    );
    assert.equal(
      await reauthorizeHistoryDirectory(a),
      true,
      "reauthorization concerns only that approved handle; backend still guards active policy",
    );
    assert.equal(await reauthorizeHistoryDirectory(c), true);
    assert.equal(prompts, 2);
    assert.equal(
      (await loadDirectorySelection(a.selectionId))?.displayName,
      "A",
      "previous policy can still resolve A after B/C activation",
    );
    assert.equal(
      (await activateDirectorySelection(c.selectionId))?.selectionId,
      c.selectionId,
      "activation retry is idempotent",
    );
    assert.equal(
      await loadDirectorySelection("f".repeat(32)),
      null,
      "unknown policy id never falls back to selected",
    );
    permission = "denied";
    await assert.rejects(chooseDirectoryForHistory());
    assert.equal(
      (await loadDirectorySelection())?.selectionId,
      c.selectionId,
      "cancel/deny preserves active directory",
    );
    assert.equal(
      fake.values.size,
      5,
      "active pointer, owner, approved index and two handles",
    );
    console.log(
      "PASS Directory picker stages bounded candidates and activation rejects stale selections",
    );
    return 1;
  } finally {
    globalThis.indexedDB = oldIDB;
    (globalThis as any).showDirectoryPicker = oldPicker;
  }
}
