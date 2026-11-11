import {
  HISTORY_BYTES,
  HISTORY_KEY,
  HISTORY_LIMIT,
  historyDate,
  historyWriteDecision,
  historyIdentity,
  normalizeSavedTranslation,
  validHash,
  type SavedTranslation,
  type HistoryStatus,
} from "@/shared/translation-history";
import { validChatId } from "@/shared/chat-directions";
import { getLanguage } from "@/shared/languages";
interface Storage {
  get(key: string | string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}
interface IndexEntry {
  identity: string;
  key: string;
  bytes: number;
  savedAt: number;
  orderAt: number;
}
interface IndexState {
  format: 1;
  entries: IndexEntry[];
  pending: IndexEntry[];
  garbage: IndexEntry[];
}
const INDEX = HISTORY_KEY + "Index";
const PREFIX = "translatedMessageV1:";
async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
const bytes = (v: unknown) =>
  new TextEncoder().encode(JSON.stringify(v)).length;
// The index is bounded metadata only. List reads at most 100 requested record
// keys; there is no get(null), full-history body read, or legacy-array migration.
export class TranslationHistoryStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private storage: Storage,
    private limit = HISTORY_LIMIT,
    private budget = HISTORY_BYTES,
  ) {}
  setLimits(limit: number, budget: number) {
    this.limit = limit;
    this.budget = budget;
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const job = this.tail.then(run, run);
    this.tail = job.catch(() => {});
    return job;
  }
  private async state(): Promise<IndexState> {
    const value = (await this.storage.get(INDEX))[INDEX];
    if (value === undefined)
      return { format: 1, entries: [], pending: [], garbage: [] };
    if (!value || typeof value !== "object")
      throw new Error("History index invalid");
    const state = value as IndexState;
    if (state.format !== 1) throw new Error("History index invalid");
    for (const list of [state.entries, state.pending, state.garbage]) {
      if (
        !Array.isArray(list) ||
        list.length > 1000 ||
        !list.every(
          (v) =>
            v &&
            validHash(v.identity) &&
            typeof v.key === "string" &&
            /^translatedMessageV1:[a-f0-9]{32}$/.test(v.key) &&
            Number.isSafeInteger(v.bytes) &&
            v.bytes > 0 &&
            v.bytes < 1500000 &&
            Number.isFinite(v.savedAt) &&
            v.savedAt >= 0 &&
            Number.isFinite(v.orderAt) &&
            v.orderAt >= 0,
        )
      )
        throw new Error("History index invalid");
    }
    const all = [...state.entries, ...state.pending, ...state.garbage];
    if (
      new Set(state.entries.map((v) => v.identity)).size !==
        state.entries.length ||
      new Set(all.map((v) => v.key)).size !== all.length
    )
      throw new Error("History index invalid");
    return state;
  }
  private async clean(state: IndexState): Promise<IndexEntry[]> {
    const stale = [...state.pending, ...state.garbage];
    if (stale.length) {
      await this.storage.remove(stale.map((e) => e.key));
      await this.storage.set({
        [INDEX]: {
          format: 1,
          entries: state.entries,
          pending: [],
          garbage: [],
        },
      });
    }
    return state.entries;
  }
  private trim(all: IndexEntry[]): IndexEntry[] {
    all.sort((a, b) => a.orderAt - b.orderAt || a.savedAt - b.savedAt);
    const removed: IndexEntry[] = [];
    while (
      all.length > this.limit ||
      all.reduce((sum, v) => sum + v.bytes, bytes(all)) > this.budget
    ) {
      const first = all.shift();
      if (!first) break;
      removed.push(first);
    }
    return removed;
  }
  list(
    account: unknown,
    chat: unknown,
    target: unknown,
    revision: unknown,
    ids: unknown,
  ) {
    return this.serial(async () => {
      if (
        !Array.isArray(ids) ||
        ids.length > 100 ||
        ids.some((id) => typeof id !== "string" || !id || id.length > 512) ||
        !validHash(account) ||
        !validChatId(chat) ||
        typeof target !== "string" ||
        !getLanguage(target) ||
        typeof revision !== "string" ||
        !revision ||
        revision.length > 100
      )
        return { status: "invalid" as HistoryStatus, records: [] };
      try {
        const index = (await this.state()).entries,
          wanted = new Set(
            await Promise.all(
              ids.map((id) =>
                digest(
                  historyIdentity({ account, chat, id, target, revision }),
                ),
              ),
            ),
          );
        const entries = index.filter((v) => wanted.has(v.identity));
        if (!entries.length)
          return { status: "ok" as HistoryStatus, records: [] };
        const values = await this.storage.get(entries.map((e) => e.key)),
          records: SavedTranslation[] = [];
        for (const entry of entries) {
          const r = normalizeSavedTranslation(values[entry.key]);
          if (
            !r ||
            r.account !== account ||
            r.chat !== chat ||
            r.target !== target ||
            !ids.includes(r.id) ||
            (await digest(historyIdentity(r))) !== entry.identity
          )
            return { status: "unavailable" as HistoryStatus, records: [] };
          records.push(r);
        }
        return { status: "ok" as HistoryStatus, records };
      } catch {
        return { status: "unavailable" as HistoryStatus, records: [] };
      }
    });
  }
  put(input: unknown): Promise<HistoryStatus> {
    return this.serial(async () => {
      const record = normalizeSavedTranslation(input);
      if (!record) return "invalid";
      try {
        const identity = await digest(historyIdentity(record)),
          all = await this.clean(await this.state());
        const old = all.filter((e) => e.identity === identity),
          next = all.filter((e) => e.identity !== identity);
        for (const existing of old) {
          const value = normalizeSavedTranslation(
            (await this.storage.get(existing.key))[existing.key],
          );
          if (!value || historyIdentity(value) !== historyIdentity(record))
            return "unavailable";
          const decision = historyWriteDecision(value, record);
          if (decision !== "write") return decision;
        }
        const key = PREFIX + crypto.randomUUID().replaceAll("-", "");
        const entry = {
          identity,
          key,
          bytes: bytes(record),
          savedAt: record.savedAt,
          orderAt: historyDate(record),
        };
        if (entry.bytes + bytes([entry]) > this.budget) return "full";
        next.push(entry);
        const removed = this.trim(next);
        await this.storage.set({
          [INDEX]: { format: 1, entries: all, pending: [entry], garbage: [] },
        });
        await this.storage.set({ [key]: record });
        const committed: IndexState = {
          format: 1,
          entries: next,
          pending: [],
          garbage: [...old, ...removed],
        };
        await this.storage.set({ [INDEX]: committed });
        await this.clean(committed);
        return "ok";
      } catch {
        return "unavailable";
      }
    });
  }
  prune(): Promise<HistoryStatus> {
    return this.serial(async () => {
      try {
        const all = await this.clean(await this.state()),
          removed = this.trim(all);
        const state: IndexState = {
          format: 1,
          entries: all,
          pending: [],
          garbage: removed,
        };
        await this.storage.set({ [INDEX]: state });
        await this.clean(state);
        return "ok";
      } catch {
        return "unavailable";
      }
    });
  }
  clear(): Promise<HistoryStatus> {
    return this.serial(async () => {
      try {
        const all = await this.clean(await this.state());
        const state: IndexState = {
          format: 1,
          entries: [],
          pending: [],
          garbage: all,
        };
        await this.storage.set({ [INDEX]: state });
        await this.clean(state);
        return "ok";
      } catch {
        return "unavailable";
      }
    });
  }
}
