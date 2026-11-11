import {
  getStorageDiagnostics,
  recordStorageDiagnostic,
  clearStorageDiagnostics,
} from "../src/page/storage-diagnostics";
import { HistoryLifecycle } from "../src/page/hooks/history-lifecycle";
import assert from "node:assert/strict";
import { UnsavedHistoryQueue } from "../src/page/unsaved-history-queue";
import type { SavedTranslation } from "../src/shared/translation-history";
export async function runUnsavedQueueTests() {
  let count = 0;
  const test = async (name: string, fn: () => Promise<void>) => {
    await fn();
    count++;
    console.log("PASS", name);
  };
  const record = (id = "ONE"): SavedTranslation => ({
    account: "a".repeat(64),
    chat: "100@c.us",
    id: `false_100@c.us_${id}`,
    rawId: id,
    originalHash: "b".repeat(64),
    target: "zh-CN",
    revision: "rev",
    translated: "译文",
    source: "en",
    savedAt: 1700000000000,
  });
  const fixture = (maxCount = 50, maxBytes = 512 * 1024) => {
    let scope = "directory:A:initial",
      location = "directory:A:r1",
      status = "permission";
    const writes: any[] = [];
    const queue = new UnsavedHistoryQueue(
      async (msg) => {
        if (msg.action === "put") {
          writes.push(msg);
          return { status };
        }
        return {
          status,
          account: msg.account,
          locationKey: location,
          queueScope: scope,
          records: [],
        };
      },
      () => {},
      maxCount,
      maxBytes,
    );
    const list = (r = record(), ids = [r.id]) =>
      queue.list({
        action: "list",
        account: r.account,
        chat: r.chat,
        target: r.target,
        revision: r.revision,
        ids,
      });
    return {
      queue,
      writes,
      list,
      setStatus: (v: string) => (status = v),
      setScope: (v: string) => (scope = v),
      setLocation: (v: string) => (location = v),
    };
  };
  await test("Unsaved queue survives offscreen release and recovers same-directory permissions without provider requests", async () => {
    const f = fixture(),
      r = record();
    await f.queue.save({ ...r, original: "PRIVATE", apiKey: "SECRET" } as any);
    assert.equal(f.writes.length, 0);
    assert.match(f.queue.warning, /关闭或刷新/);
    assert.deepEqual((await f.list(r, [])).records, []);
    assert.equal((await f.list()).records.length, 1);
    assert(!JSON.stringify((await f.list()).records).includes("PRIVATE"));
    f.setLocation("directory:A:r2");
    f.setStatus("ok");
    f.queue.invalidate();
    assert.equal((await f.list()).records.length, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].locationKey, "directory:A:r2");
    assert.equal(f.queue.warning, "");
  });
  await test("Unsaved queue never migrates to another directory/account/target or restores invisible records", async () => {
    const f = fixture(),
      r = record();
    await f.queue.save(r);
    f.setScope("directory:B:initial");
    f.queue.invalidate();
    f.setStatus("ok");
    assert.equal((await f.list()).records.length, 0);
    assert.equal(f.writes.length, 0);
    f.setScope("directory:A:initial");
    assert.equal(
      (await f.list({ ...r, account: "c".repeat(64) })).records.length,
      0,
    );
    assert.equal(f.writes.length, 0);
    f.setStatus("permission");
    assert.equal((await f.list({ ...r, target: "fr" })).records.length, 0);
    assert.equal((await f.list(r, [])).records.length, 0);
    assert.equal((await f.list()).records.length, 1);
  });
  await test("Full queue retains existing records, rejects new count/byte overflow visibly, and page close clears memory", async () => {
    for (const f of [fixture(1), fixture(50, 700)]) {
      await f.queue.save(record());
      await f.queue.save({ ...record("TWO"), translated: "X".repeat(600) });
      assert.match(f.queue.warning, /队列已满/);
      assert.deepEqual(
        (await f.list(record(), [record().id, record("TWO").id])).records.map(
          (r: any) => r.rawId,
        ),
        ["ONE"],
      );
      f.queue.stop();
      assert.equal(f.queue.warning, "");
      await f.queue.save(record());
      assert.equal(f.queue.warning, "");
    }
  });
  await test("Clear epoch and delayed saves cannot resurrect cleared records", async () => {
    const f = fixture();
    await f.queue.save(record());
    f.queue.invalidate(true, "directory:A:initial");
    f.setScope("directory:A:clear2");
    f.setStatus("ok");
    assert.equal((await f.list()).records.length, 0);
    assert.equal(f.writes.length, 0);
    let release!: (value: any) => void;
    const q = new UnsavedHistoryQueue(
      async () => new Promise((resolve) => (release = resolve)),
      () => {},
    );
    const pending = q.save(record());
    q.invalidate(true, "directory:A:initial");
    release({
      status: "permission",
      account: record().account,
      locationKey: "old",
      queueScope: "directory:A:initial",
    });
    await pending;
    assert.equal(q.warning, "");
  });
  await test("Late successful write cannot remove a newer queued translation for the same message", async () => {
    let release!: (value: any) => void,
      puts = 0;
    const q = new UnsavedHistoryQueue(
      async (msg) =>
        msg.action === "list"
          ? {
              status: "ok",
              account: record().account,
              locationKey: "A:r",
              queueScope: "A:e",
              records: [],
            }
          : ++puts === 1
            ? new Promise((resolve) => (release = resolve))
            : { status: "unavailable" },
      () => {},
    );
    const old = q.save(record());
    for (let i = 0; i < 8 && !release; i++) await Promise.resolve();
    await q.save({ ...record(), translated: "新译文" });
    release({ status: "ok" });
    await old;
    const result = await q.list({
      action: "list",
      account: record().account,
      chat: record().chat,
      target: record().target,
      ids: [record().id],
    });
    assert.equal(result.records[0].translated, "新译文");
    assert.match(q.warning, /1 条/);
  });
  await test("HistoryLifecycle restores queued translation after offscreen release through original hash checks", async () => {
    const f = fixture(),
      r = record();
    let visible = true,
      restored = 0;
    const msg = {
      id: {
        _serialized: r.id,
        id: r.rawId,
        remote: { _serialized: r.chat },
        fromMe: false,
      },
      type: "chat",
      body: "ORIGINAL",
      t: 1700000000,
    };
    const lifecycle = new HistoryLifecycle({
      scope: () => ({
        account: "self@c.us",
        chat: r.chat,
        target: r.target,
        revision: r.revision,
      }),
      hash: async (text) =>
        text === "self@c.us"
          ? r.account
          : text === "ORIGINAL"
            ? r.originalHash
            : "c".repeat(64),
      list: async (account, chat, target, revision, ids, dateHints) =>
        (
          await f.queue.list({
            action: "list",
            account,
            chat,
            target,
            revision,
            ids,
            dateHints,
          })
        ).records,
      save: (record) => f.queue.save(record),
      visibleIds: () => (visible ? [r.id] : []),
      bubble: () => (visible ? {} : null),
      model: () => msg,
      has: () => false,
      restore: () => {
        restored++;
        return true;
      },
      clear: () => {},
      unavailable: () => {},
    });
    await lifecycle.completed({
      id: r.id,
      chat: r.chat,
      rawId: r.rawId,
      text: msg.body,
      translated: r.translated,
      source: r.source,
      target: r.target,
    });
    visible = false;
    await lifecycle.tick();
    assert.equal(restored, 0);
    visible = true;
    await lifecycle.tick();
    assert.equal(restored, 1);
    msg.body = "EDITED";
    lifecycle.changed();
    await lifecycle.tick();
    assert.equal(restored, 1);
    assert.equal(f.writes.length, 0);
    lifecycle.stop();
    f.queue.stop();
  });
  await test("Default queue retains all first 50 entries and rejects the 51st without eviction", async () => {
    const f = fixture();
    for (let i = 0; i < 51; i++) await f.queue.save(record("N" + i));
    const result = await f.list(
      record(),
      Array.from({ length: 51 }, (_, i) => record("N" + i).id),
    );
    assert.equal(result.records.length, 50);
    assert.equal(result.records[0].rawId, "N0");
    assert(!result.records.some((r: any) => r.rawId === "N50"));
    assert.match(f.queue.warning, /队列已满/);
    f.queue.stop();
  });
  await test("Reordered account probes cannot replace a newer queued result with an older save", async () => {
    const releases: ((v: any) => void)[] = [];
    let controlled = true;
    const binding = {
      status: "permission",
      account: record().account,
      locationKey: "A:r",
      queueScope: "A:e",
      records: [],
    };
    const q = new UnsavedHistoryQueue(
      async () =>
        controlled ? new Promise((resolve) => releases.push(resolve)) : binding,
      () => {},
    );
    const older = q.save(record()),
      newer = q.save({ ...record(), translated: "最新译文" });
    releases[1](binding);
    await newer;
    releases[0](binding);
    await older;
    controlled = false;
    const out = await q.list({
      action: "list",
      account: record().account,
      chat: record().chat,
      target: record().target,
      ids: [record().id],
    });
    assert.equal(out.records[0].translated, "最新译文");
    q.stop();
  });
  await test("Own successful browser index notification does not invalidate pending write acknowledgement", async () => {
    const q = new UnsavedHistoryQueue(
      async (msg) => {
        if (msg.action === "put") {
          q.storageChanged(false, false);
          return { status: "ok" };
        }
        return {
          status: "ok",
          account: record().account,
          locationKey: "browser:r",
          queueScope: "browser::initial",
          records: [],
        };
      },
      () => {},
    );
    await q.save(record());
    assert.equal(q.pendingCount, 0);
    assert.equal(q.warning, "");
    q.stop();
  });
  await test("Permission recovery retries independently when every visible annotation already exists", async () => {
    const f = fixture(),
      r = record();
    await f.queue.save(r);
    let lists = 0;
    const lifecycle = new HistoryLifecycle({
      scope: () => ({
        account: "self@c.us",
        chat: r.chat,
        target: r.target,
        revision: r.revision,
      }),
      hash: async () => r.account,
      list: async () => {
        lists++;
        return [];
      },
      save: async () => {},
      visibleIds: () => [r.id],
      bubble: () => ({}),
      model: () => null,
      has: () => true,
      restore: () => false,
      clear: () => {},
      unavailable: () => {},
    });
    await lifecycle.tick();
    const before = lists;
    f.setStatus("ok");
    f.setLocation("directory:A:r2");
    lifecycle.changed();
    await lifecycle.tick();
    assert.equal(lists, before, "View remains on its optimization early exit");
    await f.queue.retry(r.account);
    assert.equal(f.writes.length, 1);
    assert.equal(f.queue.pendingCount, 0);
    lifecycle.stop();
    f.queue.stop();
  });
  await test("Queue capacity warning resets after recovery drains pending records", async () => {
    const f = fixture(1);
    await f.queue.save(record());
    await f.queue.save(record("TWO"));
    assert.match(f.queue.warning, /队列已满/);
    f.setStatus("ok");
    await f.queue.retry(record().account);
    assert.equal(f.queue.pendingCount, 0);
    assert.equal(f.queue.warning, "");
    f.setStatus("permission");
    await f.queue.save(record("THREE"));
    assert.equal(f.queue.pendingCount, 1);
    assert(!f.queue.warning.includes("队列已满"));
    f.queue.stop();
  });
  await test("Superseded old tab queue retires without covering the newer persisted display result", async () => {
    let available = false;
    const newer = {
      ...record(),
      savedAt: record().savedAt + 1,
      translated: "NEWER",
    };
    const q = new UnsavedHistoryQueue(
      async (msg) =>
        msg.action === "put"
          ? { status: "superseded" }
          : {
              status: available ? "ok" : "permission",
              account: record().account,
              locationKey: "A:r",
              queueScope: "A:e",
              records: available ? [newer] : [],
            },
      () => {},
    );
    await q.save(record());
    available = true;
    const result = await q.list({
      action: "list",
      account: record().account,
      chat: record().chat,
      target: record().target,
      ids: [record().id],
    });
    assert.equal(q.pendingCount, 0);
    assert.equal(result.records[0].translated, "NEWER");
    q.stop();
  });
  await test("Queued writes expose safe failure classification and clear it after storage recovery", async () => {
    clearStorageDiagnostics();
    let failure = "permission";
    const q = new UnsavedHistoryQueue(
      async (msg) =>
        msg.action === "put"
          ? {
              status: failure,
              message: "SECRET https://private.invalid/body",
              record: record(),
            }
          : {
              status: "ok",
              account: record().account,
              locationKey: "A:r",
              queueScope: "A:e",
              records: [],
            },
      () => {},
    );
    await q.save(record());
    assert.match(q.warning, /目录读写权限未生效/);
    assert.equal(q.pendingCount, 1);
    for (const status of [
      "account",
      "conflict",
      "full",
      "corrupt",
      "invalid",
      "busy",
      "unavailable",
    ]) {
      failure = status;
      await q.retry(record().account);
      assert(q.warning.includes("最近保存结果"));
    }
    for (let i = 0; i < 70; i++) await q.retry(record().account);
    const log = getStorageDiagnostics();
    assert.equal(log.length, 64);
    assert(log.some((v) => v.includes("write_unavailable")));
    assert(!log.join(" ").includes("SECRET"));
    assert(!log.join(" ").includes(record().id));
    assert(!log.join(" ").includes("private.invalid"));
    failure = "ok";
    await q.retry(record().account);
    assert.equal(q.warning, "");
    assert.equal(q.pendingCount, 0);
    q.stop();
    clearStorageDiagnostics();
  });
  await test("Storage detail logs allowlist stage and exception names, never arbitrary errors", async () => {
    clearStorageDiagnostics();
    recordStorageDiagnostic("write", {
      status: "unavailable",
      failure: {
        stage: "record_writer",
        error: "TypeError",
        message: "SECRET",
      },
    });
    assert(getStorageDiagnostics()[0].includes("record_writer/TypeError"));
    recordStorageDiagnostic("write", {
      status: "unavailable",
      failure: { stage: "PRIVATE_PATH", error: "SECRET" },
    });
    assert(!getStorageDiagnostics().join(" ").includes("PRIVATE_PATH"));
    assert(!getStorageDiagnostics().join(" ").includes("SECRET"));
    clearStorageDiagnostics();
  });
  return count;
}
