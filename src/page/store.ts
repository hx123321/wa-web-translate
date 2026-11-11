import {
  directions,
  validChatId,
  type Direction,
} from "@/shared/chat-directions";
import { getLanguage } from "@/shared/languages";
import { getActiveChatId } from "./wa";
// Page-world wrapper around chrome.storage. The page world cannot use chrome.* directly,
// so we proxy via the content script with a lightweight RPC.

import type { ChatLangMap, PublicConfig } from "@/shared/types";
import { DEFAULT_CONFIG, publicConfig } from "@/shared/types";

type StoreEvent = "config" | "chatLangs";

const subscribers = new Map<StoreEvent, Set<() => void>>();

let config: PublicConfig = publicConfig(DEFAULT_CONFIG);
let chatLangs: ChatLangMap = {};

const STORE_TAG = "__waTransStore";

interface StoreResp {
  [STORE_TAG]: true;
  kind: "STORE_PUSH";
  config?: PublicConfig;
  chatLangs?: ChatLangMap;
}

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const data = e.data as StoreResp | undefined;
  if (!data || (data as unknown as Record<string, unknown>)[STORE_TAG] !== true)
    return;
  if (data.kind === "STORE_PUSH") {
    if (data.config && JSON.stringify(data.config) !== JSON.stringify(config)) {
      config = data.config;
      fire("config");
    }
    if (
      data.chatLangs &&
      JSON.stringify(data.chatLangs) !== JSON.stringify(chatLangs)
    ) {
      chatLangs = data.chatLangs;
      fire("chatLangs");
    }
  }
});

function fire(ev: StoreEvent) {
  for (const fn of subscribers.get(ev) ?? []) {
    try {
      fn();
    } catch {}
  }
}

function emit(kind: string, payload: Record<string, unknown> = {}) {
  window.postMessage({ [STORE_TAG]: true, kind, ...payload }, "*");
}

export function requestSnapshot() {
  emit("STORE_REQUEST");
}

export function setChatLang(
  chatId: string,
  lang: string | null,
  direction: Direction = "outgoing",
): boolean {
  // A picker may stay open across a chat change. Recheck the verified identity
  // at the action boundary, not merely when the picker was rendered.
  if (
    !validChatId(chatId) ||
    (lang !== null && !getLanguage(lang)) ||
    !["incoming", "outgoing"].includes(direction) ||
    getActiveChatId() !== chatId
  )
    return false;
  chatLangs = { ...chatLangs };
  chatLangs[chatId] = {
    ...directions(chatLangs[chatId], config.nativeLang),
    [direction]: lang,
  };
  fire("chatLangs");
  emit("STORE_SET_CHAT_LANG", { chatId, lang, direction });
  return true;
}

export function getChatLang(chatId: string): string | null {
  return directions(chatLangs[chatId], config.nativeLang).outgoing;
}

export function getChatLangs(): ChatLangMap {
  return chatLangs;
}

export function getConfig(): PublicConfig {
  return config;
}

export function subscribe(ev: StoreEvent, cb: () => void): () => void {
  if (!subscribers.has(ev)) subscribers.set(ev, new Set());
  subscribers.get(ev)!.add(cb);
  return () => subscribers.get(ev)?.delete(cb);
}

export function getIncomingLang(chatId: string): string | null {
  return directions(chatLangs[chatId], config.nativeLang).incoming;
}
