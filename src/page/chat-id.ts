// Only internal Wid representations observed in current upstream integrations.
// Source: wwebjs/whatsapp-web.js src/util/Injected/Utils.js (getChatModel).
export function serializedWid(wid: unknown): string | null {
  if (!wid || typeof wid !== "object") return null;
  const value =
    (wid as { _serialized?: unknown; $1?: unknown })._serialized ||
    (wid as { $1?: unknown }).$1;
  return typeof value === "string" &&
    value.length <= 200 &&
    /^[A-Za-z0-9._:-]+@(c\.us|s\.whatsapp\.net|g\.us|lid|newsletter|broadcast)$/.test(
      value,
    )
    ? value
    : null;
}
