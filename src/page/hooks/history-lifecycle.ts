import type { DirectoryDateHint } from "@/shared/directory-history";
import { messageTimestamp } from "@/shared/translation-history";
import type { SavedTranslation } from "@/shared/translation-history";
import type { CompletedTranslation, Message } from "./incoming-annotations";
import { incomingIdentity } from "./incoming-annotations";
export interface HistoryScope {
  account: string;
  chat: string;
  target: string;
  revision: string;
  engine?: string;
}
export interface HistoryLifecycleDeps {
  scope(): HistoryScope | null;
  hash(text: string): Promise<string>;
  list(
    account: string,
    chat: string,
    target: string,
    revision: string,
    ids: string[],
    dateHints?: DirectoryDateHint[],
  ): Promise<SavedTranslation[]>;
  save(record: SavedTranslation): Promise<void>;
  visibleIds(): string[];
  isVisible?(id: string, chat: string, rawId: string): boolean;
  bubble(id: string, chat: string, rawId: string): unknown;
  model(id: string): Message | null;
  has(id: string): boolean;
  restore(msg: Message, record: CompletedTranslation): boolean;
  clear(): void;
  unavailable(): void;
}
// Display-only replay of records this extension already translated. Never scans
// message history and has no translate dependency. Unknown account fails closed.
export class HistoryLifecycle {
  private generation = 0;
  private loadVersion = 0;
  private current = "";
  private visibleKey = "";
  private records: SavedTranslation[] = [];
  private loading = false;
  private stopped = false;
  private restoring = false;
  constructor(private deps: HistoryLifecycleDeps) {}
  private key(scope: HistoryScope | null) {
    return scope ? JSON.stringify(scope) : "";
  }
  changed(cleared = false) {
    this.loadVersion++;
    this.visibleKey = "!reload";
    this.records = [];
    this.loading = false;
    if (cleared) {
      this.generation++;
      this.current = "";
      this.deps.clear();
    }
  }
  private visibleMetadata(scope: HistoryScope) {
    const ids = [...new Set(this.deps.visibleIds())].slice(0, 100).sort();
    const dateHints: DirectoryDateHint[] = [];
    for (const id of ids) {
      if (this.deps.has(id)) continue;
      const model = this.deps.model(id);
      const identity = model ? incomingIdentity(model) : null;
      if (
        !model ||
        !identity ||
        identity.id !== id ||
        identity.chat !== scope.chat ||
        !this.deps.bubble(id, identity.chat, identity.rawId)
      )
        continue;
      const timestamp = messageTimestamp(model.t, Date.now());
      if (timestamp === undefined) continue;
      dateHints.push({
        id,
        rawId: identity.rawId,
        date: new Date(timestamp).toISOString().slice(0, 10),
      });
    }
    return { ids, dateHints, key: JSON.stringify([ids, dateHints]) };
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    const scope = this.deps.scope(),
      key = this.key(scope);
    if (!scope) {
      if (this.current) {
        this.changed(true);
      }
      return;
    }
    const { ids, dateHints, key: visibleKey } = this.visibleMetadata(scope);
    const visibleSnapshot = new Set(ids);
    this.records = this.records.filter(
      (record) => visibleSnapshot.has(record.id) && !this.deps.has(record.id),
    );
    if (
      ids.length > 0 &&
      key === this.current &&
      ids.every((id) => this.deps.has(id))
    )
      return;
    if (key !== this.current || visibleKey !== this.visibleKey) {
      if (this.current && JSON.parse(this.current).account !== scope.account)
        this.deps.clear();
      if (key !== this.current) this.generation++;
      this.current = key;
      this.visibleKey = visibleKey;
      this.records = [];
      this.loading = true;
      const revision = ++this.loadVersion;
      try {
        const account = await this.deps.hash(scope.account);
        if (
          this.stopped ||
          revision !== this.loadVersion ||
          this.key(this.deps.scope()) !== key
        )
          return;
        // Recheck only the requested targets across the account-hash await.
        // The production adapter does exact-node lookups, never a full scan.
        const stillVisible = this.deps.isVisible
          ? ids.every((id) => {
              const model = this.deps.model(id);
              const identity = model ? incomingIdentity(model) : null;
              return (
                !!identity &&
                this.deps.isVisible!(id, scope.chat, identity.rawId)
              );
            })
          : (() => {
              const visible = new Set(this.deps.visibleIds());
              return ids.every((id) => visible.has(id));
            })();
        if (!stillVisible) return;
        const records = await this.deps.list(
          account,
          scope.chat,
          scope.target,
          scope.revision,
          ids,
          dateHints,
        );
        if (
          this.stopped ||
          revision !== this.loadVersion ||
          this.key(this.deps.scope()) !== key
        )
          return;
        this.records = records
          .slice(0, 100)
          .filter(
            (r) =>
              r.account === account &&
              r.chat === scope.chat &&
              r.target === scope.target,
          );
      } finally {
        if (revision === this.loadVersion) this.loading = false;
      }
    }
    if (this.loading || this.restoring) return;
    this.restoring = true;
    const generation = this.generation;
    const visibleVersion = this.loadVersion;
    try {
      let checked = 0;
      for (const record of this.records) {
        if (
          this.stopped ||
          generation !== this.generation ||
          visibleVersion !== this.loadVersion ||
          this.key(this.deps.scope()) !== key
        )
          return;
        if (
          this.deps.has(record.id) ||
          !visibleSnapshot.has(record.id) ||
          !this.deps.bubble(record.id, record.chat, record.rawId)
        )
          continue;
        if (++checked > 100) break;
        const msg = this.deps.model(record.id),
          identity = msg ? incomingIdentity(msg) : null;
        if (
          !msg ||
          !identity ||
          identity.id !== record.id ||
          identity.chat !== record.chat ||
          identity.rawId !== record.rawId ||
          msg.type !== "chat"
        )
          continue;
        const text = msg.body;
        if (typeof text !== "string" || !text.trim() || text.length > 5000)
          continue;
        const originalHash = await this.deps.hash(text);
        if (
          this.stopped ||
          generation !== this.generation ||
          visibleVersion !== this.loadVersion ||
          this.key(this.deps.scope()) !== key
        )
          return;
        if (
          !(this.deps.isVisible
            ? this.deps.isVisible(record.id, record.chat, record.rawId)
            : this.deps.visibleIds().includes(record.id)) ||
          this.deps.model(record.id) !== msg ||
          originalHash !== record.originalHash ||
          msg.body !== text ||
          !this.deps.bubble(record.id, record.chat, record.rawId)
        )
          continue;
        this.deps.restore(msg, {
          id: record.id,
          chat: record.chat,
          rawId: record.rawId,
          text,
          translated: record.translated,
          source: record.source,
          target: record.target,
        });
      }
    } finally {
      this.records = this.records.filter((record) => !this.deps.has(record.id));
      this.restoring = false;
    }
  }
  async completed(record: CompletedTranslation): Promise<void> {
    const scope = this.deps.scope();
    if (this.stopped || !scope) {
      this.deps.unavailable();
      return;
    }
    const key = this.key(scope),
      generation = this.generation;
    if (scope.chat !== record.chat || scope.target !== record.target) return;
    const [account, originalHash] = await Promise.all([
      this.deps.hash(scope.account),
      this.deps.hash(record.text),
    ]);
    if (
      this.stopped ||
      generation !== this.generation ||
      this.key(this.deps.scope()) !== key
    )
      return;
    const msg = this.deps.model(record.id),
      identity = msg ? incomingIdentity(msg) : null;
    if (
      !msg ||
      identity?.id !== record.id ||
      identity.chat !== record.chat ||
      identity.rawId !== record.rawId ||
      msg.body !== record.text ||
      !this.deps.bubble(record.id, record.chat, record.rawId)
    )
      return;
    const savedAt = Date.now(),
      messageAt = messageTimestamp(msg.t, savedAt);
    await this.deps.save({
      account,
      id: record.id,
      chat: record.chat,
      rawId: record.rawId,
      originalHash,
      target: record.target,
      revision: scope.revision,
      translated: record.translated,
      source: record.source,
      savedAt,
      engine: scope.engine ?? "unknown",
      ...(messageAt !== undefined ? { messageAt } : {}),
      dateBasis: messageAt !== undefined ? "message" : "saved",
    });
  }
  stop() {
    this.stopped = true;
    this.generation++;
    this.records = [];
  }
}
