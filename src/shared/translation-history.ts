import { getLanguage } from "./languages";
import { validChatId } from "./chat-directions";
export const HISTORY_KEY = "translatedMessagesV1";
export const HISTORY_LIMIT = 1000;
export const HISTORY_BYTES = 4 * 1024 * 1024;
export interface SavedTranslation {
  account: string;
  id: string;
  chat: string;
  rawId: string;
  originalHash: string;
  target: string;
  revision: string;
  translated: string;
  source: string;
  savedAt: number;
  engine?: string;
  messageAt?: number;
  dateBasis?: "message" | "saved";
}
export type HistoryStatus =
  | "ok"
  | "full"
  | "unavailable"
  | "invalid"
  | "superseded";
export function validHash(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
}
function boundedString(v: unknown, max: number): v is string {
  return (
    typeof v === "string" &&
    !!v &&
    v.length <= max &&
    !/[\x00-\x1f\x7f]/.test(v)
  );
}
export function normalizeSavedTranslation(
  value: unknown,
): SavedTranslation | null {
  if (!value || typeof value !== "object") return null;
  const v = value as SavedTranslation;
  if (
    !validHash(v.account) ||
    !validHash(v.originalHash) ||
    !validChatId(v.chat) ||
    !boundedString(v.id, 512) ||
    !boundedString(v.rawId, 200) ||
    !boundedString(v.revision, 100) ||
    !getLanguage(v.target) ||
    (v.source !== "unknown" && !getLanguage(v.source)) ||
    typeof v.translated !== "string" ||
    !v.translated.trim() ||
    v.translated.length > 200000 ||
    !Number.isFinite(v.savedAt) ||
    v.savedAt < 0
  )
    return null;
  const messageAt =
    Number.isSafeInteger(v.messageAt) &&
    v.messageAt! >= 1230768000000 &&
    v.messageAt! <= v.savedAt + 86400000
      ? v.messageAt
      : undefined;
  // Explicit allowlist: never persist extra bridge fields, keys or original text.
  return {
    account: v.account,
    id: v.id,
    chat: v.chat,
    rawId: v.rawId,
    originalHash: v.originalHash,
    target: v.target,
    revision: v.revision,
    translated: v.translated,
    source: v.source,
    savedAt: v.savedAt,
    ...(messageAt !== undefined ? { messageAt } : {}),
    dateBasis: messageAt !== undefined ? "message" : "saved",
    engine:
      typeof v.engine === "string" &&
      /^(unknown|service:(google|microsoft)|llm:(anthropic|openai|google|deepseek|custom))$/.test(
        v.engine,
      )
        ? v.engine
        : "unknown",
  };
}
export function historyIdentity(
  v: Pick<SavedTranslation, "account" | "id" | "chat" | "target" | "revision">,
): string {
  return JSON.stringify([v.account, v.chat, v.id, v.target]);
}

export function historyDate(
  record: Pick<SavedTranslation, "messageAt" | "savedAt">,
): number {
  return record.messageAt ?? record.savedAt;
}
// wwebjs src/structures/Message.js documents model t as Unix seconds.
// Never parse localized DOM dates or infer a date from message identifiers.
export function messageTimestamp(
  value: unknown,
  now: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1230768000 &&
    value * 1000 <= now + 86400000
    ? value * 1000
    : undefined;
}

// Within serialized storage writes, ties preserve the first committed result.
export function historyWriteDecision(
  old: SavedTranslation,
  next: SavedTranslation,
): "write" | "ok" | "superseded" {
  if (old.savedAt > next.savedAt) return "superseded";
  if (old.savedAt === next.savedAt)
    return JSON.stringify(old) === JSON.stringify(next) ? "ok" : "superseded";
  return "write";
}
