import {
  historyDate,
  historyWriteDecision,
  historyIdentity,
  normalizeSavedTranslation,
  validHash,
  type SavedTranslation,
} from "./translation-history";
import { validChatId } from "./chat-directions";
import { getLanguage } from "./languages";

export interface HistoryFile {
  kind?: "file";
  getFile(): Promise<{ size: number; text(): Promise<string> }>;
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}
export interface HistoryDirectory {
  kind?: "directory";
  name: string;
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<HistoryDirectory>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<HistoryFile>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries?(): AsyncIterableIterator<[string, HistoryDirectory | HistoryFile]>;
}
export interface DirectorySelection {
  directory: HistoryDirectory;
  namespace: string;
}
export interface DirectoryHistoryLimits {
  bytes: number;
  entries?: number;
}
export type DirectoryHistoryStatus =
  | "ok"
  | "full"
  | "invalid"
  | "permission"
  | "unavailable"
  | "corrupt"
  | "superseded";
export interface DirectoryDateHint {
  id: string;
  rawId: string;
  date: string;
}
interface Envelope {
  format: "wa-translate-dated-record-v2";
  owner: string;
  record: SavedTranslation;
}
interface Located {
  date: string;
  account: string;
  chat: string;
  file: string;
  directory: HistoryDirectory;
  bytes: number;
}
const OWNER_FORMAT = "wa-translate-dated-owner-v2";
const RECORD_FORMAT = "wa-translate-dated-record-v2";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RECORDS = 10000;
const MAX_SCAN = 30000;
const token = /^[a-f0-9]{32}$/;
const hash = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const raw = /^[A-Za-z0-9_-]{1,180}$/;
const namedRecord = /^[A-Za-z0-9_-]{1,180}\.[A-Za-z-]{2,20}\.json$/;
const safeText = (v: unknown, max: number): v is string =>
  typeof v === "string" && !!v && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const notFound = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  (error as { name?: unknown }).name === "NotFoundError";
