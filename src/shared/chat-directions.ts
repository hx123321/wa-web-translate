import { getLanguage } from "./languages";
import type { ChatDirections, ChatLangMap } from "./types";
export type Direction = "incoming" | "outgoing";
export function validChatId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length <= 200 &&
    /^[A-Za-z0-9._:-]+@(c\.us|s\.whatsapp\.net|g\.us|lid|newsletter|broadcast)$/.test(
      id,
    )
  );
}
export function directions(value: unknown, native: string): ChatDirections {
  if (typeof value === "string" && getLanguage(value))
    return { outgoing: value, incoming: getLanguage(native) ? native : null };
  const v =
    value && typeof value === "object"
      ? (value as Partial<ChatDirections>)
      : {};
  const language = (x: unknown) =>
    typeof x === "string" && getLanguage(x) ? x : null;
  return { incoming: language(v.incoming), outgoing: language(v.outgoing) };
}
export function normalizeDirections(
  value: unknown,
  native: string,
): ChatLangMap {
  const result: ChatLangMap = {};
  if (!value || typeof value !== "object") return result;
  for (const [id, v] of Object.entries(value)) {
    if (validChatId(id)) result[id] = directions(v, native);
  }
  return result;
}
