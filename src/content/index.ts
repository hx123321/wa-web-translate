import { WorkerTransport } from "./worker-transport";
import { getLanguage } from "@/shared/languages";
// Bridge between the MAIN-world page script and the service worker. This script runs
// in the ISOLATED world so it has access to chrome.* APIs. It also injects the page
// bundle as a real <script src> tag — that gives the script a proper base URL so its
// relative dynamic imports resolve correctly. (Manifest content_script with world:MAIN
// doesn't expose chrome.runtime.id in many Chrome builds, so we don't rely on that.)
import type { RpcMessage } from "@/shared/messages";
import { TAG } from "@/shared/messages";
import {
  loadChatLangs,
  loadConfig,
  setChatLang,
  watchChatLangs,
  watchConfig,
} from "@/shared/storage";
import {
  publicConfig,
  type PublicConfig,
  type ChatLangMap,
} from "@/shared/types";

// `__PAGE_BUNDLE_URL__` is a placeholder. The post-build Vite plugin replaces it with
// the bundled MAIN-world entry path (e.g. `assets/index.ts-XXX.js`).
const PAGE_BUNDLE_PATH = "__PAGE_BUNDLE_URL__";

(function injectPageBundle() {
  if (PAGE_BUNDLE_PATH.startsWith("__PAGE_BUNDLE")) {
    console.warn(
      "[wa-translate] page bundle path was not injected at build time",
    );
    return;
  }
  const url = chrome.runtime.getURL(PAGE_BUNDLE_PATH);
  const s = document.createElement("script");
  s.type = "module";
  s.src = url;
  s.dataset.waTranslate = "true";
  (document.documentElement || document.head).appendChild(s);
  s.addEventListener("load", () => s.remove());
})();

// MV3 service workers are suspended after a period of inactivity. When that happens
// the existing port disconnects silently — `port.postMessage` becomes a no-op and
// every subsequent translate request times out. We track the connection state and
// lazily reconnect when needed.

const transport = new WorkerTransport(
  () => chrome.runtime.connect({ name: "wa-translate" }),
  (message) => window.postMessage(message, "*"),
);
transport.prime();

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const data = e.data as Record<string, unknown> | undefined;
  if (!data) return;

  if (data[TAG] === true) {
    const rpc = data as unknown as RpcMessage;
    if (rpc.kind === "TRANSLATE_REQUEST" || rpc.kind === "TRANSLATE_CANCEL")
      transport.post(rpc);
    return;
  }

  if (data["__waTransHistory"] === true && data.kind === "HISTORY_REQUEST") {
    if (
      typeof data.id !== "string" ||
      data.id.length > 100 ||
      !data.id ||
      !["list", "put"].includes(String(data.action))
    )
      return;
    void historyRequest(data);
    return;
  }
  if (data["__waTransStore"] === true) {
    handleStoreMsg(data);
  }
});

window.addEventListener("pagehide", () => transport.dispose());

// --- Store proxy: page world cannot use chrome.* directly. ---

function pushStore(patch: { config?: PublicConfig; chatLangs?: ChatLangMap }) {
  window.postMessage(
    { __waTransStore: true, kind: "STORE_PUSH", ...patch },
    "*",
  );
}

async function pushSnapshot() {
  const [config, chatLangs] = await Promise.all([
    loadConfig(),
    loadChatLangs(),
  ]);
  pushStore({ config: publicConfig(config), chatLangs });
}

function handleStoreMsg(data: Record<string, unknown>) {
  if (data.kind === "STORE_REQUEST") {
    pushSnapshot();
  } else if (data.kind === "STORE_SET_CHAT_LANG") {
    if (
      typeof data.chatId !== "string" ||
      !data.chatId ||
      data.chatId.length > 200 ||
      ["__proto__", "constructor", "prototype"].includes(data.chatId)
    )
      return;
    const chatId = data.chatId;
    const lang = data.lang == null ? null : String(data.lang);
    if (lang !== null && !getLanguage(lang)) return;
    const direction = data.direction ?? "outgoing";
    if (direction !== "incoming" && direction !== "outgoing") return;
    setChatLang(chatId, lang, direction).catch(() => {});
  }
}

watchConfig((config) => pushStore({ config: publicConfig(config) }));
watchChatLangs((chatLangs) => pushStore({ chatLangs }));

// Initial push as soon as the page world is ready (it'll call STORE_REQUEST too,
// but this keeps the warm-up path short).
pushSnapshot();

// Never broadcast all accounts' saved translations. Only the requested validated
// account/chat scope is returned. This bridge, like translation RPC, is not an
// authentication boundary against other scripts in the WhatsApp page.
let historyInflight = 0;
async function historyRequest(data: Record<string, unknown>) {
  if (historyInflight >= 8) return;
  historyInflight++;
  try {
    const result = await chrome.runtime.sendMessage({
      kind: "TRANSLATION_HISTORY",
      action: data.action,
      account: data.account,
      chat: data.chat,
      target: data.target,
      revision: data.revision,
      ids: data.ids,
      dateHints: data.dateHints,
      record: data.record,
      locationKey: data.locationKey,
      queueScope: data.queueScope,
    });
    window.postMessage(
      { __waTransHistory: true, kind: "HISTORY_RESULT", id: data.id, result },
      "*",
    );
  } catch {
    window.postMessage(
      {
        __waTransHistory: true,
        kind: "HISTORY_RESULT",
        id: data.id,
        result: { status: "unavailable" },
      },
      "*",
    );
  } finally {
    historyInflight--;
  }
}
// Compare the old location within the new policy, not the newly selected location.
function queueLocation(settings: any) {
  return settings?.mode === "directory"
    ? `directory:${settings.directoryId}`
    : "browser";
}
function queueEpoch(settings: any, location: string) {
  return settings?.queueEpochs?.[location] ?? settings?.queueEpoch ?? "initial";
}
chrome.storage.onChanged.addListener((changes, area) => {
  const change = changes.translationHistorySettings;
  const oldLocation = queueLocation(change?.oldValue);
  const oldEpoch = queueEpoch(change?.oldValue, oldLocation);
  if (
    area === "local" &&
    (changes.translatedMessagesV1Index || changes.translationHistorySettings)
  )
    window.postMessage(
      {
        __waTransHistory: true,
        kind: "HISTORY_CHANGED",
        bindingChanged: !!changes.translationHistorySettings,
        cleared:
          !!change && oldEpoch !== queueEpoch(change.newValue, oldLocation),
        removedQueueScope:
          oldLocation === "browser"
            ? `browser::${oldEpoch}`
            : `${oldLocation}:${oldEpoch}`,
      },
      "*",
    );
});
