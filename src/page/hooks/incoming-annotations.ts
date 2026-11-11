import { installIncomingHoverAction } from "./incoming-hover";
import { showIncomingText } from "./incoming-text";
import { HistoryLifecycle } from "./history-lifecycle";
import {
  ownAccountWid,
  digestText,
  listSavedTranslations,
  saveTranslation,
  setHistoryStatus,
  HISTORY_CHANGED_EVENT,
} from "../translation-history";
import { committedBubbleModel, ownData } from "./rendered-message";
import {
  recordIncomingDiagnostic,
  type IncomingDiagnosticStage,
} from "../diagnostics";
import { resolveManualIncomingModel } from "./manual-incoming";
import { getLanguage } from "@/shared/languages";
import { safeTranslationError } from "@/shared/errors";
import {
  setIncomingError,
  setIncomingStatus,
  type IncomingStatus,
} from "../capabilities";
import type {
  PublicConfig,
  TranslateRequest,
  TranslateResult,
} from "@/shared/types";
import { serializedWid } from "../chat-id";
import { translate } from "../bridge";
import { getActiveChatId, tryRequire } from "../wa";
import { getIncomingLang, getConfig, subscribe } from "../store";
import { createDomScheduler, isOnlyOwnMutation } from "../dom-scheduler";

