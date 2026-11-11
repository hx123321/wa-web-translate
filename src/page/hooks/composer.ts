import { recordOutgoingDiagnostic } from "../outgoing-diagnostics";
import { findComposer } from "../composer-dom";
import { createDomScheduler, isOnlyOwnMutation } from "../dom-scheduler";
import { translate } from "../bridge";
import { getActiveChatId } from "../wa";
import { getChatLang, getConfig, subscribe } from "../store";
import { DraftSessions, type DraftState } from "./draft-state";
export type ComposerState = DraftState;
const listeners = new Set<(state: ComposerState) => void>();
let activeChat: string | null = null;
function notify() {
  const state = sessions.read(activeChat);
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {}
  }
}
export const sessions = new DraftSessions(
  (req, signal) => translate(req, 30000, signal),
  notify,
  recordOutgoingDiagnostic,
);
export function draftContext(): string {
  return JSON.stringify(getConfig());
}
export function subscribeComposer(
  cb: (state: ComposerState) => void,
): () => void {
  listeners.add(cb);
  cb(sessions.read(activeChat));
  return () => {
    listeners.delete(cb);
  };
}
export function getComposerState(): ComposerState {
  return sessions.read(activeChat);
}
export function activateDraft(chatId: string, text: string): Promise<void> {
  activeChat = chatId;
  return sessions.activate(
    chatId,
    text,
    getChatLang(chatId),
    draftContext(),
    getConfig().enabled,
  );
}
export function closeDraft(): void {
  const chat = getActiveChatId();
  if (chat && chat === activeChat) sessions.close(chat);
}
export function retryDraft(): void {
  const el = findComposer();
  const chat = getActiveChatId();
  if (el && chat && chat === activeChat) {
    recordOutgoingDiagnostic("manual_retry");
    void activateDraft(chat, readComposerText(el));
  }
}
export function showSendError(): void {
  if (activeChat) {
    sessions.sendFailed(activeChat);
  }
}
export function readComposerText(el: HTMLElement): string {
  return el.innerText.replace(/ /g, " ").trim();
}
export function handleDraftShortcut(
  event: KeyboardEvent,
  activate: () => void,
): boolean {
  if (
    event.key !== "Enter" ||
    !event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.isComposing
  )
    return false;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  if (!event.repeat) activate();
  return true;
}
export function installComposerObserver(): void {
  let attached: HTMLElement | null = null;
  const sync = () => {
    const chat = getActiveChatId();
    if (activeChat !== chat && activeChat) sessions.focus(activeChat, false);
    activeChat = chat;
    if (attached && chat)
      sessions.observe(
        chat,
        readComposerText(attached),
        getChatLang(chat),
        draftContext(),
      );
    notify();
  };
  const input = () => sync();
  const focus = () => {
    sync();
    if (activeChat) sessions.focus(activeChat, true);
  };
  const blur = (e: FocusEvent) => {
    if (
      (e.relatedTarget as Element | null)?.closest?.("#wa-translate-draft-host")
    )
      return;
    if (activeChat) sessions.focus(activeChat, false);
  };
  const key = (e: Event) => {
    handleDraftShortcut(e as KeyboardEvent, () => {
      sync();
      if (activeChat && attached)
        void activateDraft(activeChat, readComposerText(attached));
    });
  };
  const detach = () => {
    if (!attached) return;
    attached.removeEventListener("input", input);
    attached.removeEventListener("focus", focus);
    attached.removeEventListener("blur", blur as EventListener);
    attached.removeEventListener("keydown", key, true);
  };
  const attach = () => {
    const el = findComposer();
    const chat = getActiveChatId();
    if (el === attached && chat === activeChat) return;
    detach();
    attached = el;
    sync();
    if (!el) return;
    el.addEventListener("input", input);
    el.addEventListener("focus", focus);
    el.addEventListener("blur", blur as EventListener);
    el.addEventListener("keydown", key, true);
    if (document.activeElement === el && activeChat)
      sessions.focus(activeChat, true);
  };
  const scheduler = createDomScheduler(attach);
  const observer = new MutationObserver((records) => {
    if (records?.length && records.every(isOnlyOwnMutation)) return;
    scheduler.request();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  attach();
  const unconfig = subscribe("config", () => {
    sessions.invalidate();
    sync();
  });
  const unchat = subscribe("chatLangs", () => {
    sessions.updateTargets(getChatLang, draftContext());
    sync();
  });
  window.addEventListener(
    "pagehide",
    () => {
      observer.disconnect();
      scheduler.cancel();
      detach();
      unconfig();
      unchat();
      sessions.dispose();
    },
    { once: true },
  );
}
