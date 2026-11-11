import assert from "node:assert/strict";
import { historyAccountForSender } from "../src/background/history-account";
import {
  HistoryBackend,
  historyQueueScope,
  validHistorySettings,
} from "../src/background/history-backend";
export async function runHistoryAccountTests() {
  const old = globalThis.chrome;
  let result: any = [
    { frameId: 0, documentId: "document-A", result: "100@c.us" },
  ];
  let last: any,
    touches = 0;
  const memory: Record<string, unknown> = {};
  const sender: any = {
    id: "extension",
    frameId: 0,
    documentId: "document-A",
    tab: { id: 3 },
    url: "https://web.whatsapp.com/",
  };
  (globalThis as any).chrome = {
    runtime: { id: "extension" },
    scripting: {
      executeScript: async (value: any) => {
        last = value;
        return result;
      },
    },
    storage: {
      local: {
        get: async () => {
          touches++;
          return { ...memory };
        },
        set: async (data: any) => {
          touches++;
          Object.assign(memory, data);
        },
        remove: async (keys: string[]) => {
          for (const key of keys) delete memory[key];
        },
      },
    },
  };
  try {
    const account = await historyAccountForSender(sender);
    assert.equal(account?.length, 64);
    assert.deepEqual(last.target, { tabId: 3, documentIds: ["document-A"] });
    assert.equal(last.world, "MAIN");
    for (const patch of [
      { documentId: undefined },
      { frameId: 1 },
      { id: "other" },
      { url: "https://evil.invalid/" },
    ])
      assert.equal(
        await historyAccountForSender({ ...sender, ...patch }),
        null,
      );
    for (const bad of [
      [],
      [{ frameId: 0, documentId: "document-B", result: "100@c.us" }],
      [{ frameId: 0, documentId: "document-A", result: "not an account" }],
    ]) {
      result = bad;
      assert.equal(await historyAccountForSender(sender), null);
    }
    const backend = new HistoryBackend();
    assert.equal(
      (await backend.list({ account: "b".repeat(64) }, async () => account))
        .status,
      "account",
    );
    assert.equal(
      (
        await backend.put(
          { record: { account: "b".repeat(64) } },
          async () => account,
        )
      ).status,
      "account",
    );
    assert.equal(touches, 0);
    let checks = 0;
    const changed = await backend.list(
      { account, chat: "100@c.us", target: "zh-CN", revision: "r", ids: [] },
      async () => (++checks === 1 ? account : null),
    );
    assert.equal(changed.status, "account");
    assert.deepEqual(changed.records, []);
    const saved = {
      account: account!,
      id: "false_200@c.us_ONE",
      chat: "200@c.us",
      rawId: "ONE",
      target: "zh-CN",
      revision: "r",
      originalHash: "b".repeat(64),
      translated: "译文",
      source: "en",
      savedAt: Date.now(),
    };
    const query = {
      account,
      chat: saved.chat,
      target: saved.target,
      revision: "r",
      ids: [saved.id],
    };
    const before = await backend.list(query, async () => account);
    assert.equal(before.status, "ok");
    assert.equal(
      (
        await backend.put(
          {
            record: saved,
            locationKey: (before as any).locationKey,
            queueScope: (before as any).queueScope,
          },
          async () => account,
        )
      ).status,
      "ok",
    );
    assert.equal(
      (await backend.list(query, async () => account)).records.length,
      1,
    );
    checks = 0;
    const late = await backend.list(query, async () =>
      ++checks < 3 ? account : null,
    );
    assert.equal(late.status, "account");
    assert.deepEqual(late.records, []);
    assert.equal(
      (
        await backend.list({ ...query, account: "f".repeat(64) }, async () =>
          "f".repeat(64),
        )
      ).records.length,
      0,
    );
    console.log(
      "PASS Background account probe targets exact document and rejects fabricated identity or navigation",
    );
    const initial = await backend.snapshot();
    const resized = await backend.configure(
      { mode: "browser", maxMiB: 2 },
      initial.locationKey,
    );
    assert.equal(resized.status, "ok");
    const current = await backend.snapshot();
    assert.equal(
      current.queueScope,
      initial.queueScope,
      "Reauthorization/configure preserves queue epoch",
    );
    assert.notEqual(current.locationKey, initial.locationKey);
    assert.equal(
      (
        await backend.put(
          {
            record: saved,
            locationKey: initial.locationKey,
            queueScope: initial.queueScope,
          },
          async () => account,
        )
      ).status,
      "conflict",
    );
    assert.equal(
      (
        await backend.put(
          {
            record: saved,
            locationKey: current.locationKey,
            queueScope: current.queueScope,
          },
          async () => account,
        )
      ).status,
      "ok",
    );
    const originalClear = (backend as any).browser.clear;
    (backend as any).browser.clear = async () => {
      throw Error("synthetic interrupted clear");
    };
    assert.equal(
      (await backend.clear(current.locationKey)).status,
      "unavailable",
    );
    const afterClear = await backend.snapshot();
    assert.notEqual(
      afterClear.queueScope,
      current.queueScope,
      "Partial clear invalidates old pending records before deletion",
    );
    assert.equal(
      (
        await backend.put(
          {
            record: saved,
            locationKey: afterClear.locationKey,
            queueScope: current.queueScope,
          },
          async () => account,
        )
      ).status,
      "conflict",
    );
    (backend as any).browser.clear = originalClear;
    const originalSelected = (backend as any).selected;
    (backend as any).selected = async () => {
      throw Error("directory unavailable");
    };
    const unavailable = await backend.list(query, async () => account);
    assert.equal(unavailable.status, "unavailable");
    assert.equal((unavailable as any).queueScope, afterClear.queueScope);
    assert.equal((unavailable as any).account, account);
    const failedPut = await backend.put(
      {
        record: saved,
        locationKey: afterClear.locationKey,
        queueScope: afterClear.queueScope,
      },
      async () => account,
    );
    assert.equal(failedPut.status, "unavailable");
    assert.equal((failedPut as any).queueScope, afterClear.queueScope);
    checks = 0;
    const unavailableChangedAccount = await backend.list(query, async () =>
      ++checks === 1 ? account : null,
    );
    assert.deepEqual(unavailableChangedAccount, {
      status: "account",
      records: [],
    });
    (backend as any).selected = originalSelected;
    console.log(
      "PASS Queue binding survives same-store settings, rejects stale writes and changes before partial clear",
    );
    const aId = "a".repeat(32),
      bId = "b".repeat(32);
    memory.translationHistorySettings = {
      mode: "directory",
      maxMiB: 2,
      revision: "a",
      directoryId: aId,
      queueEpoch: "legacy",
    };
    const aBefore = await backend.snapshot();
    const bBefore = historyQueueScope({
      ...aBefore.settings,
      directoryId: bId,
    });
    (backend as any).selected = async () => ({
      store: { clear: async () => "ok", put: async () => "ok" },
    });
    assert.equal((await backend.clear(aBefore.locationKey)).status, "ok");
    const aAfter = await backend.snapshot();
    assert.notEqual(aAfter.queueScope, aBefore.queueScope);
    assert.equal(
      historyQueueScope({ ...aAfter.settings, directoryId: bId }),
      bBefore,
      "Clearing A leaves B epoch unchanged",
    );
    memory.translationHistorySettings = {
      ...aAfter.settings,
      directoryId: bId,
      revision: "b",
    };
    const bSelected = await backend.snapshot();
    assert.equal(bSelected.queueScope, bBefore);
    assert.equal(
      (
        await backend.put(
          {
            record: saved,
            locationKey: bSelected.locationKey,
            queueScope: bBefore,
          },
          async () => account,
        )
      ).status,
      "ok",
    );
    memory.translationHistorySettings = {
      ...aAfter.settings,
      revision: "a-return",
    };
    const aReturn = await backend.snapshot();
    assert.equal(
      (
        await backend.put(
          {
            record: saved,
            locationKey: aReturn.locationKey,
            queueScope: aBefore.queueScope,
          },
          async () => account,
        )
      ).status,
      "conflict",
    );
    const epochs = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [
        "directory:" + i.toString(16).padStart(32, "0"),
        "kept",
      ]),
    );
    memory.translationHistorySettings = {
      mode: "browser",
      maxMiB: 2,
      revision: "full",
      queueEpochs: epochs,
    };
    const full = await backend.snapshot();
    assert.equal((await backend.clear(full.locationKey)).status, "full");
    assert.equal((await backend.snapshot()).queueScope, full.queueScope);
    assert.equal(
      Object.keys((await backend.settings()).queueEpochs!).length,
      1000,
    );
    assert.equal(
      validHistorySettings({
        ...full.settings,
        queueEpochs: { ...epochs, browser: "extra" },
      }),
      null,
    );
    (backend as any).selected = originalSelected;
    console.log(
      "PASS Per-location epochs preserve other-directory queues and refuse overflow without eviction",
    );
    return 3;
  } finally {
    (globalThis as any).chrome = old;
  }
}