export interface Message {
  t?: unknown;
  __x_id?: Message["id"];
  id?: {
    _serialized?: unknown;
    $1?: unknown;
    remote?: unknown;
    fromMe?: unknown;
    id?: unknown;
  };
  isNewMsg?: unknown;
  type?: unknown;
  body?: unknown;
  on?: (event: string, cb: () => void) => void;
  off?: (event: string, cb: () => void) => void;
}
export interface Identity {
  id: string;
  chat: string;
  rawId: string;
}
export function incomingIdentity(msg: Message): Identity | null {
  if (!msg || typeof msg !== "object") return null;
  const key = ownData(msg, "__x_id") ?? msg.id;
  if (key?.fromMe !== false) return null;
  const chat = serializedWid(key.remote);
  const id = key._serialized || key.$1;
  if (
    !chat ||
    typeof id !== "string" ||
    !id ||
    id.length > 512 ||
    /[\x00-\x1f\x7f]/.test(id) ||
    typeof key.id !== "string" ||
    !key.id ||
    key.id.length > 200 ||
    /[\x00-\x1f\x7f]/.test(key.id)
  )
    return null;
  return { id, chat, rawId: key.id };
}
export interface IncomingDeps<B> {
  saved?(record: CompletedTranslation): void;
  config(): PublicConfig;
  enabledChat(chat: string): boolean;
  incomingTarget?(chat: string): string | null;
  prepareBubbles?(): void;
  activeChat(): string | null;
  bubble(id: string, chat: string, rawId?: string): B | null;
  bubbleReason?(id: string, chat: string, rawId?: string): BubbleFailure;
  diagnostic?(stage: IncomingDiagnosticStage): void;
  translate(req: TranslateRequest): Promise<TranslateResult>;
  show(
    bubble: B,
    text: string,
    target?: string,
    source?: string,
    retry?: () => void,
  ): { remove(): void; connected(): boolean };
  now(): number;
  visible?(bubble: B): boolean;
  failure?(error: unknown): void;
  status?(status: IncomingStatus): void;
}
export interface CompletedTranslation extends Identity {
  text: string;
  translated: string;
  target: string;
  source: string;
}
interface Entry<B> extends Identity {
  msg: Message;
  expires: number;
  text?: string;
  translated?: string;
  source?: string;
  failed?: string;
  failureStage?: IncomingDiagnosticStage;
  target?: string;
  busy: boolean;
  bubble?: B;
  note?: { remove(): void; connected(): boolean };
  unlisten?: () => void;
  stage?: IncomingDiagnosticStage;
  rawAmbiguous?: boolean;
}
// Observe new messages only. Never enumerate history or modify message models.
export class IncomingAnnotations<B> {
  private entries = new Map<string, Entry<B>>();
  private seen = new Set<string>();
  private observed = new WeakSet<object>();
  private rawClaims = new Map<string, { full: string; ambiguous: boolean }>();
  private revision = 0;
  private stopped = false;
  private active: string | null;
  constructor(private deps: IncomingDeps<B>) {
    this.active = deps.activeChat();
  }
  add(msg: Message): void {
    this.refresh();
    if (!this.stopped) this.deps.diagnostic?.("observed");
    if (this.stopped) return;
    if (!msg || typeof msg !== "object") {
      this.deps.diagnostic?.("rejected_identity");
      return;
    }
    if (this.observed.has(msg)) {
      this.deps.diagnostic?.("duplicate");
      return;
    }
    this.observed.add(msg);
    this.observeRawClaim(msg);
    const config = this.deps.config();
    const identity = incomingIdentity(msg);
    if (!identity || this.seen.has(identity.id)) {
      this.deps.diagnostic?.(
        identity
          ? "duplicate"
          : msg.id?.fromMe === true
            ? "rejected_outgoing"
            : "rejected_identity",
      );
      return;
    }
    // Remember observed IDs even when translation was not enabled at arrival.
    // Enabling a chat later must not replay an earlier event's private text.
    this.seen.add(identity.id);
    if (this.seen.size > 500)
      this.seen.delete(this.seen.values().next().value!);
    const rejection =
      msg.isNewMsg !== true
        ? "rejected_not_new"
        : !config.enabled || !this.deps.enabledChat(identity.chat)
          ? "rejected_disabled"
          : msg.type !== "chat" && msg.type !== "ciphertext"
            ? "rejected_type"
            : null;
    if (rejection) {
      this.deps.diagnostic?.(rejection);
      return;
    }
    const entry: Entry<B> = {
      ...identity,
      msg,
      expires: this.deps.now() + 30000,
      busy: false,
      rawAmbiguous: this.rawClaims.get(identity.chat + "\0" + identity.rawId)
        ?.ambiguous,
    };
    this.entries.set(entry.id, entry);
    this.stage(entry, "queued");
    if (this.entries.size > 100) this.drop(this.entries.keys().next().value!);
    if (msg.type === "ciphertext") {
      if (typeof msg.on !== "function" || typeof msg.off !== "function") {
        this.drop(entry.id);
        return;
      }
      const changed = () => {
        if (msg.type === "ciphertext") return;
        entry.unlisten?.();
        entry.unlisten = undefined;
        this.refresh();
      };
      msg.on("change:type", changed);
      entry.unlisten = () => msg.off!("change:type", changed);
    }
    this.refresh();
  }
  private observeRawClaim(msg: Message): void {
    // Observe ID metadata from new events in either direction, never their body.
    if (msg.isNewMsg !== true || typeof msg.id?.fromMe !== "boolean") return;
    const chat = serializedWid(msg.id.remote);
    const raw = msg.id.id;
    const full = msg.id._serialized || msg.id.$1;
    if (
      !chat ||
      typeof raw !== "string" ||
      !raw ||
      raw.length > 200 ||
      typeof full !== "string" ||
      !full ||
      full.length > 512 ||
      /[\x00-\x1f\x7f]/.test(raw + full)
    )
      return;
    const key = chat + "\0" + raw;
    const previous = this.rawClaims.get(key);
    const conflict =
      !!previous && (previous.ambiguous || previous.full !== full);
    this.rawClaims.set(key, { full, ambiguous: conflict });
    for (const entry of this.entries.values()) {
      if (
        entry.chat === chat &&
        entry.rawId === raw &&
        (conflict || entry.id !== full)
      ) {
        entry.rawAmbiguous = true;
        this.rawClaims.get(key)!.ambiguous = true;
      }
    }
    if (this.rawClaims.size > 500)
      this.rawClaims.delete(this.rawClaims.keys().next().value!);
  }
  // Explicit selection is separate from new-message events. Never fake isNewMsg.
  manualSelect(
    msg: Message,
    selectedId: string,
    selectedChat: string,
  ): boolean {
    this.refresh();
    if (this.stopped || this.deps.activeChat() !== selectedChat) return false;
    const identity = incomingIdentity(msg);
    if (
      !identity ||
      identity.id !== selectedId ||
      identity.chat !== selectedChat ||
      !this.deps.config().enabled ||
      !this.deps.enabledChat(selectedChat) ||
      msg.type !== "chat" ||
      typeof msg.body !== "string" ||
      !msg.body.trim() ||
      msg.body.length > 5000
    )
      return false;
    this.deps.prepareBubbles?.();
    if (!this.deps.bubble(identity.id, selectedChat, identity.rawId))
      return false;
    const previous = this.entries.get(identity.id);
    if (previous?.busy && !previous.failed) return false;
    this.drop(identity.id);
    this.observed.add(msg);
    this.seen.add(identity.id);
    if (this.seen.size > 500)
      this.seen.delete(this.seen.values().next().value!);
    this.deps.diagnostic?.("manual");
    this.entries.set(identity.id, {
      ...identity,
      msg,
      expires: this.deps.now() + 30000,
      busy: false,
    });
    if (this.entries.size > 100) this.drop(this.entries.keys().next().value!);
    this.refresh();
    return true;
  }
  hasEntry(id: string): boolean {
    return this.entries.has(id);
  }
  // Restore is display-only. It never passes through add/manualSelect/translate.
  restore(msg: Message, record: CompletedTranslation, render = true): boolean {
    if (
      this.stopped ||
      this.entries.has(record.id) ||
      this.deps.activeChat() !== record.chat ||
      !this.deps.config().enabled ||
      !this.deps.enabledChat(record.chat)
    )
      return false;
    const identity = incomingIdentity(msg);
    const target = this.deps.incomingTarget
      ? this.deps.incomingTarget(record.chat)
      : this.deps.config().nativeLang;
    if (
      !identity ||
      identity.id !== record.id ||
      identity.chat !== record.chat ||
      identity.rawId !== record.rawId ||
      target !== record.target ||
      msg.type !== "chat" ||
      msg.body !== record.text
    )
      return false;
    if (render) this.deps.prepareBubbles?.();
    if (!this.deps.bubble(record.id, record.chat, record.rawId)) return false;
    this.observed.add(msg);
    this.seen.add(record.id);
    if (this.seen.size > 500)
      this.seen.delete(this.seen.values().next().value!);
    this.entries.set(record.id, {
      ...record,
      msg,
      expires: Infinity,
      busy: false,
    });
    if (this.entries.size > 100) this.drop(this.entries.keys().next().value!);
    if (render) this.refresh();
    return true;
  }
  private retry(entry: Entry<B>, revision: number): void {
    if (
      this.stopped ||
      revision !== this.revision ||
      this.entries.get(entry.id) !== entry ||
      !entry.failed ||
      this.deps.activeChat() !== entry.chat
    )
      return;
    const identity = incomingIdentity(entry.msg);
    const target = this.deps.incomingTarget
      ? this.deps.incomingTarget(entry.chat)
      : this.deps.config().nativeLang;
    if (
      !identity ||
      identity.id !== entry.id ||
      identity.chat !== entry.chat ||
      identity.rawId !== entry.rawId ||
      entry.rawAmbiguous ||
      entry.msg.type !== "chat" ||
      entry.msg.body !== entry.text ||
      !this.deps.config().enabled ||
      !this.deps.enabledChat(entry.chat) ||
      target !== entry.target
    )
      return;
    this.deps.prepareBubbles?.();
    if (!this.deps.bubble(entry.id, entry.chat, entry.rawId)) return;
    entry.note?.remove();
    entry.note = undefined;
    this.stage(entry, "retry");
    entry.failed = undefined;
    entry.busy = false;
    entry.expires = this.deps.now() + 30000;
    // refresh revalidates current identity, original text, target and unique bubble.
    this.refresh();
  }
  refresh(): void {
    if (this.stopped) return;
    const active = this.deps.activeChat();
    if (active !== this.active) {
      this.settingsChanged();
      this.active = active;
    }
    // New-event entries only. Never enumerate history for automatic translation.
    const rawKeys = new Map<string, Entry<B>[]>();
    for (const entry of this.entries.values()) {
      const key = entry.chat + "\0" + entry.rawId;
      const group = rawKeys.get(key);
      if (group) group.push(entry);
      else rawKeys.set(key, [entry]);
    }
    for (const group of rawKeys.values()) {
      if (group.length > 1)
        for (const entry of group) entry.rawAmbiguous = true;
    }
    let bubblesPrepared = false;
    let status: IncomingStatus | undefined;
    for (const entry of this.entries.values()) {
      if (entry.expires <= this.deps.now()) {
        const timeout =
          entry.translated || entry.failed
            ? "expired"
            : entry.busy
              ? "timeout_request"
              : entry.msg.type === "ciphertext"
                ? "timeout_decrypt"
                : "timeout_bubble";
        this.stage(entry, timeout);
        if (timeout !== "expired" && active === entry.chat) status = timeout;
        this.drop(entry.id);
        continue;
      }
      const current = incomingIdentity(entry.msg);
      const config = this.deps.config();
      if (
        !current ||
        current.id !== entry.id ||
        current.chat !== entry.chat ||
        current.rawId !== entry.rawId ||
        !config.enabled ||
        !this.deps.enabledChat(entry.chat)
      ) {
        this.stage(
          entry,
          !current ||
            current.id !== entry.id ||
            current.chat !== entry.chat ||
            current.rawId !== entry.rawId
            ? "rejected_identity"
            : "rejected_disabled",
        );
        this.drop(entry.id);
        continue;
      }
      const target = this.deps.incomingTarget
        ? this.deps.incomingTarget(entry.chat)
        : config.nativeLang;
      if (!target || (entry.target !== undefined && entry.target !== target)) {
        this.stage(entry, !target ? "rejected_disabled" : "invalidated");
        this.drop(entry.id);
        continue;
      }
      if (entry.msg.type === "ciphertext") {
        this.stage(entry, "decrypting");
        if (active === entry.chat) status = "decrypting";
        continue;
      }
      if (
        entry.msg.type !== "chat" ||
        typeof entry.msg.body !== "string" ||
        !entry.msg.body.trim() ||
        entry.msg.body.length > 5000
      ) {
        this.stage(
          entry,
          entry.msg.type !== "chat" ? "rejected_type" : "rejected_body",
        );
        this.drop(entry.id);
        continue;
      }
      if (entry.text !== undefined && entry.msg.body !== entry.text) {
        this.stage(entry, "invalidated");
        this.drop(entry.id);
        continue;
      }
      if (entry.rawAmbiguous) {
        this.stage(entry, "ambiguous");
        if (active === entry.chat) status = "ambiguous";
        entry.note?.remove();
        entry.note = undefined;
        continue;
      }
      if (!bubblesPrepared && active === entry.chat) {
        this.deps.prepareBubbles?.();
        bubblesPrepared = true;
      }
      const bubble =
        active === entry.chat
          ? this.deps.bubble(entry.id, entry.chat, entry.rawId)
          : null;
      if (
        entry.translated &&
        (!bubble || this.deps.visible?.(bubble) === false)
      ) {
        this.drop(entry.id);
        continue;
      }
      if (!bubble) {
        const reason =
          active !== entry.chat
            ? "chat_mismatch"
            : (this.deps.bubbleReason?.(entry.id, entry.chat, entry.rawId) ??
              "id_missing");
        this.stage(entry, reason);
        if (active === entry.chat) status = reason;
        entry.note?.remove();
        entry.note = undefined;
        entry.bubble = undefined;
        continue;
      }
      if (entry.failed) {
        this.stage(entry, entry.failureStage ?? "failed");
        if (entry.bubble !== bubble || !entry.note?.connected()) {
          entry.note?.remove();
          entry.bubble = bubble;
          const revision = this.revision;
          entry.note = this.deps.show(
            bubble,
            entry.failed,
            entry.target,
            undefined,
            () => this.retry(entry, revision),
          );
        }
        continue;
      }
      if (entry.translated) {
        this.stage(entry, "translated");
        if (entry.bubble !== bubble || !entry.note?.connected()) {
          entry.note?.remove();
          entry.bubble = bubble;
          status = "translated";
          entry.note = this.deps.show(
            bubble,
            entry.translated,
            entry.target,
            entry.source,
          );
        }
        continue;
      }
      if (entry.busy) {
        this.stage(entry, "requesting");
        status = "requesting";
        continue;
      }
      this.stage(entry, "bubble_ready");
      entry.text = entry.msg.body;
      entry.target = target;
      entry.busy = true;
      this.stage(entry, "requesting");
      status = "requesting";
      const revision = this.revision;
      void this.deps
        .translate({ text: entry.text, source: "auto", target: entry.target })
        .then((result) => {
          if (
            this.stopped ||
            revision !== this.revision ||
            this.entries.get(entry.id) !== entry
          )
            return;
          if (entry.expires <= this.deps.now()) {
            this.stage(entry, "timeout_request");
            this.deps.status?.("timeout_request");
            this.drop(entry.id);
            return;
          }
          if (
            typeof result.translated !== "string" ||
            !result.translated.trim() ||
            result.translated.length > 200000 ||
            result.target !== entry.target
          ) {
            this.drop(entry.id);
            return;
          }
          entry.busy = false;
          entry.translated = result.translated;
          entry.source = getLanguage(result.source) ? result.source : "unknown";
          entry.expires = Infinity;
          this.deps.prepareBubbles?.();
          if (
            entry.msg.body === entry.text &&
            this.deps.activeChat() === entry.chat &&
            this.deps.bubble(entry.id, entry.chat, entry.rawId)
          ) {
            this.deps.saved?.({
              id: entry.id,
              chat: entry.chat,
              rawId: entry.rawId,
              text: entry.text!,
              translated: entry.translated,
              target: entry.target!,
              source: entry.source,
            });
          }
          this.refresh();
        })
        .catch((error) => {
          if (
            revision === this.revision &&
            this.entries.get(entry.id) === entry
          ) {
            if (entry.expires <= this.deps.now()) {
              this.stage(entry, "timeout_request");
              this.deps.status?.("timeout_request");
              this.drop(entry.id);
              return;
            }
            this.deps.status?.("failed");
            this.deps.failure?.(error);
            const safe = safeTranslationError(error);
            entry.failed = safe.message;
            // safe.code is a closed local enum; the recorder also rejects unknown stages.
            entry.failureStage =
              `failed_${safe.code}` as IncomingDiagnosticStage;
            entry.busy = false;
            entry.expires = this.deps.now() + 300000;
            this.refresh();
          }
        });
    }
    if (status) this.deps.status?.(status);
  }
  private stage(entry: Entry<B>, stage: IncomingDiagnosticStage): void {
    if (entry.stage === stage) return;
    entry.stage = stage;
    this.deps.diagnostic?.(stage);
  }
  settingsChanged(): void {
    if (this.entries.size) this.deps.diagnostic?.("invalidated");
    this.deps.status?.("waiting");
    this.revision++;
    for (const id of [...this.entries.keys()]) this.drop(id);
    // Retain recent seen keys: a provider switch cannot resend existing messages.
  }
  stop(): void {
    this.stopped = true;
    this.settingsChanged();
    this.seen.clear();
    this.rawClaims.clear();
  }
  private drop(id: string): void {
    const entry = this.entries.get(id);
    entry?.note?.remove();
    entry?.unlisten?.();
    this.entries.delete(id);
  }
}
// Build the ID index once per refresh; do not read message text or infer IDs.
export function indexIncomingBubbles(
  main: ParentNode | null,
): Map<string, HTMLElement[]> {
  const index = new Map<string, HTMLElement[]>();
  if (!main) return index;
  for (const el of Array.from(
    main.querySelectorAll<HTMLElement>("[data-id]"),
  )) {
    const id = el.getAttribute("data-id");
    if (!id) continue;
    const group = index.get(id);
    if (group) group.push(el);
    else index.set(id, [el]);
  }
  return index;
}
export type BubbleFailure =
  | "main_missing"
  | "render_unverified"
  | "id_missing"
  | "ambiguous"
  | "invisible"
  | "chat_mismatch";
