import {
  recordStorageDiagnostic,
  storageFailureText,
} from "./storage-diagnostics";
import {
  historyIdentity,
  normalizeSavedTranslation,
  type SavedTranslation,
} from "@/shared/translation-history";
export interface QueueBinding {
  account: string;
  locationKey: string;
  queueScope: string;
}
type Entry = { record: SavedTranslation; scope: string; bytes: number };
export class UnsavedHistoryQueue {
  private entries = new Map<string, Entry>();
  private generation = 0;
  private sequence = 0;
  private saves = new Map<string, number>();
  private writing = new Set<Entry>();
  private superseded = new WeakSet<Entry>();
  private unbound = false;
  private full = false;
  private failure = "";
  private stopped = false;
  private retrying = false;
  constructor(
    private send: (data: Record<string, unknown>) => Promise<any>,
    private changed: () => void,
    private maxCount = 50,
    private maxBytes = 512 * 1024,
  ) {}
  get pendingCount() {
    return this.entries.size;
  }
  get warning(): string {
    return (
      (this.failure ? `最近保存结果：${this.failure}。` : "") +
      (this.unbound
        ? "部分译文未能验证保存位置，未加入暂存队列；刷新前请先恢复保存设置。"
        : "") +
      (this.full ? "未保存队列已满，新译文无法暂存；已有队列未被移除。" : "") +
      (this.entries.size
        ? `尚有 ${this.entries.size} 条译文仅暂存在此页面（最多50条/512KiB）；同账号、原保存位置恢复权限后重试保存；清理状态变化的旧暂存不会自动写回。关闭或刷新页面将丢失这些未保存译文。`
        : "")
    );
  }
  storageChanged(
    bindingChanged: boolean,
    cleared: boolean,
    removedScope?: string,
  ) {
    if (bindingChanged || cleared) this.invalidate(cleared, removedScope);
  }
  invalidate(clear = false, removedScope?: string) {
    this.generation++;
    this.saves.clear();

    if (clear) {
      for (const [key, entry] of this.entries)
        if (!removedScope || entry.scope === removedScope)
          this.entries.delete(key);
      this.full = false;
      this.unbound = false;
      this.failure = "";
    }
    this.changed();
  }
  stop() {
    this.stopped = true;
    this.invalidate(true);
  }
  private key(record: SavedTranslation, scope: string) {
    return JSON.stringify([scope, historyIdentity(record)]);
  }
  private accept(result: any, account: string): QueueBinding | null {
    if (
      result?.account !== account ||
      typeof result.locationKey !== "string" ||
      result.locationKey.length > 240 ||
      typeof result.queueScope !== "string" ||
      result.queueScope.length > 240 ||
      !result.queueScope
    )
      return null;
    if (
      !["ok", "permission", "unavailable", "full", "corrupt"].includes(
        result.status,
      )
    )
      return null;
    return {
      account,
      locationKey: result.locationKey,
      queueScope: result.queueScope,
    };
  }
  private async write(entry: Entry, binding: QueueBinding, version: number) {
    const key = this.key(entry.record, entry.scope);
    if (
      this.stopped ||
      version !== this.generation ||
      this.entries.get(key) !== entry ||
      this.writing.has(entry)
    )
      return;
    this.writing.add(entry);
    let result: any;
    try {
      result = await this.send({
        action: "put",
        record: entry.record,
        locationKey: binding.locationKey,
        queueScope: binding.queueScope,
      });
    } finally {
      this.writing.delete(entry);
    }
    if (
      this.stopped ||
      version !== this.generation ||
      this.entries.get(key) !== entry
    )
      return;
    recordStorageDiagnostic("write", result);
    this.failure =
      result?.status === "ok" || result?.status === "superseded"
        ? ""
        : storageFailureText(result);
    this.changed();
    if (result?.status === "ok" || result?.status === "superseded") {
      if (result.status === "superseded") this.superseded.add(entry);
      this.entries.delete(key);
      this.full = false;
      this.changed();
    }
  }
  // Storage recovery is independent of viewport/annotation early exits.
  async retry(account: string): Promise<void> {
    if (this.stopped || this.retrying) return;
    const entry = [...this.entries.values()].find(
      (e) => e.record.account === account,
    );
    if (!entry) return;
    this.retrying = true;
    try {
      await this.list({
        action: "list",
        account,
        chat: entry.record.chat,
        target: entry.record.target,
        revision: entry.record.revision,
        ids: [],
        dateHints: [],
      });
    } finally {
      this.retrying = false;
    }
  }
  async list(payload: Record<string, unknown>): Promise<any> {
    const version = this.generation;
    const result = await this.send(payload);
    if (this.stopped || version !== this.generation)
      return { status: "unavailable", records: [] };
    recordStorageDiagnostic("retry", result);
    if (result?.status !== "ok") {
      this.failure = storageFailureText(result);
      this.changed();
    }
    const binding = this.accept(result, String(payload.account));

    if (!binding) return result;
    const matching = [...this.entries.values()].filter(
      (e) =>
        e.scope === binding.queueScope && e.record.account === binding.account,
    );
    // A successful freshly account-probed list is required for any replay to disk.
    if (result.status === "ok") {
      for (const entry of matching.slice(0, 4)) {
        if (version !== this.generation) break;
        await this.write(entry, binding, version);
      }
    }
    if (version !== this.generation || this.stopped)
      return { status: "unavailable", records: [] };
    const ids = Array.isArray(payload.ids) ? payload.ids : [];
    const records = new Map<string, SavedTranslation>();
    for (const raw of result.status === "ok" && Array.isArray(result.records)
      ? result.records
      : []) {
      const r = normalizeSavedTranslation(raw);
      if (
        r &&
        r.account === binding.account &&
        r.chat === payload.chat &&
        r.target === payload.target &&
        ids.includes(r.id)
      )
        records.set(historyIdentity(r), r);
    }
    // Include captured entries even when just saved; only exact visible identities.
    for (const captured of matching) {
      if (
        this.superseded.has(captured) &&
        !this.entries.has(this.key(captured.record, captured.scope))
      )
        continue;
      const e =
        this.entries.get(this.key(captured.record, captured.scope)) ?? captured;
      if (
        e.record.chat === payload.chat &&
        e.record.target === payload.target &&
        ids.includes(e.record.id)
      )
        records.set(historyIdentity(e.record), e.record);
    }
    return { ...result, records: [...records.values()] };
  }
  async save(value: SavedTranslation): Promise<void> {
    if (this.stopped) return;
    const record = normalizeSavedTranslation(value);
    if (!record) return;
    const identity = historyIdentity(record);
    if (this.saves.size >= 50 && !this.saves.has(identity)) {
      this.full = true;
      this.changed();
      return;
    }
    const sequence = ++this.sequence;
    this.saves.set(identity, sequence);
    try {
      const version = this.generation;
      // Probe this account/location even when an initial list failed before binding.
      const result = await this.send({
        action: "list",
        account: record.account,
        chat: record.chat,
        target: record.target,
        revision: record.revision,
        ids: [],
        dateHints: [],
      });
      if (
        this.stopped ||
        version !== this.generation ||
        this.saves.get(identity) !== sequence
      )
        return;
      recordStorageDiagnostic("probe", result);
      if (result?.status !== "ok") {
        this.failure = storageFailureText(result);
        this.changed();
      }
      const binding = this.accept(result, record.account);
      if (!binding) {
        this.unbound = true;
        this.changed();
        return;
      }
      const key = this.key(record, binding.queueScope);
      const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
      const previous = this.entries.get(key);
      const total =
        [...this.entries.values()].reduce((n, e) => n + e.bytes, 0) -
        (previous?.bytes ?? 0) +
        bytes;
      if (
        (!previous && this.entries.size >= this.maxCount) ||
        total > this.maxBytes
      ) {
        this.full = true;
        this.changed();
        return;
      }
      const entry = { record, scope: binding.queueScope, bytes };
      if (previous) this.superseded.add(previous);
      this.entries.set(key, entry);
      this.changed();
      if (result.status === "ok") await this.write(entry, binding, version);
    } finally {
      if (this.saves.get(identity) === sequence) this.saves.delete(identity);
    }
  }
}
