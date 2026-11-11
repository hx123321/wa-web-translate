import {
  testHistoryDirectory,
  type DirectoryTestResult,
} from "@/shared/directory-selftest";
import {
  normalizeSavedTranslation,
  validHash,
} from "@/shared/translation-history";
import { validChatId } from "@/shared/chat-directions";
import { getLanguage } from "@/shared/languages";
import {
  DirectoryHistoryStore,
  type DirectoryHistoryStatus,
} from "@/shared/directory-history";
import {
  loadDirectorySelection,
  loadPendingDirectorySelection,
  activateDirectorySelection,
} from "@/shared/directory-selection";
import { TranslationHistoryStore } from "./translation-history";
export const HISTORY_SETTINGS_KEY = "translationHistorySettings";
export interface HistorySettings {
  mode: "browser" | "directory";
  maxMiB: number;
  revision: string;
  directoryId?: string;
  queueEpoch?: string;
  queueEpochs?: Record<string, string>;
}
const DEFAULT: HistorySettings = {
  mode: "browser",
  maxMiB: 4,
  revision: "initial",
};
export function validHistorySettings(value: unknown): HistorySettings | null {
  if (!value || typeof value !== "object") return null;
  const v = value as HistorySettings;
  if (
    !["browser", "directory"].includes(v.mode) ||
    !Number.isInteger(v.maxMiB) ||
    v.maxMiB < 1 ||
    v.maxMiB > (v.mode === "browser" ? 8 : 1024) ||
    typeof v.revision !== "string" ||
    !v.revision ||
    v.revision.length > 100 ||
    (v.queueEpoch !== undefined &&
      (typeof v.queueEpoch !== "string" ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(v.queueEpoch)))
  )
    return null;
  if (
    v.mode === "directory" &&
    (typeof v.directoryId !== "string" || !/^[a-f0-9]{32}$/.test(v.directoryId))
  )
    return null;
  if (
    v.queueEpochs !== undefined &&
    (!v.queueEpochs ||
      typeof v.queueEpochs !== "object" ||
      Array.isArray(v.queueEpochs) ||
      Object.keys(v.queueEpochs).length > 1000 ||
      Object.entries(v.queueEpochs).some(
        ([key, epoch]) =>
          !/^(browser|directory:[a-f0-9]{32})$/.test(key) ||
          typeof epoch !== "string" ||
          !/^[a-zA-Z0-9-]{1,100}$/.test(epoch),
      ))
  )
    return null;
  return {
    mode: v.mode,
    maxMiB: v.maxMiB,
    revision: v.revision,
    queueEpoch: v.queueEpoch ?? "initial",
    queueEpochs: { ...v.queueEpochs },
    ...(v.directoryId ? { directoryId: v.directoryId } : {}),
  };
}
export function historyQueueLocation(settings: HistorySettings): string {
  return settings.mode === "directory"
    ? `directory:${settings.directoryId}`
    : "browser";
}
export function historyQueueScope(settings: HistorySettings): string {
  const epoch =
    settings.queueEpochs?.[historyQueueLocation(settings)] ??
    settings.queueEpoch ??
    "initial";
  return `${settings.mode}:${settings.mode === "directory" ? settings.directoryId : ""}:${epoch}`;
}
export class HistoryBackend {
  private tail: Promise<unknown> = Promise.resolve();
  private browser = new TranslationHistoryStore(chrome.storage.local);
  private directory: { id: string; store: DirectoryHistoryStore } | null = null;
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const job = this.tail.then(run, run);
    this.tail = job.catch(() => {});
    return job;
  }
  async settings(): Promise<HistorySettings> {
    const value = (await chrome.storage.local.get(HISTORY_SETTINGS_KEY))[
      HISTORY_SETTINGS_KEY
    ];
    return value === undefined
      ? DEFAULT
      : (validHistorySettings(value) ??
          Promise.reject(new Error("Invalid history settings")));
  }
  async snapshot() {
    const settings = await this.settings();
    const locationKey =
      settings.mode === "browser"
        ? `browser:${settings.revision}`
        : `directory:${settings.directoryId}:${settings.revision}`;
    return { settings, locationKey, queueScope: historyQueueScope(settings) };
  }
  private async selected(settings: HistorySettings) {
    if (settings.mode === "browser") {
      this.browser.setLimits(1000, settings.maxMiB * 1024 * 1024);
      return { store: this.browser, key: `browser:${settings.revision}` };
    }
    const selection = await loadDirectorySelection(settings.directoryId);
    if (!selection) throw new Error("Directory unavailable");
    if (this.directory?.id !== selection.selectionId + settings.revision) {
      this.directory = {
        id: selection.selectionId + settings.revision,
        store: new DirectoryHistoryStore(
          selection,
          { bytes: settings.maxMiB * 1024 * 1024, entries: 10000 },
          async () => {
            const [current, policy] = await Promise.all([
              loadDirectorySelection(selection.selectionId),
              this.settings(),
            ]);
            return (
              current?.selectionId === selection.selectionId &&
              policy.mode === "directory" &&
              policy.directoryId === selection.selectionId &&
              policy.revision === settings.revision
            );
          },
        ),
      };
    }
    this.directory.store.setLimits({
      bytes: settings.maxMiB * 1024 * 1024,
      entries: 10000,
    });
    return {
      store: this.directory.store,
      key: `directory:${selection.selectionId}:${settings.revision}`,
    };
  }
  list(
    msg: any,
    accountProbe: () => Promise<string | null> = async () => null,
  ) {
    return this.serial(async () => {
      const account = await accountProbe();
      if (!account || account !== msg.account)
        return { status: "account", records: [] };
      if (
        !validHash(account) ||
        !validChatId(msg.chat) ||
        typeof msg.target !== "string" ||
        !getLanguage(msg.target) ||
        typeof msg.revision !== "string" ||
        !msg.revision ||
        msg.revision.length > 100 ||
        !Array.isArray(msg.ids) ||
        msg.ids.length > 100 ||
        msg.ids.some(
          (id: unknown) => typeof id !== "string" || !id || id.length > 512,
        )
      )
        return { status: "invalid", records: [] };
      let binding:
        | { account: string; locationKey: string; queueScope: string }
        | undefined;
      try {
        const snapshot = await this.snapshot();
        binding = {
          account,
          locationKey: snapshot.locationKey,
          queueScope: snapshot.queueScope,
        };
        const selected = await this.selected(snapshot.settings);
        if ((await accountProbe()) !== account)
          return { status: "account", records: [] };
        const result =
          selected.store instanceof DirectoryHistoryStore
            ? await selected.store.list(
                account,
                msg.chat,
                msg.target,
                msg.revision,
                msg.ids,
                msg.dateHints,
              )
            : await selected.store.list(
                account,
                msg.chat,
                msg.target,
                msg.revision,
                msg.ids,
              );
        if ((await accountProbe()) !== account)
          return { status: "account", records: [] };
        return { ...result, ...binding };
      } catch {
        if ((await accountProbe()) !== account)
          return { status: "account", records: [] };
        return { status: "unavailable", records: [], ...binding };
      }
    });
  }
  put(msg: any, accountProbe: () => Promise<string | null> = async () => null) {
    return this.serial(async () => {
      const account = await accountProbe();
      if (!account || account !== msg.record?.account)
        return { status: "account" };
      const record = normalizeSavedTranslation(msg.record);
      if (
        !record ||
        typeof msg.locationKey !== "string" ||
        msg.locationKey.length > 200 ||
        typeof msg.queueScope !== "string" ||
        msg.queueScope.length > 200
      )
        return { status: "invalid" };
      let binding:
        | { account: string; locationKey: string; queueScope: string }
        | undefined;
      try {
        const snapshot = await this.snapshot();
        binding = {
          account,
          locationKey: snapshot.locationKey,
          queueScope: snapshot.queueScope,
        };
        if (
          msg.locationKey !== snapshot.locationKey ||
          msg.queueScope !== snapshot.queueScope
        )
          return { status: "conflict" };
        const selected = await this.selected(snapshot.settings);
        if ((await accountProbe()) !== account) return { status: "account" };
        const status = await selected.store.put({ ...record, account });
        if ((await accountProbe()) !== account) return { status: "account" };
        return {
          status,
          ...binding,
          ...(selected.store instanceof DirectoryHistoryStore &&
          status !== "ok" &&
          status !== "superseded"
            ? { failure: selected.store.getWriteFailure() }
            : {}),
        };
      } catch {
        if ((await accountProbe()) !== account) return { status: "account" };
        return { status: "unavailable", ...binding };
      }
    });
  }
  testDirectory(expected: unknown): Promise<DirectoryTestResult> {
    return this.serial(async () => {
      try {
        const snapshot = await this.snapshot();
        if (snapshot.locationKey !== expected)
          return { status: "conflict", stage: "permission", residue: false };
        if (snapshot.settings.mode !== "directory")
          return { status: "unavailable", stage: "permission", residue: false };
        const selection = await loadDirectorySelection(
          snapshot.settings.directoryId,
        );
        if (!selection)
          return { status: "unavailable", stage: "permission", residue: false };
        return testHistoryDirectory(
          selection.directory,
          async () => (await this.snapshot()).locationKey === expected,
        );
      } catch {
        return { status: "unavailable", stage: "permission", residue: false };
      }
    });
  }
  clear(expected: unknown) {
    return this.serial(async () => {
      try {
        const snapshot = await this.snapshot();
        if (snapshot.locationKey !== expected) return { status: "conflict" };
        const queueLocation = historyQueueLocation(snapshot.settings);
        const epochs = snapshot.settings.queueEpochs ?? {};
        if (
          !Object.hasOwn(epochs, queueLocation) &&
          Object.keys(epochs).length >= 1000
        )
          return { status: "full" };
        // Invalidate only this location before deletion, including partial failure.
        const settings: HistorySettings = {
          ...snapshot.settings,
          revision: crypto.randomUUID(),
          queueEpochs: { ...epochs, [queueLocation]: crypto.randomUUID() },
        };
        await chrome.storage.local.set({ [HISTORY_SETTINGS_KEY]: settings });
        this.directory = null;
        const selected = await this.selected(settings);
        const status = await selected.store.clear();
        return { status };
      } catch {
        return { status: "unavailable" };
      }
    });
  }
  configure(input: unknown, expected: unknown, selectionId?: unknown) {
    return this.serial(async () => {
      try {
        const current = await this.snapshot();
        if (current.locationKey !== expected) return { status: "conflict" };
        const patch = input as Partial<HistorySettings>;
        const directoryId =
          typeof selectionId === "string"
            ? selectionId
            : current.settings.directoryId;
        const value = validHistorySettings({
          ...patch,
          queueEpoch: current.settings.queueEpoch ?? "initial",
          queueEpochs: current.settings.queueEpochs ?? {},
          directoryId,
          revision: crypto.randomUUID(),
        });
        if (!value) return { status: "invalid" };
        if (value.mode === "directory") {
          const pending = await loadPendingDirectorySelection(
            value.directoryId!,
          );
          const selected =
            pending ?? (await loadDirectorySelection(value.directoryId));
          if (!selected) return { status: "unavailable" };
          if (
            (await selected.directory.queryPermission({
              mode: "readwrite",
            })) !== "granted"
          )
            return { status: "permission" };
          if (
            pending &&
            !(await activateDirectorySelection(pending.selectionId))
          )
            return { status: "conflict" };
        }
        this.directory = null;
        await chrome.storage.local.set({ [HISTORY_SETTINGS_KEY]: value });
        const selected = await this.selected(value);
        const status = await selected.store.prune();
        return { status, ...(await this.snapshot()) };
      } catch {
        return { status: "unavailable" };
      }
    });
  }
}