export function incomingBubbleReason(
  mainPresent: boolean,
  currentChatMatches: boolean,
  index: Map<string, HTMLElement[]>,
  id: string,
  rawId?: string,
  chat?: string,
): BubbleFailure | null {
  if (!currentChatMatches) return "chat_mismatch";
  if (!mainPresent) return "main_missing";
  const matches = incomingBubbleCandidates(index, id, rawId, chat);
  if (!matches.length)
    return rawId && index.has(rawId) ? "render_unverified" : "id_missing";
  const visible = matches.filter(
    (el) =>
      el.isConnected &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== "hidden",
  );
  if (visible.length > 1) return "ambiguous";
  return visible.length ? null : "invisible";
}
// Raw IDs require a currently committed render model, never active-chat inference.
function incomingBubbleCandidates(
  index: Map<string, HTMLElement[]>,
  id: string,
  rawId?: string,
  chat?: string,
): HTMLElement[] {
  const full = index.get(id) ?? [];
  const raw =
    rawId && chat
      ? (index.get(rawId) ?? []).filter((node) => {
          if (node.getAttribute("data-id") !== rawId) return false;
          const model = committedBubbleModel(node);
          const identity = model ? incomingIdentity(model as Message) : null;
          return (
            identity?.id === id &&
            identity.chat === chat &&
            identity.rawId === rawId
          );
        })
      : [];
  return [...new Set([...full, ...raw])];
}
export function visibleIncomingBubble(
  index: Map<string, HTMLElement[]>,
  id: string,
  rawId?: string,
  chat?: string,
): HTMLElement | null {
  // Visibility is checked only for the exact requested ID, not every bubble.
  const matches = incomingBubbleCandidates(index, id, rawId, chat).filter(
    (el) =>
      el.isConnected &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== "hidden",
  );
  return matches.length === 1 ? matches[0] : null;
}
export function findIncomingBubble(
  id: string,
  chat: string,
  rawId?: string,
): HTMLElement | null {
  if (getActiveChatId() !== chat) return null;
  return visibleIncomingBubble(
    indexIncomingBubbles(document.querySelector("#main")),
    id,
    rawId,
    chat,
  );
}
const INSTALLATION = Symbol.for("wa-translate:incoming-annotations");
export function installIncomingAnnotations(): boolean {
  const installations = window as unknown as Record<
    symbol,
    (() => void) | undefined
  >;
  if (installations[INSTALLATION]) return true;
  const store = tryRequire("WAWebCollections")?.Msg;
  if (typeof store?.on !== "function" || typeof store?.off !== "function")
    return false;
  let bubbleIndex = new Map<string, HTMLElement[]>();
  let mainPresent = false;
  let history: HistoryLifecycle;
  const controller = new IncomingAnnotations<HTMLElement>({
    saved: (record) => {
      void history
        .completed(record)
        .catch(() => setHistoryStatus("unavailable"));
    },
    config: getConfig,
    enabledChat: (chat) => !!getIncomingLang(chat),
    incomingTarget: getIncomingLang,
    activeChat: getActiveChatId,
    prepareBubbles: () => {
      const main = document.querySelector("#main");
      mainPresent = !!main;
      bubbleIndex = indexIncomingBubbles(main);
    },
    bubble: (id, chat, rawId) =>
      getActiveChatId() === chat
        ? visibleIncomingBubble(bubbleIndex, id, rawId, chat)
        : null,
    bubbleReason: (id, chat, rawId) =>
      incomingBubbleReason(
        mainPresent,
        getActiveChatId() === chat,
        bubbleIndex,
        id,
        rawId,
        chat,
      ) ?? "id_missing",
    diagnostic: recordIncomingDiagnostic,
    translate,
    now: Date.now,
    visible: historyNodeVisible,
    status: setIncomingStatus,
    failure: (error) => setIncomingError(safeTranslationError(error).message),
    show: (bubble, text, _target, _source, retry) => {
      setIncomingError("");
      return showIncomingText(bubble, text, retry);
    },
  });
  function historyNodeVisible(node: HTMLElement) {
    if (
      !node.isConnected ||
      !node.getClientRects().length ||
      getComputedStyle(node).visibility === "hidden"
    )
      return false;
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0,
      left = viewport?.offsetLeft ?? 0;
    const rect = node.getBoundingClientRect();
    return (
      rect.bottom > top &&
      rect.top < top + (viewport?.height ?? window.innerHeight) &&
      rect.right > left &&
      rect.left < left + (viewport?.width ?? window.innerWidth)
    );
  }
  let historyBubbleIndex = new Map<string, HTMLElement[]>();
  const historyTargetVisible = (id: string, chat: string, rawId: string) => {
    if (getActiveChatId() !== chat) return false;
    const main = document.querySelector("#main");
    if (!main) return false;
    // Targeted lookup only; do not rescan every message after each hash await.
    const map = new Map<string, HTMLElement[]>();
    for (const key of new Set([id, rawId])) {
      const nodes = [
        ...main.querySelectorAll<HTMLElement>(`[data-id="${CSS.escape(key)}"]`),
      ];
      map.set(key, nodes);
    }
    const node = visibleIncomingBubble(map, id, rawId, chat);
    if (
      !node ||
      !node.isConnected ||
      !node.getClientRects().length ||
      getComputedStyle(node).visibility === "hidden"
    )
      return false;
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0,
      left = viewport?.offsetLeft ?? 0;
    const rect = node.getBoundingClientRect();
    return (
      rect.bottom > top &&
      rect.top < top + (viewport?.height ?? window.innerHeight) &&
      rect.right > left &&
      rect.left < left + (viewport?.width ?? window.innerWidth)
    );
  };
  history = new HistoryLifecycle({
    scope: () => {
      const config = getConfig(),
        chat = getActiveChatId(),
        account = ownAccountWid();
      const target = chat ? getIncomingLang(chat) : null;
      return config.enabled && account && chat && target && config.revision
        ? {
            account,
            chat,
            target,
            revision: config.revision,
            engine:
              config.mode === "service"
                ? `service:${config.service}`
                : `llm:${config.provider}`,
          }
        : null;
    },
    hash: digestText,
    list: listSavedTranslations,
    save: saveTranslation,
    visibleIds: () => {
      const main = document.querySelector("#main"),
        chat = getActiveChatId();
      if (!main || !chat) {
        historyBubbleIndex.clear();
        return [];
      }
      const ids: string[] = [];
      const index = indexIncomingBubbles(main);
      historyBubbleIndex = index;
      bubbleIndex = index;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0,
        left = viewport?.offsetLeft ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight),
        right = left + (viewport?.width ?? window.innerWidth);
      for (const node of [...index.values()].flat().slice(0, 300)) {
        if (
          !node.isConnected ||
          !node.getClientRects().length ||
          getComputedStyle(node).visibility === "hidden"
        )
          continue;
        const domId = node.getAttribute("data-id");
        if (!domId) continue;
        const rect = node.getBoundingClientRect();
        if (
          rect.bottom <= top ||
          rect.top >= bottom ||
          rect.right <= left ||
          rect.left >= right
        )
          continue;
        const rendered = committedBubbleModel(node) as Message | null;
        let model: Message | null = rendered;
        if (!model && domId.startsWith("false_")) {
          try {
            model = store.get(domId) ?? null;
          } catch {}
        }
        const identity = model ? incomingIdentity(model) : null;
        if (!identity || identity.chat !== chat) continue;
        if (
          domId !== identity.id &&
          (!rendered ||
            domId !== identity.rawId ||
            store.get(identity.id) !== rendered)
        )
          continue;
        if (
          identity &&
          visibleIncomingBubble(index, identity.id, identity.rawId, chat) ===
            node
        )
          ids.push(identity.id);
        if (ids.length >= 100) break;
      }
      return ids;
    },
    isVisible: historyTargetVisible,
    bubble: (id, chat, rawId) =>
      getActiveChatId() === chat
        ? visibleIncomingBubble(historyBubbleIndex, id, rawId, chat)
        : null,
    model: (id) => {
      try {
        return store.get(id) ?? null;
      } catch {
        return null;
      }
    },
    has: (id) => controller.hasEntry(id),
    restore: (msg, record) => controller.restore(msg, record, false),
    clear: () => controller.settingsChanged(),
    unavailable: () => setHistoryStatus("account"),
  });
  const refresh = () => {
    controller.refresh();
    void history
      .tick()
      .then(() => controller.refresh())
      .catch(() => setHistoryStatus("unavailable"));
  };
  const historyChanged = (event: Event) => {
    history.changed((event as CustomEvent).detail?.cleared === true);
    refresh();
  };
  window.addEventListener(HISTORY_CHANGED_EVENT, historyChanged);
  const stopPicker = installIncomingHoverAction({
    getModel: (id, chat) =>
      resolveManualIncomingModel(id, chat, tryRequire("WAWebCollections")),
    select: (msg, id, chat) => controller.manualSelect(msg, id, chat),
  });
  const add = (msg: Message) => controller.add(msg);
  store.on("add", add);
  const reset = () => {
    controller.settingsChanged();
    history.changed();
    setIncomingError("");
  };
  const unconfig = subscribe("config", reset);
  const unchat = subscribe("chatLangs", reset);
  const schedule = createDomScheduler(refresh);
  const observer = new MutationObserver((records) => {
    if (records.length && records.every(isOnlyOwnMutation)) return;
    schedule.request();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-id"],
  });
  const expiry = setInterval(refresh, 1000);
  refresh();
  const stop = () => {
    controller.stop();
    history.stop();
    historyBubbleIndex.clear();
    bubbleIndex.clear();
    window.removeEventListener(HISTORY_CHANGED_EVENT, historyChanged);
    stopPicker();
    store.off("add", add);
    unconfig();
    unchat();
    observer.disconnect();
    schedule.cancel();
    clearInterval(expiry);
    delete installations[INSTALLATION];
    window.removeEventListener("pagehide", stop);
  };
  installations[INSTALLATION] = stop;
  window.addEventListener("pagehide", stop, { once: true });
  return true;
}
