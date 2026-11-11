import assert from "node:assert/strict";
import {
  DirectoryHistoryStore,
  historyDigest,
  compactHistoryDigest,
  type HistoryDirectory,
  type HistoryFile,
  type DirectoryDateHint,
} from "../src/shared/directory-history";
import {
  historyDate,
  type SavedTranslation,
} from "../src/shared/translation-history";
const missing = () =>
  Object.assign(new Error("missing"), { name: "NotFoundError" });
class FakeFile implements HistoryFile {
  kind = "file" as const;
  text = "";
  bodyReads = 0;
  failClose = false;
  async getFile() {
    return {
      size: new TextEncoder().encode(this.text).length,
      text: async () => {
        this.bodyReads++;
        return this.text;
      },
    };
  }
  async createWritable() {
    let next = "";
    return {
      write: async (value: string) => {
        next = value;
      },
      close: async () => {
        if (this.failClose) throw Error("interrupted");
        this.text = next;
      },
      abort: async () => {},
    };
  }
}
class FakeDirectory implements HistoryDirectory {
  kind = "directory" as const;
  permission: PermissionState = "granted";
  dirs = new Map<string, FakeDirectory>();
  files = new Map<string, FakeFile>();
  deleted: string[] = [];
  constructor(public name = "selected") {}
  async queryPermission() {
    return this.permission;
  }
  async requestPermission() {
    return this.permission;
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) throw missing();
      dir = new FakeDirectory(name);
      this.dirs.set(name, dir);
    }
    return dir;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    let file = this.files.get(name);
    if (!file) {
      if (!options?.create) throw missing();
      file = new FakeFile();
      this.files.set(name, file);
    }
    return file;
  }
  async removeEntry(name: string, options?: { recursive?: boolean }) {
    assert(!options?.recursive);
    if (!this.files.has(name)) throw missing();
    this.deleted.push(name);
    this.files.delete(name);
  }
  async *entries(): AsyncIterableIterator<[string, FakeDirectory | FakeFile]> {
    for (const item of this.dirs) yield item;
    for (const item of this.files) yield item;
  }
  allFiles(prefix = ""): Array<{ path: string; file: FakeFile }> {
    return [...this.files]
      .map(([name, file]) => ({ path: prefix + name, file }))
      .concat(
        [...this.dirs].flatMap(([name, dir]) =>
          dir.allFiles(prefix + name + "/"),
        ),
      );
  }
}
const owner = "1".repeat(32),
  account = "a".repeat(64);
const record = (
  id: string,
  time = 1700000000000,
  chat = "100@c.us",
  acc = account,
): SavedTranslation => ({
  account: acc,
  id: `false_${chat}_${id}`,
  chat,
  rawId: id,
  originalHash: "c".repeat(64),
  target: "zh-CN",
  revision: "r1",
  translated: `译文 ${id}`,
  source: "en",
  engine: "service:google",
  savedAt: time,
  dateBasis: "saved",
});
const hint = (r: SavedTranslation): DirectoryDateHint => ({
  id: r.id,
  rawId: r.rawId,
  date: new Date(historyDate(r)).toISOString().slice(0, 10),
});
const bodies = (d: FakeDirectory) =>
  d.allFiles().filter((f) => !f.path.endsWith("/owner.json"));