class DirectoryFailure extends Error {
  constructor(readonly status: DirectoryHistoryStatus) {
    super("Local translation directory unavailable");
  }
}
const statusOf = (e: unknown): DirectoryHistoryStatus => {
  if (e instanceof DirectoryFailure) return e.status;
  const name =
    e && typeof e === "object" ? (e as { name?: unknown }).name : null;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "permission";
  if (name === "QuotaExceededError") return "full";
  return "unavailable";
};
const byteLength = (s: string) => new TextEncoder().encode(s).length;
function validDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < "1970-01-01"
  )
    return false;
  const date = new Date(value + "T00:00:00.000Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
// Identity-only directory naming. There are no per-file content hashes,
// manifests, journals, random version files or checksum-based cleanup.
export async function historyDigest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
// Lossless filename encoding of the existing 256-bit identity digest.
export function compactHistoryDigest(hex: string): string {
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new DirectoryFailure("invalid");
  const binary = hex
    .match(/../g)!
    .map((v) => String.fromCharCode(parseInt(v, 16)))
    .join("");
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
const matchesHistoryDigest = (hex: string, folder: string) =>
  hex === folder || compactHistoryDigest(hex) === folder;
const recordFile = (rawId: string, target: string) => `${rawId}.${target}.json`;
function recordDate(record: SavedTranslation): string | null {
  const time = historyDate(record);
  if (!Number.isSafeInteger(time) || time < 0 || time > 253402300799999)
    return null;
  return new Date(time).toISOString().slice(0, 10);
}
export class DirectoryHistoryStore {
  private tail: Promise<unknown> = Promise.resolve();
  private writeStage = "start";
  private writeFailure: { stage: string; error: string } | null = null;
  getWriteFailure() {
    return this.writeFailure;
  }
  private limits: { bytes: number; entries: number };
  constructor(
    private selection: DirectorySelection,
    limits: DirectoryHistoryLimits,
    private isCurrent: () => Promise<boolean> = async () => true,
  ) {
    this.limits = {
      bytes: limits.bytes,
      entries: limits.entries ?? MAX_RECORDS,
    };
  }
  setLimits(limits: DirectoryHistoryLimits) {
    this.limits = {
      bytes: limits.bytes,
      entries: limits.entries ?? MAX_RECORDS,
    };
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const task = this.tail.then(run, run);
    this.tail = task.catch(() => {});
    return task;
  }
  private async permission() {
    if (!(await this.isCurrent())) throw new DirectoryFailure("unavailable");
    if (
      !token.test(this.selection.namespace) ||
      !Number.isSafeInteger(this.limits.bytes) ||
      this.limits.bytes < 1 ||
      this.limits.bytes > 1024 * 1024 * 1024 ||
      !Number.isInteger(this.limits.entries) ||
      this.limits.entries < 1 ||
      this.limits.entries > MAX_RECORDS
    )
      throw new DirectoryFailure("invalid");
    if (
      (await this.selection.directory.queryPermission({
        mode: "readwrite",
      })) !== "granted"
    )
      throw new DirectoryFailure("permission");
  }
  private async read(
    dir: HistoryDirectory,
    name: string,
    max: number,
  ): Promise<{ text: string; bytes: number } | null> {
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      if (file.size > max) throw new DirectoryFailure("corrupt");
      return { text: await file.text(), bytes: file.size };
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  }
  private async write(dir: HistoryDirectory, name: string, text: string) {
    await this.permission();
    const prefix = name === "owner.json" ? "owner" : "record";
    this.writeStage = prefix + "_open";
    const file = await dir.getFileHandle(name, { create: true });
    this.writeStage = prefix + "_writer";
    const writable = await file.createWritable();
    try {
      this.writeStage = prefix + "_write";
      await writable.write(text);
      this.writeStage = prefix + "_close";
      await writable.close();
    } catch (e) {
      try {
        await writable.abort?.();
      } catch {}
      throw e;
    }
  }
  private async root(create = false): Promise<HistoryDirectory | null> {
    await this.permission();
    // The previous complex-format namespace is deliberately never opened,
    // migrated or deleted by this implementation.
    const name = `wa-web-translate-dates-${this.selection.namespace}`;
    let dir: HistoryDirectory,
      created = false;
    try {
      dir = await this.selection.directory.getDirectoryHandle(name);
    } catch (e) {
      if (!notFound(e)) throw e;
      if (!create) return null;
      dir = await this.selection.directory.getDirectoryHandle(name, {
        create: true,
      });
      created = true;
    }
    const marker = await this.read(dir, "owner.json", 512);
    if (!marker) {
      if (!created) throw new DirectoryFailure("corrupt");
      await this.write(
        dir,
        "owner.json",
        JSON.stringify({
          format: OWNER_FORMAT,
          owner: this.selection.namespace,
        }),
      );
    } else {
      let value: any;
      try {
        value = JSON.parse(marker.text);
      } catch {
        throw new DirectoryFailure("corrupt");
      }
      if (
        value?.format !== OWNER_FORMAT ||
        value?.owner !== this.selection.namespace
      )
        throw new DirectoryFailure("corrupt");
    }
    return dir;
  }
  private async folder(
    root: HistoryDirectory,
    date: string,
    account: string,
    chat: string,
    create = false,
    legacy = false,
  ): Promise<HistoryDirectory | null> {
    let dir = root;
    try {
      for (const name of [
        date,
        legacy ? account : compactHistoryDigest(account),
        legacy ? chat : compactHistoryDigest(chat),
      ])
        dir = await dir.getDirectoryHandle(name, { create });
      return dir;
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  }
  private parse(
    text: string,
    date: string,
    account: string,
    chat: string,
    file: string,
  ): SavedTranslation | null {
    let value: Envelope;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    const record = normalizeSavedTranslation(value.record);
    if (
      value?.format !== RECORD_FORMAT ||
      value?.owner !== this.selection.namespace ||
      !record ||
      (record.account !== account &&
        compactHistoryDigest(record.account) !== account) ||
      recordDate(record) !== date ||
      !raw.test(record.rawId) ||
      recordFile(record.rawId, record.target) !== file
    )
      return null;
    return record;
  }
  async list(
    account: unknown,
    chat: unknown,
    target: unknown,
    revision: unknown,
    ids: unknown,
    hints?: unknown,
  ): Promise<{ status: DirectoryHistoryStatus; records: SavedTranslation[] }> {
    return this.serial(async () => {
      if (
        !validHash(account) ||
        !validChatId(chat) ||
        typeof target !== "string" ||
        !getLanguage(target) ||
        !safeText(revision, 100) ||
        !Array.isArray(ids) ||
        ids.length > 100 ||
        !ids.every((id) => safeText(id, 512))
      )
        return { status: "invalid", records: [] };
      // No date means no directory guessing or whole-history body scan.
      if (hints === undefined) return { status: "ok", records: [] };
      if (
        !Array.isArray(hints) ||
        hints.length > 100 ||
        !hints.every(
          (h) =>
            h &&
            safeText(h.id, 512) &&
            ids.includes(h.id) &&
            typeof h.rawId === "string" &&
            raw.test(h.rawId) &&
            validDate(h.date),
        )
      )
        return { status: "invalid", records: [] };
      try {
        const root = await this.root();
        if (!root) return { status: "ok", records: [] };
        const chatName = await historyDigest(chat),
          records: SavedTranslation[] = [],
          seen = new Set<string>();
        for (const hint of hints as DirectoryDateHint[]) {
          if (seen.has(hint.id)) continue;
          seen.add(hint.id);
          await this.permission();
          let newest: SavedTranslation | null = null;
          for (const legacy of [false, true]) {
            const dir = await this.folder(
              root,
              hint.date,
              account,
              chatName,
              false,
              legacy,
            );
            if (!dir) continue;
            const file = recordFile(hint.rawId, target);
            const body = await this.read(dir, file, MAX_FILE_BYTES);
            if (!body) continue;
            const record = this.parse(
              body.text,
              hint.date,
              account,
              chatName,
              file,
            );
            if (!record) throw new DirectoryFailure("corrupt");
            if (
              record.id !== hint.id ||
              record.chat !== chat ||
              record.target !== target
            )
              continue;
            if (!newest || record.savedAt > newest.savedAt) newest = record;
          }
          if (newest) records.push(newest);
        }
        return { status: "ok", records };
      } catch (e) {
        return { status: statusOf(e), records: [] };
      }
    });
  }
  private async candidates(root: HistoryDirectory): Promise<Located[]> {
    let scanned = 0;
    const records: Located[] = [];
    const children = async (
      dir: HistoryDirectory,
      visit: (
        name: string,
        handle: HistoryDirectory | HistoryFile,
      ) => Promise<void>,
    ) => {
      if (!dir.entries) throw new DirectoryFailure("unavailable");
      for await (const [name, handle] of dir.entries()) {
        if (++scanned > MAX_SCAN) throw new DirectoryFailure("full");
        await visit(name, handle);
      }
    };
    // Capacity scan reads names/sizes only, never all translation bodies.
    await children(root, async (date, day) => {
      if (day.kind !== "directory" || !validDate(date)) return;
      await children(day, async (account, accountDir) => {
        if (accountDir.kind !== "directory" || !hash.test(account)) return;
        await children(accountDir, async (chat, chatDir) => {
          if (chatDir.kind !== "directory" || !hash.test(chat)) return;
          await children(chatDir, async (file, handle) => {
            if (handle.kind !== "file" || !namedRecord.test(file)) return;
            await this.permission();
            const metadata = await handle.getFile();
            records.push({
              date,
              account,
              chat,
              file,
              directory: chatDir,
              bytes: metadata.size,
            });
            if (records.length > MAX_RECORDS + 1)
              throw new DirectoryFailure("full");
          });
        });
      });
    });
    return records;
  }
  private async deleteOwned(item: Located) {
    await this.permission();
    // Only an actual deletion candidate is parsed for the minimal owner/format
    // and scope check. Unknown content stays untouched; no content hash.
    const body = await this.read(item.directory, item.file, MAX_FILE_BYTES);
    if (!body) return;
    const record = this.parse(
      body.text,
      item.date,
      item.account,
      item.chat,
      item.file,
    );
    if (
      !record ||
      !matchesHistoryDigest(await historyDigest(record.chat), item.chat)
    )
      throw new DirectoryFailure("corrupt");
    await item.directory.removeEntry(item.file);
  }
  private async pruneRecords(root: HistoryDirectory) {
    const records = await this.candidates(root);
    records.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.account.localeCompare(b.account) ||
        a.chat.localeCompare(b.chat) ||
        a.file.localeCompare(b.file),
    );
    let bytes = records.reduce((n, r) => n + r.bytes, 512),
      count = records.length;
    for (let offset = 0; offset < records.length; ) {
      if (count <= this.limits.entries && bytes <= this.limits.bytes) break;
      const date = records[offset].date;
      const sameDay: {
        item: Located;
        time: number;
        identity: string;
        savedAt: number;
        compact: boolean;
      }[] = [];
      // Only the oldest day that still needs pruning is parsed. Retain metadata,
      // not translation bodies; exact intra-day order cannot come from filenames.
      while (offset < records.length && records[offset].date === date) {
        await this.permission();
        const item = records[offset++];
        const body = await this.read(item.directory, item.file, MAX_FILE_BYTES);
        if (!body) {
          bytes -= item.bytes;
          count--;
          continue;
        }
        const record = this.parse(
          body.text,
          item.date,
          item.account,
          item.chat,
          item.file,
        );
        if (
          !record ||
          !matchesHistoryDigest(await historyDigest(record.chat), item.chat)
        )
          throw new DirectoryFailure("corrupt");
        sameDay.push({
          item,
          time: historyDate(record),
          identity: historyIdentity(record),
          savedAt: record.savedAt,
          compact: item.account.length === 43 && item.chat.length === 43,
        });
      }
      // Duplicate physical copies are redundant storage, not distinct messages.
      // Choose the same winner as visible restoration (newest, compact on ties).
      // Retire every losing copy before its winner can be evicted by message age.
      const winners = new Map<string, (typeof sameDay)[number]>();
      for (const candidate of sameDay) {
        const current = winners.get(candidate.identity);
        if (
          !current ||
          candidate.savedAt > current.savedAt ||
          (candidate.savedAt === current.savedAt &&
            candidate.compact &&
            !current.compact)
        )
          winners.set(candidate.identity, candidate);
      }
      sameDay.sort(
        (a, b) =>
          Number(winners.get(a.identity) === a) -
            Number(winners.get(b.identity) === b) ||
          a.time - b.time ||
          a.savedAt - b.savedAt ||
          a.item.file.localeCompare(b.item.file),
      );
      for (const { item } of sameDay) {
        if (count <= this.limits.entries && bytes <= this.limits.bytes) break;
        // Recheck owner/format immediately before deletion, not only at sorting.
        await this.deleteOwned(item);
        bytes -= item.bytes;
        count--;
      }
    }
  }

  async put(value: unknown): Promise<DirectoryHistoryStatus> {
    return this.serial(async () => {
      this.writeFailure = null;
      this.writeStage = "validate";
      const record = normalizeSavedTranslation(value);
      if (!record || !raw.test(record.rawId) || !recordDate(record))
        return "invalid";
      const text = JSON.stringify({
        format: RECORD_FORMAT,
        owner: this.selection.namespace,
        record,
      } satisfies Envelope);
      if (
        byteLength(text) + 512 > this.limits.bytes ||
        byteLength(text) > MAX_FILE_BYTES
      )
        return "full";
      try {
        this.writeStage = "root";
        let root = await this.root(true);
        const date = recordDate(record)!;
        const chat = await historyDigest(record.chat);
        const file = recordFile(record.rawId, record.target);
        // Compatibility is a targeted lookup of this message only, never migration.
        const legacyDir = await this.folder(
          root!,
          date,
          record.account,
          chat,
          false,
          true,
        );
        if (legacyDir) {
          const previous = await this.read(legacyDir, file, MAX_FILE_BYTES);
          if (previous) {
            const old = this.parse(
              previous.text,
              date,
              record.account,
              chat,
              file,
            );
            if (!old || historyIdentity(old) !== historyIdentity(record))
              throw new DirectoryFailure("corrupt");
            const decision = historyWriteDecision(old, record);
            if (decision !== "write") return decision;
          }
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          this.writeStage = "folders";
          const dir = await this.folder(
            root!,
            date,
            record.account,
            chat,
            true,
          );
          if (!dir) throw new DirectoryFailure("unavailable");
          this.writeStage = "existing";
          const existing = await this.read(dir, file, MAX_FILE_BYTES);
          if (existing) {
            const old = this.parse(
              existing.text,
              date,
              record.account,
              chat,
              file,
            );
            if (!old || historyIdentity(old) !== historyIdentity(record))
              throw new DirectoryFailure("corrupt");
            const decision = historyWriteDecision(old, record);
            if (decision !== "write") return decision;
          }
          try {
            await this.write(dir, file, text);
            break;
          } catch (error) {
            // create:true already handles absent files. Only a failure before a
            // file handle exists may reacquire a detached/deleted child folder.
            // Never replay writer/write/close failures with uncertain outcomes.
            if (
              attempt !== 0 ||
              this.writeStage !== "record_open" ||
              !notFound(error)
            )
              throw error;
            this.writeStage = "root";
            root = await this.root(false);
            if (!root) throw new DirectoryFailure("unavailable");
            // The next iteration rechecks any replacement file's owner, full
            // identity and version. A missing/unowned root is never recreated.
          }
        }
        this.writeStage = "cleanup";
        await this.pruneRecords(root!);
        return "ok";
      } catch (e) {
        const name =
          e && typeof e === "object" ? (e as { name?: unknown }).name : null;
        const known = [
          "NotAllowedError",
          "SecurityError",
          "QuotaExceededError",
          "NotFoundError",
          "InvalidStateError",
          "NoModificationAllowedError",
          "NotReadableError",
          "TypeMismatchError",
          "AbortError",
          "TypeError",
        ];
        this.writeFailure = {
          stage: this.writeStage,
          error:
            typeof name === "string" && known.includes(name) ? name : "unknown",
        };
        return statusOf(e);
      }
    });
  }
  async prune(): Promise<DirectoryHistoryStatus> {
    return this.serial(async () => {
      try {
        const root = await this.root();
        if (root) await this.pruneRecords(root);
        return "ok";
      } catch (e) {
        return statusOf(e);
      }
    });
  }
  async clear(): Promise<DirectoryHistoryStatus> {
    return this.serial(async () => {
      try {
        const root = await this.root();
        if (root) {
          const records = await this.candidates(root);
          for (const item of records) await this.deleteOwned(item);
        }
        return "ok";
      } catch (e) {
        return statusOf(e);
      }
    });
  }
}
