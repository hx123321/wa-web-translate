import { UnsavedHistoryQueue } from "./unsaved-history-queue";
import type { DirectoryDateHint } from "@/shared/directory-history";
import { newRpcId } from "@/shared/messages";
import {
  normalizeSavedTranslation,
  type SavedTranslation,
  type HistoryStatus,
} from "@/shared/translation-history";
import { serializedWid } from "./chat-id";
import { tryRequire } from "./wa";
export const HISTORY_CHANGED_EVENT = "wa-translate:history-changed";
export const HISTORY_STATUS_EVENT = "wa-translate:history-status";
let statusText = "";
const unsaved = new UnsavedHistoryQueue(request, () => {
  window.dispatchEvent(new Event(HISTORY_STATUS_EVENT));
});
async function retryUnsavedHistory() {
  if (!unsaved.pendingCount) return;
  const account = ownAccountWid();
  if (!account) return;
  try {
    await unsaved.retry(await digestText(account));
    if (!unsaved.pendingCount) setHistoryStatus("ok");
  } catch {
    /* Keep pending records; next bounded interval can retry. */
  }
}
const retryTimer = setInterval(() => {
  void retryUnsavedHistory();
}, 15000);
// Node synthetic harness must not be kept alive by the browser-only retry clock.
(retryTimer as unknown as { unref?: () => void }).unref?.();
export function getHistoryStatus() {
  return [statusText, unsaved.warning].filter(Boolean).join(" ");
}
export function setHistoryStatus(
  status: HistoryStatus | "account" | "permission" | "corrupt",
) {
  const next =
    status === "ok"
      ? ""
      : status === "full"
        ? "此条译文超过本地容量限制，未能保存；请在扩展设置调整容量。"
        : status === "permission"
          ? "保存目录权限已过期，请在扩展设置重新授权；期间不另存其他位置。"
          : status === "corrupt"
            ? "本扩展目录校验失败，未修改未知文件；请检查保存目录。"
            : status === "account"
              ? "无法验证当前账号，本次译文仅在此页面保留，暂不持久保存或恢复。"
              : "本地译文保存暂不可用；此页面显示不受影响，请检查扩展后重试。";
  if (next !== statusText) {
    statusText = next;
    window.dispatchEvent(new Event(HISTORY_STATUS_EVENT));
  }
}
// Source: wwebjs Utils.js uses this exact module/function for the own account.
// No contact list, message history or display-name fallback.
export function ownAccountWid(): string | null {
  try {
    const prefs = tryRequire("WAWebUserPrefsMeUser");
    if (typeof prefs?.getMaybeMePnUser !== "function") return null;
    const id = serializedWid(prefs.getMaybeMePnUser());
    return id && /@(c\.us|s\.whatsapp\.net)$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
export async function digestText(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
const pending = new Map<
  string,
  { done: (result: any) => void; timer: ReturnType<typeof setTimeout> }
>();
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.__waTransHistory !== true) return;
  const data = event.data;
  if (data.kind === "HISTORY_CHANGED") {
    unsaved.storageChanged(
      data.bindingChanged === true,
      data.cleared === true,
      typeof data.removedQueueScope === "string"
        ? data.removedQueueScope
        : undefined,
    );
    if (data.bindingChanged === true) void retryUnsavedHistory();
    window.dispatchEvent(
      new CustomEvent(HISTORY_CHANGED_EVENT, {
        detail: { cleared: data.cleared === true },
      }),
    );
    return;
  }
  if (data.kind !== "HISTORY_RESULT" || typeof data.id !== "string") return;
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  clearTimeout(request.timer);
  request.done(data.result);
});
window.addEventListener("pagehide", () => {
  clearInterval(retryTimer);
  unsaved.stop();
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.done({ status: "unavailable" });
  }
  pending.clear();
});
function request(payload: Record<string, unknown>): Promise<any> {
  if (pending.size >= 8) return Promise.resolve({ status: "unavailable" });
  return new Promise((resolve) => {
    const id = newRpcId();
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ status: "unavailable", reason: "timeout" });
    }, 5000);
    pending.set(id, { done: resolve, timer });
    window.postMessage(
      { __waTransHistory: true, kind: "HISTORY_REQUEST", id, ...payload },
      "*",
    );
  });
}
export async function listSavedTranslations(
  account: string,
  chat: string,
  target: string,
  revision: string,
  ids: string[],
  dateHints?: DirectoryDateHint[],
): Promise<SavedTranslation[]> {
  const result = await unsaved.list({
    action: "list",
    account,
    chat,
    target,
    revision,
    ids,
    dateHints,
  });
  if (result?.status !== "ok") {
    setHistoryStatus(
      result?.status === "account"
        ? "account"
        : result?.status === "permission"
          ? "permission"
          : result?.status === "corrupt"
            ? "corrupt"
            : "unavailable",
    );
  } else setHistoryStatus("ok");
  if (!Array.isArray(result.records) || result.records.length > 100) return [];
  return result.records
    .map(normalizeSavedTranslation)
    .filter(
      (v: SavedTranslation | null): v is SavedTranslation =>
        !!v &&
        v.account === account &&
        v.chat === chat &&
        v.target === target &&
        ids.includes(v.id),
    );
}
export async function saveTranslation(record: SavedTranslation): Promise<void> {
  await unsaved.save(record);
  if (!unsaved.pendingCount) setHistoryStatus("ok");
}