export async function runDirectoryHistoryTests(): Promise<number> {
  let count = 0;
  const test = async (name: string, fn: () => Promise<void>) => {
    await fn();
    count++;
    console.log("PASS", name);
  };
  await test("Simple directory records use message date and exact visible hints without manifests or content hashes", async () => {
    const dir = new FakeDirectory(),
      selection = { directory: dir, namespace: owner };
    const store = new DirectoryHistoryStore(selection, { bytes: 1024 * 1024 });
    const a = record("A"),
      b = record("B"),
      other = record("C", 1700000000000, "200@c.us"),
      account2 = record("D", 1700000000000, "100@c.us", "b".repeat(64));
    for (const r of [a, b, other, account2])
      assert.equal(await store.put(r), "ok");
    assert(
      dir
        .allFiles()
        .every(
          (f) => !f.path.includes("index-") && !f.path.includes("manifest"),
        ),
    );
    assert(bodies(dir).some((f) => f.path.endsWith("/A.zh-CN.json")));
    assert(bodies(dir).every((f) => !f.path.includes("@")));
    bodies(dir).forEach((f) => (f.file.bodyReads = 0));
    const restart = new DirectoryHistoryStore(selection, {
      bytes: 1024 * 1024,
    });
    assert.deepEqual(
      (
        await restart.list(
          account,
          a.chat,
          a.target,
          "new-provider",
          [a.id],
          [hint(a)],
        )
      ).records,
      [a],
    );
    assert.equal(
      bodies(dir).reduce((n, f) => n + f.file.bodyReads, 0),
      1,
      "only the hinted visible record body is read",
    );
    assert.deepEqual(
      (await restart.list(account, a.chat, a.target, "r1", [b.id])).records,
      [],
      "no date hint means no scanning",
    );
    assert.equal(
      (
        await restart.list(
          account,
          a.chat,
          a.target,
          "r1",
          [a.id],
          [{ ...hint(a), date: "../../escape" }],
        )
      ).status,
      "invalid",
    );
    assert.equal(
      (
        await restart.list(
          account,
          a.chat,
          a.target,
          "r1",
          [a.id],
          [{ ...hint(a), rawId: "../A" }],
        )
      ).status,
      "invalid",
    );
    assert.equal(
      (
        await restart.list(
          account,
          a.chat,
          a.target,
          "r1",
          Array(101).fill(a.id),
          [],
        )
      ).status,
      "invalid",
    );
  });
  await test("Original message date controls oldest cleanup and missing timestamp uses saved date", async () => {
    const dir = new FakeDirectory(),
      store = new DirectoryHistoryStore(
        { directory: dir, namespace: owner },
        { bytes: 1024 * 1024, entries: 1 },
      );
    const newer = {
      ...record("NEW", 1700000000000),
      messageAt: 1600000000000,
      dateBasis: "message" as const,
    };
    const oldSavedLater = {
      ...record("OLD", 1800000000000),
      account: "b".repeat(64),
      messageAt: 1500000000000,
      dateBasis: "message" as const,
    };
    assert.equal(await store.put(newer), "ok");
    assert.equal(await store.put(oldSavedLater), "ok");
    assert.deepEqual(
      (
        await store.list(
          account,
          newer.chat,
          newer.target,
          "r1",
          [newer.id, oldSavedLater.id],
          [hint(newer), hint(oldSavedLater)],
        )
      ).records,
      [newer],
    );
    assert(bodies(dir)[0].path.includes(hint(newer).date));
    const fallback = record("FALLBACK", 1700000000001);
    assert.equal(await store.put(fallback), "ok");
    assert.deepEqual(
      (
        await store.list(
          account,
          fallback.chat,
          fallback.target,
          "r1",
          [fallback.id],
          [hint(fallback)],
        )
      ).records,
      [fallback],
    );
    assert(bodies(dir)[0].path.includes(hint(fallback).date));
  });
  await test("Capacity scans names/sizes and reads only actual oldest deletion candidates", async () => {
    const dir = new FakeDirectory(),
      store = new DirectoryHistoryStore(
        { directory: dir, namespace: owner },
        { bytes: 1024 * 1024, entries: 2 },
      );
    const a = record("A", 1500000000000),
      b = record("B", 1600000000000),
      c = record("C", 1700000000000);
    await store.put(a);
    await store.put(b);
    bodies(dir).forEach((f) => (f.file.bodyReads = 0));
    const aFile = bodies(dir).find((f) =>
      f.path.endsWith("/A.zh-CN.json"),
    )!.file;
    const bFile = bodies(dir).find((f) =>
      f.path.endsWith("/B.zh-CN.json"),
    )!.file;
    assert.equal(await store.put(c), "ok");
    assert.equal(aFile.bodyReads, 2);
    assert.equal(bFile.bodyReads, 0);
    assert.equal(bodies(dir).length, 2);
    store.setLimits({ bytes: 1, entries: 1 });
    assert.equal(await store.prune(), "ok");
    assert.equal(bodies(dir).length, 0);
  });
  await test("Same-day cleanup uses exact message time rather than filename or save order", async () => {
    const dir = new FakeDirectory();
    const store = new DirectoryHistoryStore(
      { directory: dir, namespace: owner },
      { bytes: 1024 * 1024, entries: 1 },
    );
    const newer = {
      ...record("A_NEW", 1700000090000),
      messageAt: 1700000002000,
      dateBasis: "message" as const,
    };
    const older = {
      ...record("Z_OLD", 1700000100000),
      account: "b".repeat(64),
      messageAt: 1700000001000,
      dateBasis: "message" as const,
    };
    assert.equal(await store.put(newer), "ok");
    assert.equal(await store.put(older), "ok");
    assert.deepEqual(
      (
        await store.list(
          account,
          newer.chat,
          newer.target,
          "r1",
          [newer.id, older.id],
          [hint(newer), hint(older)],
        )
      ).records,
      [newer],
    );
    assert(
      !bodies(dir).some((f) => f.path.endsWith("/Z_OLD.zh-CN.json")),
      "Older message in another account is pruned despite later save time",
    );
    const fallback = record("Z_FALLBACK", 1700000003000);
    assert.equal(await store.put(fallback), "ok");
    assert.deepEqual(
      (
        await store.list(
          account,
          fallback.chat,
          fallback.target,
          "r1",
          [fallback.id, newer.id],
          [hint(fallback), hint(newer)],
        )
      ).records,
      [fallback],
    );
  });
  await test("Unknown files and the previous complex namespace are never migrated or deleted", async () => {
    const dir = new FakeDirectory();
    const legacy = await dir.getDirectoryHandle(`wa-web-translate-${owner}`, {
      create: true,
    });
    const old = await legacy.getFileHandle("index-a.json", { create: true });
    old.text = "OLD FORMAT KEEP";
    const unrelated = await dir.getFileHandle("user.json", { create: true });
    unrelated.text = "USER KEEP";
    const store = new DirectoryHistoryStore(
      { directory: dir, namespace: owner },
      { bytes: 1024 * 1024 },
    );
    const a = record("A");
    await store.put(a);
    await store.clear();
    assert.equal(old.text, "OLD FORMAT KEEP");
    assert.equal(old.bodyReads, 0);
    assert.equal(unrelated.text, "USER KEEP");
    await store.put(a);
    const root = dir.dirs.get(`wa-web-translate-dates-${owner}`)!;
    const day = await root.getDirectoryHandle("1970-01-01", { create: true });
    const acc = await day.getDirectoryHandle(account, { create: true });
    const chat = await acc.getDirectoryHandle(await historyDigest(a.chat), {
      create: true,
    });
    const unknown = await chat.getFileHandle("UNKNOWN.zh-CN.json", {
      create: true,
    });
    unknown.text = "NOT A PLUGIN RECORD";
    store.setLimits({ bytes: 1 });
    assert.equal(await store.prune(), "corrupt");
    assert.equal(unknown.text, "NOT A PLUGIN RECORD");
    assert(chat.files.has("UNKNOWN.zh-CN.json"));
    const collisionDir = new FakeDirectory();
    await collisionDir.getDirectoryHandle(`wa-web-translate-dates-${owner}`, {
      create: true,
    });
    const collision = new DirectoryHistoryStore(
      { directory: collisionDir, namespace: owner },
      { bytes: 1024 * 1024 },
    );
    assert.equal(await collision.put(a), "corrupt");
  });
  await test("Single-file replacement rejects full-ID collision and reports interrupted writes without touching original", async () => {
    const dir = new FakeDirectory(),
      store = new DirectoryHistoryStore(
        { directory: dir, namespace: owner },
        { bytes: 1024 * 1024 },
      );
    const a = record("A"),
      b = record("B");
    assert.deepEqual(await Promise.all([store.put(a), store.put(b)]), [
      "ok",
      "ok",
    ]);
    assert.equal(await store.put({ ...a, id: a.id + "_OTHER" }), "corrupt");
    const file = bodies(dir).find((f) =>
      f.path.endsWith("/A.zh-CN.json"),
    )!.file;
    file.failClose = true;
    assert.equal(
      await store.put({
        ...a,
        savedAt: a.savedAt + 1,
        translated: "replacement",
      }),
      "unavailable",
    );
    file.failClose = false;
    assert.deepEqual(
      (await store.list(account, a.chat, a.target, "r1", [a.id], [hint(a)]))
        .records,
      [a],
    );
    assert.equal(
      await store.put({
        ...a,
        savedAt: a.savedAt + 1,
        translated: "replacement",
        revision: "new",
        engine: "llm:deepseek",
      }),
      "ok",
    );
    assert.equal(
      bodies(dir).filter((f) => f.path.endsWith("/A.zh-CN.json")).length,
      1,
    );
  });
  await test("Expired permissions and inactive selection never request grants or write directories", async () => {
    const dir = new FakeDirectory();
    let prompts = 0;
    dir.requestPermission = async () => {
      prompts++;
      return "granted";
    };
    dir.permission = "prompt";
    let current = true;
    const store = new DirectoryHistoryStore(
      { directory: dir, namespace: owner },
      { bytes: 1024 * 1024 },
      async () => current,
    );
    const a = record("A");
    assert.equal(await store.put(a), "permission");
    assert.equal(prompts, 0);
    assert.equal(dir.allFiles().length, 0);
    dir.permission = "granted";
    assert.equal(await store.put(a), "ok");
    current = false;
    assert.equal(await store.clear(), "unavailable");
    assert.equal(
      (await store.list(account, a.chat, a.target, "r1", [a.id], [hint(a)]))
        .status,
      "unavailable",
    );
  });
  const { runDirectorySelectionTests } = await import(
    "./directory-selection-regression"
  );
  count += await runDirectorySelectionTests();
  await test("Serialized storage rejects older tab retry and equal-time conflict while allowing idempotence", async () => {
    const store = new DirectoryHistoryStore(
      { directory: new FakeDirectory(), namespace: owner },
      { bytes: 1024 * 1024 },
    );
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
          [hint(newer)],
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
          [hint(newer)],
        )
      ).records[0].translated,
      "first",
    );
  });
  await test("Directory browser permission and quota exceptions map to controlled statuses", async () => {
    for (const [name, status] of [
      ["NotAllowedError", "permission"],
      ["SecurityError", "permission"],
      ["QuotaExceededError", "full"],
      ["UnknownError", "unavailable"],
    ]) {
      const dir = new FakeDirectory();
      dir.queryPermission = async () => {
        throw Object.assign(new Error("PRIVATE DIRECTORY"), { name });
      };
      const store = new DirectoryHistoryStore(
        { directory: dir, namespace: owner },
        { bytes: 1024 * 1024 },
      );
      assert.equal(await store.put(record("ERROR")), status);
    }
  });
  await test("Realistic writer creation and close failures expose only bounded stage codes", async () => {
    for (const stage of ["writer", "close"]) {
      const dir = new FakeDirectory(),
        store = new DirectoryHistoryStore(
          { directory: dir, namespace: owner },
          { bytes: 1024 * 1024 },
        );
      const r = record("FAILURE");
      await store.put(r);
      const file = bodies(dir).find((f) =>
        f.path.endsWith("/FAILURE.zh-CN.json"),
      )!.file;
      if (stage === "writer")
        file.createWritable = async () => {
          throw new TypeError("SECRET_PATH_OR_CONTENT");
        };
      else file.failClose = true;
      assert.equal(
        await store.put({ ...r, savedAt: r.savedAt + 1, translated: "new" }),
        "unavailable",
      );
      assert.deepEqual(store.getWriteFailure(), {
        stage: "record_" + stage,
        error: stage === "writer" ? "TypeError" : "unknown",
      });
      assert(!JSON.stringify(store.getWriteFailure()).includes("SECRET"));
    }
  });
  await test("First absent file uses create true and concurrent repeats preserve newest result", async () => {
    const dir = new FakeDirectory(),
      store = new DirectoryHistoryStore(
        { directory: dir, namespace: owner },
        { bytes: 1024 * 1024 },
      );
    const r = record("FIRST");
    assert.equal(await store.put(r), "ok");
    assert.equal(await store.put(r), "ok");
    assert.deepEqual(
      await Promise.all([
        store.put({ ...r, savedAt: r.savedAt + 2, translated: "new" }),
        store.put({ ...r, savedAt: r.savedAt + 1, translated: "old" }),
      ]),
      ["ok", "superseded"],
    );
    assert.equal(bodies(dir).length, 1);
  });
  await test("Pre-writer NotFound reacquires only verified child folders and rechecks replacement records", async () => {
    for (const replacement of ["empty", "unknown", "newer"] as const) {
      const selected = new FakeDirectory(),
        store = new DirectoryHistoryStore(
          { directory: selected, namespace: owner },
          { bytes: 1024 * 1024 },
        );
      const r = record("DETACHED");
      await store.put(r);
      const root = selected.dirs.get("wa-web-translate-dates-" + owner)!;
      const day = root.dirs.get(hint(r).date)!,
        accountDir = day.dirs.get(compactHistoryDigest(account))!;
      const chatName = compactHistoryDigest(await historyDigest(r.chat)),
        oldDir = accountDir.dirs.get(chatName)!;
      oldDir.files.clear();
      let failures = 0;
      oldDir.getFileHandle = async (_name, options) => {
        if (!options?.create) throw missing();
        failures++;
        const next = new FakeDirectory(chatName);
        if (replacement !== "empty") {
          const f = await next.getFileHandle("DETACHED.zh-CN.json", {
            create: true,
          });
          f.text =
            replacement === "unknown"
              ? "USER UNKNOWN"
              : JSON.stringify({
                  format: "wa-translate-dated-record-v2",
                  owner,
                  record: {
                    ...r,
                    savedAt: r.savedAt + 10,
                    translated: "newest",
                  },
                });
        }
        accountDir.dirs.set(chatName, next);
        throw missing();
      };
      assert.equal(
        await store.put({ ...r, savedAt: r.savedAt + 1 }),
        replacement === "empty"
          ? "ok"
          : replacement === "unknown"
            ? "corrupt"
            : "superseded",
      );
      assert.equal(failures, 1);
      if (replacement === "unknown")
        assert.equal(
          accountDir.dirs.get(chatName)!.files.get("DETACHED.zh-CN.json")!.text,
          "USER UNKNOWN",
        );
    }
  });
  await test("Missing root, persistent NotFound and writer NotFound never receive unsafe retries", async () => {
    for (const mode of ["root", "persistent", "writer"] as const) {
      const selected = new FakeDirectory(),
        store = new DirectoryHistoryStore(
          { directory: selected, namespace: owner },
          { bytes: 1024 * 1024 },
        );
      const r = record("BOUND");
      await store.put(r);
      const root = selected.dirs.get("wa-web-translate-dates-" + owner)!;
      const child = root.dirs
        .get(hint(r).date)!
        .dirs.get(compactHistoryDigest(account))!
        .dirs.get(compactHistoryDigest(await historyDigest(r.chat)))!;
      child.files.clear();
      let calls = 0;
      child.getFileHandle = async (_name, options) => {
        if (!options?.create) throw missing();
        calls++;
        if (mode === "root") selected.dirs.clear();
        if (mode === "writer") {
          const f = new FakeFile();
          f.createWritable = async () => {
            throw missing();
          };
          return f;
        }
        throw missing();
      };
      assert.equal(
        await store.put({ ...r, savedAt: r.savedAt + 1 }),
        "unavailable",
      );
      assert.equal(calls, mode === "persistent" ? 2 : 1);
      if (mode === "root") assert.equal(selected.dirs.size, 0);
      if (mode === "writer")
        assert.equal(store.getWriteFailure()?.stage, "record_writer");
    }
  });
  await test("Compact directories retain all digest bits and keep ordinary record paths below legacy Windows limit", async () => {
    const encoded = compactHistoryDigest(account);
    assert.equal(encoded.length, 43);
    assert.equal(Buffer.from(encoded, "base64url").toString("hex"), account);
    assert.notEqual(encoded, compactHistoryDigest(account.slice(0, 63) + "b"));
    const relative = [
      "wa-web-translate-dates-" + owner,
      "2026-11-11",
      encoded,
      encoded,
      "x".repeat(32) + ".zh-CN.json",
    ].join("/");
    assert.equal(relative.length, 198);
    assert.equal(40 + 1 + relative.length, 239);
  });
  await test("Legacy hex paths restore only requested IDs and preserve newer legacy versions without migration", async () => {
    const selected = new FakeDirectory(),
      store = new DirectoryHistoryStore(
        { directory: selected, namespace: owner },
        { bytes: 1024 * 1024 },
      );
    await store.put(record("INIT"));
    const r = { ...record("LEGACY"), savedAt: 1700000000100 };
    const root = selected.dirs.get("wa-web-translate-dates-" + owner)!;
    let dir = await root.getDirectoryHandle(hint(r).date, { create: true });
    dir = await dir.getDirectoryHandle(account, { create: true });
    dir = await dir.getDirectoryHandle(await historyDigest(r.chat), {
      create: true,
    });
    const file = await dir.getFileHandle("LEGACY.zh-CN.json", { create: true });
    file.text = JSON.stringify({
      format: "wa-translate-dated-record-v2",
      owner,
      record: r,
    });
    const original = file.text;
    const unseen = await dir.getFileHandle("UNSEEN.zh-CN.json", {
      create: true,
    });
    unseen.text = "KEEP UNKNOWN";
    const result = await store.list(
      account,
      r.chat,
      r.target,
      "r1",
      [r.id],
      [hint(r)],
    );
    assert.equal(result.records[0].translated, r.translated);
    assert.equal(unseen.bodyReads, 0);
    assert.equal(
      await store.put({ ...r, savedAt: r.savedAt - 1 }),
      "superseded",
    );
    assert.equal(
      await store.put({
        ...r,
        savedAt: r.savedAt + 1,
        translated: "new short path",
      }),
      "ok",
    );
    assert.equal(
      (await store.list(account, r.chat, r.target, "r1", [r.id], [hint(r)]))
        .records[0].translated,
      "new short path",
    );
    assert.equal(file.text, original);
    assert.equal(unseen.bodyReads, 0);
  });
  await test("Cross-layout capacity pruning never retains stale duplicate over newest and ties match restore", async () => {
    for (const ordering of ["compact-new", "legacy-new", "equal"] as const)
      for (const limit of ["count", "bytes"] as const) {
        const selected = new FakeDirectory(),
          store = new DirectoryHistoryStore(
            { directory: selected, namespace: owner },
            { bytes: 1024 * 1024 },
          );
        const base = {
          ...record("DUPLICATE"),
          messageAt: 1699999000000,
          dateBasis: "message" as const,
        };
        const compact = {
          ...base,
          savedAt: base.savedAt + (ordering === "compact-new" ? 2 : 1),
          translated: "COMPACT",
        };
        const legacy = {
          ...base,
          savedAt: base.savedAt + (ordering === "legacy-new" ? 2 : 1),
          translated: "LEGACY",
        };
        assert.equal(await store.put(compact), "ok");
        const root = selected.dirs.get("wa-web-translate-dates-" + owner)!;
        let dir = await root.getDirectoryHandle(hint(base).date, {
          create: true,
        });
        dir = await dir.getDirectoryHandle(account, { create: true });
        dir = await dir.getDirectoryHandle(await historyDigest(base.chat), {
          create: true,
        });
        const file = await dir.getFileHandle("DUPLICATE.zh-CN.json", {
          create: true,
        });
        file.text = JSON.stringify({
          format: "wa-translate-dated-record-v2",
          owner,
          record: legacy,
        });
        const expected = ordering === "legacy-new" ? "LEGACY" : "COMPACT";
        assert.equal(
          (
            await store.list(
              account,
              base.chat,
              base.target,
              "r1",
              [base.id],
              [hint(base)],
            )
          ).records[0].translated,
          expected,
        );
        if (limit === "count")
          store.setLimits({ bytes: 1024 * 1024, entries: 1 });
        else
          store.setLimits({
            bytes:
              512 +
              Math.max(
                ...bodies(selected).map(
                  (f) => new TextEncoder().encode(f.file.text).length,
                ),
              ),
            entries: 100,
          });
        assert.equal(await store.prune(), "ok");
        assert.equal(bodies(selected).length, 1);
        assert.equal(
          (
            await store.list(
              account,
              base.chat,
              base.target,
              "r1",
              [base.id],
              [hint(base)],
            )
          ).records[0].translated,
          expected,
          ordering + "/" + limit,
        );
      }
  });
  return count;
}
