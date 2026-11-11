import { HistoryBackend } from "../src/background/history-backend";
import { HistoryRequestGate } from "../src/background/history-gate";
import assert from "node:assert/strict";
import { TranslationHistoryStore } from "../src/background/translation-history";
import {
  HISTORY_KEY,
  messageTimestamp,
  normalizeSavedTranslation,
  type SavedTranslation,
} from "../src/shared/translation-history";
import {
  HistoryLifecycle,
  type HistoryScope,
} from "../src/page/hooks/history-lifecycle";
import { IncomingAnnotations } from "../src/page/hooks/incoming-annotations";
import { DEFAULT_CONFIG, publicConfig } from "../src/shared/types";
export async function runHistoryTests(): Promise<number> {
  let count = 0;
  const test = async (name: string, run: () => unknown) => {
    await run();
    count++;
    console.log("PASS", name);
  };
  const record = (id = "ONE", time = 1): SavedTranslation => ({
    account: "a".repeat(64),
    id: `false_100@c.us_${id}`,
    chat: "100@c.us",
    rawId: id,
    originalHash: "b".repeat(64),
    target: "zh-CN",
    revision: "rev",
    translated: "纯译文",
    source: "en",
    savedAt: time,
  });
  await test("Untrusted page account claims cannot read, write, or evict durable history", async () => {
    const oldChrome = globalThis.chrome;
    let touches = 0;
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => {
            touches++;
            return {};
          },
          set: async () => {
            touches++;
          },
          remove: async () => {
            touches++;
          },
        },
      },
    };
    try {
      const backend = new HistoryBackend();
      for (const account of ["a".repeat(64), "b".repeat(64)]) {
        assert.deepEqual(
          await backend.list({
            account,
            chat: "100@c.us",
            ids: [record().id],
            target: "zh-CN",
            revision: "rev",
          }),
          { status: "account", records: [] },
        );
        assert.deepEqual(
          await backend.put({
            record: { ...record(), account },
            locationKey: "browser:initial",
          }),
          { status: "account" },
        );
      }
      assert.equal(touches, 0);
    } finally {
      (globalThis as any).chrome = oldChrome;
    }
  });
  await test("Restore rechecks viewport and model reuse after asynchronous hashing", async () => {
    for (const change of ["scroll", "reuse", "generation"] as const) {
      const r = record();
      let visible = true,
        restores = 0,
        release!: () => void;
      let msg = {
        id: {
          _serialized: r.id,
          remote: { _serialized: r.chat },
          id: r.rawId,
          fromMe: false,
        },
        type: "chat",
        body: "ORIGINAL",
      };
      const lifecycle = new HistoryLifecycle({
        scope: () => ({
          account: "self@c.us",
          chat: r.chat,
          target: r.target,
          revision: "rev",
        }),
        hash: async (text) =>
          text === "self@c.us"
            ? r.account
            : new Promise<string>((resolve) => {
                release = () => resolve(r.originalHash);
              }),
        list: async () => [r],
        save: async () => {},
        visibleIds: () => (visible ? [r.id] : []),
        isVisible: () => visible,
        bubble: () => ({}),
        model: () => msg,
        has: () => false,
        restore: () => {
          restores++;
          return true;
        },
        clear: () => {},
        unavailable: () => {},
      });
      const pending = lifecycle.tick();
      for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
      assert.ok(release);
      if (change === "scroll") visible = false;
      if (change === "reuse") msg = { ...msg };
      if (change === "generation") lifecycle.changed();
      release();
      await pending;
      assert.equal(restores, 0, change);
      lifecycle.stop();
    }
  });
  await test("One hundred displayed records require one visible scan per steady tick", async () => {
    const records = Array.from({ length: 100 }, (_, i) => record(`M${i}`));
    const models = new Map(
      records.map((r) => [
        r.id,
        {
          id: {
            _serialized: r.id,
            remote: { _serialized: r.chat },
            id: r.rawId,
            fromMe: false,
          },
          type: "chat",
          body: "ORIGINAL",
        },
      ]),
    );
    const shown = new Set<string>();
    let scans = 0,
      modelReads = 0,
      targeted = 0;
    const lifecycle = new HistoryLifecycle({
      scope: () => ({
        account: "self@c.us",
        chat: records[0].chat,
        target: records[0].target,
        revision: "rev",
      }),
      hash: async (text) =>
        text === "self@c.us" ? records[0].account : records[0].originalHash,
      list: async () => records,
      save: async () => {},
      visibleIds: () => {
        scans++;
        return records.map((r) => r.id);
      },
      isVisible: () => {
        targeted++;
        return true;
      },
      bubble: () => ({}),
      model: (id) => {
        modelReads++;
        return models.get(id) ?? null;
      },
      has: (id) => shown.has(id),
      restore: (_msg, r) => {
        shown.add(r.id);
        return true;
      },
      clear: () => {},
      unavailable: () => {},
    });
    await lifecycle.tick();
    assert.equal(shown.size, 100);
    assert.equal(scans, 1);
    scans = modelReads = targeted = 0;
    await lifecycle.tick();
    assert.equal(scans, 1);
    assert.equal(modelReads, 0);
    assert.equal(targeted, 0);
    lifecycle.stop();
  });
  await test("History store returns only exact visible account/chat/target identities and excludes extra data", async () => {
    let memory: Record<string, unknown> = {};
    const store = new TranslationHistoryStore({
      get: async () => memory,
      set: async (v) => {
        memory = { ...memory, ...v };
      },
      remove: async (keys) => {
        for (const key of keys) delete memory[key];
      },
    });
    const r = record();
    await store.put({ ...r, original: "PRIVATE", apiKey: "SECRET" });
    assert(!JSON.stringify(memory).includes("PRIVATE"));
    assert(!JSON.stringify(memory).includes("SECRET"));
    assert.equal(
      (await store.list(r.account, r.chat, r.target, r.revision, [r.id]))
        .records.length,
      1,
    );
    assert.equal(
      (await store.list("c".repeat(64), r.chat, r.target, r.revision, [r.id]))
        .records.length,
      0,
    );
    assert.equal(
      (await store.list(r.account, r.chat, r.target, r.revision, [])).records
        .length,
      0,
    );
    assert.equal(
      (
        await store.list(
          r.account,
          r.chat,
          r.target,
          r.revision,
          Array(101).fill(r.id),
        )
      ).status,
      "invalid",
    );
    assert.equal(
      normalizeSavedTranslation({ ...r, originalHash: "not a hash" }),
      null,
    );
    assert.equal(
      normalizeSavedTranslation({ ...r, account: "contact@c.us" }),
      null,
    );
  });
  await test("History serializes concurrent saves, deduplicates exact records and evicts oldest only over capacity", async () => {
    let memory: Record<string, unknown> = {};
    const store = new TranslationHistoryStore(
      {
        get: async () => memory,
        set: async (v) => {
          await Promise.resolve();
          memory = { ...memory, ...v };
        },
        remove: async (keys) => {
          for (const key of keys) delete memory[key];
        },
      },
      2,
      5000,
    );
    await Promise.all([
      store.put(record("ONE", 1)),
      store.put(record("TWO", 2)),
    ]);
    await store.put(record("THREE", 3));
    assert.deepEqual(
      (
        await store.list(
          record().account,
          record().chat,
          record().target,
          "rev",
          [record("ONE").id, record("TWO").id, record("THREE").id],
        )
      ).records.map((v) => v.rawId),
      ["TWO", "THREE"],
    );
    await store.put({ ...record("TWO", 4), translated: "更新" });
    assert.equal((memory[HISTORY_KEY + "Index"] as any).entries.length, 2);
    await store.clear();
    assert.deepEqual((memory[HISTORY_KEY + "Index"] as any).entries, []);
    const noDisk = new TranslationHistoryStore({
      get: async () => {
        throw Error("PRIVATE_URL");
      },
      set: async () => {},
      remove: async () => {},
    });
    assert.equal(await noDisk.put(record()), "unavailable");
  });
  const fixture = () => {
    let scope: HistoryScope | null = {
      account: "self@c.us",
      chat: "100@c.us",
      target: "zh-CN",
      revision: "rev",
    };
    const r = record();
    const msg = {
      id: {
        _serialized: r.id,
        id: r.rawId,
        remote: { _serialized: r.chat },
        fromMe: false,
      },
      type: "chat",
      body: "ORIGINAL",
    };
    let visible = true,
      restored = 0,
      cleared = 0,
      saved = 0;
    const lifecycle = new HistoryLifecycle({
      scope: () => scope,
      hash: async (text) =>
        text === "self@c.us"
          ? r.account
          : text === "ORIGINAL"
            ? r.originalHash
            : "c".repeat(64),
      list: async (_a, _c, _t, _r, ids) => (ids.includes(r.id) ? [r] : []),
      visibleIds: () => (visible ? [r.id] : []),
      save: async () => {
        saved++;
      },
      bubble: () => (visible ? {} : null),
      model: () => msg,
      has: () => false,
      restore: () => {
        restored++;
        return true;
      },
      clear: () => {
        cleared++;
      },
      unavailable: () => {},
    });
    return {
      lifecycle,
      r,
      msg,
      setScope: (s: HistoryScope | null) => (scope = s),
      setVisible: (v: boolean) => (visible = v),
      counts: () => ({ restored, cleared, saved }),
    };
  };
  await test("Cold reload and recycled visible messages restore locally without a translate dependency", async () => {
    const f = fixture();
    f.setVisible(false);
    await f.lifecycle.tick();
    assert.equal(f.counts().restored, 0);
    f.setVisible(true);
    await f.lifecycle.tick();
    assert.equal(f.counts().restored, 1);
    f.msg.body = "EDITED";
    await f.lifecycle.tick();
    assert.equal(f.counts().restored, 1);
    f.setScope({
      account: "other@c.us",
      chat: "100@c.us",
      target: "zh-CN",
      revision: "rev",
    });
    await f.lifecycle.tick();
    assert.equal(f.counts().restored, 1);
    assert.equal(f.counts().cleared, 1);
    f.setScope(null);
    await f.lifecycle.tick();
    assert.equal(f.counts().cleared, 2);
    f.lifecycle.stop();
  });
  await test("History late hashing cannot restore after configuration/chat invalidation", async () => {
    const f = fixture();
    const pending = f.lifecycle.tick();
    f.lifecycle.changed(true);
    f.setScope(null);
    await pending;
    assert.equal(f.counts().restored, 0);
    f.lifecycle.stop();
  });
  await test("History stores a completed original snapshot but refuses late account changes", async () => {
    const f = fixture();
    await f.lifecycle.tick();
    const completed = {
      id: f.r.id,
      chat: f.r.chat,
      rawId: f.r.rawId,
      text: f.msg.body,
      target: f.r.target,
      source: "en",
      translated: "译文",
    };
    await f.lifecycle.completed(completed);
    assert.equal(f.counts().saved, 1);
    const pending = f.lifecycle.completed(completed);
    f.setScope(null);
    await pending;
    assert.equal(f.counts().saved, 1);
    f.lifecycle.stop();
  });
  await test("Successful notes survive five minutes; manual repeat translates model original never appended DOM", async () => {
    let now = 0;
    const calls: string[] = [];
    let note: string | undefined;
    const r = record();
    const msg = {
      id: {
        _serialized: r.id,
        id: r.rawId,
        remote: { _serialized: r.chat },
        fromMe: false,
      },
      isNewMsg: true,
      type: "chat",
      body: "ORIGINAL",
    };
    const controller = new IncomingAnnotations<object>({
      config: () => publicConfig(DEFAULT_CONFIG),
      enabledChat: () => true,
      activeChat: () => r.chat,
      now: () => now,
      bubble: () => ({}),
      translate: async (req) => {
        calls.push(req.text);
        return { translated: "译文", target: req.target, source: "en" };
      },
      show: (_b, text) => {
        note = text;
        return {
          remove: () => {
            note = undefined;
          },
          connected: () => true,
        };
      },
    });
    controller.add(msg);
    await Promise.resolve();
    await Promise.resolve();
    now = 600000;
    controller.refresh();
    assert.equal(note, "译文");
    assert(controller.manualSelect(msg, r.id, r.chat));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls, ["ORIGINAL", "ORIGINAL"]);
    assert.equal(msg.body, "ORIGINAL");
    controller.stop();
  });
  await test("Browser history reads only requested shards, recovers interrupted writes and stays usable after clear", async () => {
    const memory: Record<string, unknown> = {};
    const reads: (string | string[])[] = [];
    let fail = false;
    const storage = {
      get: async (keys: string | string[]) => {
        reads.push(keys);
        return Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).map((k) => [k, memory[k]]),
        );
      },
      set: async (values: Record<string, unknown>) => {
        if (
          fail &&
          Object.keys(values).some((k) => k.startsWith("translatedMessageV1:"))
        ) {
          fail = false;
          throw Error("interrupted");
        }
        Object.assign(memory, values);
      },
      remove: async (keys: string[]) => {
        for (const k of keys) delete memory[k];
      },
    };
    const store = new TranslationHistoryStore(storage);
    await store.put(record("ONE"));
    await store.put(record("TWO"));
    reads.length = 0;
    const r = record("ONE");
    assert.equal(
      (
        await store.list(r.account, r.chat, r.target, "different-provider", [
          r.id,
        ])
      ).records.length,
      1,
    );
    assert.deepEqual((reads[1] as string[]).length, 1);
    assert(reads.every((k) => k !== null));
    fail = true;
    assert.equal(await store.put(record("THREE")), "unavailable");
    assert.equal(await store.put(record("FOUR")), "ok");
    assert.equal((memory[HISTORY_KEY + "Index"] as any).pending.length, 0);
    await store.clear();
    assert.equal(await store.put(record("FIVE")), "ok");
  });
  await test("History uses verified original Unix seconds, marks fallback and evicts old messages despite recent saves", async () => {
    const now = Date.now();
    assert.equal(messageTimestamp(1700000000, now), 1700000000000);
    assert.equal(messageTimestamp(now, now), undefined);
    assert.equal(messageTimestamp(NaN, now), undefined);
    const memory: Record<string, unknown> = {};
    const store = new TranslationHistoryStore(
      {
        get: async () => memory,
        set: async (v) => {
          Object.assign(memory, v);
        },
        remove: async (keys) => {
          for (const k of keys) delete memory[k];
        },
      },
      2,
      10000,
    );
    await store.put({
      ...record("RECENT", now - 100),
      messageAt: now - 100000,
    });
    await store.put({ ...record("FALLBACK", now - 50) });
    await store.put({ ...record("OLD", now), messageAt: 1500000000000 });
    const out = await store.list(
      record().account,
      record().chat,
      record().target,
      "rev",
      [record("RECENT").id, record("FALLBACK").id, record("OLD").id],
    );
    assert.deepEqual(
      out.records.map((r) => r.rawId),
      ["RECENT", "FALLBACK"],
    );
    assert.equal(out.records[0].dateBasis, "message");
    assert.equal(out.records[1].dateBasis, "saved");
  });
  await test("Provider changes restore saved target locally; target changes and stopped old results cannot overwrite", async () => {
    const f = fixture();
    await f.lifecycle.tick();
    f.setScope({
      account: "self@c.us",
      chat: f.r.chat,
      target: f.r.target,
      revision: "new-provider",
    });
    await f.lifecycle.tick();
    assert.equal(f.counts().restored, 2);
    f.setScope({
      account: "self@c.us",
      chat: f.r.chat,
      target: "fr",
      revision: "new-provider",
    });
    await f.lifecycle.tick();
    assert.equal(f.counts().restored, 2);
    f.lifecycle.stop();
  });
  await test("History gate bounds concurrent disk work and minute rate", async () => {
    let now = 0;
    const gate = new HistoryRequestGate(() => now);
    const releases: (() => void)[] = [];
    const jobs = Array.from({ length: 8 }, () =>
      gate.run(() => new Promise<void>((resolve) => releases.push(resolve))),
    );
    assert.deepEqual(await gate.run(async () => true), { status: "busy" });
    releases.forEach((r) => r());
    await Promise.all(jobs);
    for (let i = 0; i < 112; i++) await gate.run(async () => true);
    assert.deepEqual(await gate.run(async () => true), { status: "busy" });
    now = 60001;
    assert.equal(await gate.run(async () => true), true);
  });
  await test("Stale settings location token cannot clear or resize a newer selected library", async () => {
    const oldChrome = globalThis.chrome;
    const memory: Record<string, unknown> = {};
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => memory,
          set: async (v: Record<string, unknown>) => Object.assign(memory, v),
          remove: async (keys: string[]) => {
            for (const k of keys) delete memory[k];
          },
        },
      },
    };
    try {
      const backend = new HistoryBackend(),
        before = await backend.snapshot();
      const configured = await backend.configure(
        { mode: "browser", maxMiB: 2 },
        before.locationKey,
      );
      assert.equal(configured.status, "ok");
      assert.equal(
        (await backend.clear(before.locationKey)).status,
        "conflict",
      );
      assert.equal(
        (
          await backend.configure(
            { mode: "browser", maxMiB: 1 },
            before.locationKey,
          )
        ).status,
        "conflict",
      );
      const latest = await backend.snapshot();
      assert.equal(latest.settings.maxMiB, 2);
      assert.equal((await backend.clear(latest.locationKey)).status, "ok");
      assert.notEqual(
        (await backend.snapshot()).locationKey,
        latest.locationKey,
      );
    } finally {
      (globalThis as any).chrome = oldChrome;
    }
  });
  await test("Visible date hints use exact model metadata without reading bodies or guessing unknown dates", async () => {
    const r = record();
    let timestamp: unknown = 1700000000;
    let correctChat = true;
    let bubbleVisible = true;
    const calls: unknown[][] = [];
    const reads: string[] = [];
    const model = {
      get id() {
        return {
          _serialized: correctChat ? r.id : "false_200@c.us_ONE",
          id: r.rawId,
          remote: { _serialized: correctChat ? r.chat : "200@c.us" },
          fromMe: false,
        };
      },
      get t() {
        return timestamp;
      },
      get body(): string {
        throw Error("Metadata lookup must not read original text");
      },
      type: "chat",
    };
    const lifecycle = new HistoryLifecycle({
      scope: () => ({
        account: "self@c.us",
        chat: r.chat,
        target: r.target,
        revision: "rev",
      }),
      hash: async () => r.account,
      list: async (...args) => {
        calls.push(args);
        return [];
      },
      save: async () => {},
      visibleIds: () => [r.id],
      bubble: () => (bubbleVisible ? {} : null),
      model: (id) => {
        reads.push(id);
        return model;
      },
      has: () => false,
      restore: () => false,
      clear: () => {},
      unavailable: () => {},
    });
    await lifecycle.tick();
    assert.deepEqual(calls[0][4], [r.id]);
    assert.deepEqual(calls[0][5], [
      { id: r.id, rawId: r.rawId, date: "2023-11-14" },
    ]);
    timestamp = undefined;
    await lifecycle.tick();
    assert.deepEqual(
      calls[1][5],
      [],
      "Unknown timestamp never guesses a date or requests a scan",
    );
    timestamp = "1700000000";
    lifecycle.changed();
    await lifecycle.tick();
    assert.deepEqual(calls[2][5], []);
    timestamp = 1700000000;
    correctChat = false;
    lifecycle.changed();
    await lifecycle.tick();
    assert.deepEqual(calls[3][5], []);
    correctChat = true;
    bubbleVisible = false;
    lifecycle.changed();
    await lifecycle.tick();
    assert.deepEqual(calls[4][5], []);
    assert(
      reads.every((id) => id === r.id),
      "No nonvisible models looked up",
    );
    lifecycle.stop();
  });
  await test("Serialized storage rejects older tab retry and equal-time conflict while allowing idempotence", async () => {
    const memory: Record<string, unknown> = {};
    const store = new TranslationHistoryStore({
      get: async () => memory,
      set: async (v) => {
        Object.assign(memory, v);
      },
      remove: async (keys) => {
        for (const key of keys) delete memory[key];
      },
    });
    const older = { ...record("RACE", 100), translated: "old" };
    const newer = { ...record("RACE", 200), translated: "new" };
    assert.equal(await store.put(newer), "ok");
    assert.equal(await store.put(older), "superseded");
    assert.equal(
      await store.put({ ...newer, translated: "same-time conflict" }),
      "superseded",
    );
    assert.equal(await store.put(newer), "ok");
    assert.equal(
      (
        await store.list(
          newer.account,
          newer.chat,
          newer.target,
          newer.revision,
          [newer.id],
        )
      ).records[0].translated,
      "new",
    );
    const results = await Promise.all([
      store.put({ ...newer, savedAt: 300, translated: "first" }),
      store.put({ ...newer, savedAt: 300, translated: "second" }),
      store.put(older),
    ]);
    assert.deepEqual(results, ["ok", "superseded", "superseded"]);
    assert.equal(
      (
        await store.list(
          newer.account,
          newer.chat,
          newer.target,
          newer.revision,
          [newer.id],
        )
      ).records[0].translated,
      "first",
    );
  });
  return count;
}
