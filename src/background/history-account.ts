// Executed by Chrome in the exact requesting document. No page-provided code,
// credentials, contacts, message bodies, or browser cookies are read.
export function readHistoryAccount(): string | null {
  try {
    if (location.origin !== "https://web.whatsapp.com") return null;
    const require = (window as any).require;
    if (typeof require !== "function") return null;
    const prefs = require("WAWebUserPrefsMeUser");
    const value = prefs?.getMaybeMePnUser?.();
    const id = value?._serialized;
    return typeof id === "string" &&
      /^[0-9]{1,32}@(c\.us|s\.whatsapp\.net)$/.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}
export async function historyAccountForSender(
  sender: chrome.runtime.MessageSender,
): Promise<string | null> {
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !Number.isInteger(sender.tab?.id) ||
    !sender.documentId ||
    sender.url?.split(/[?#]/)[0] !== "https://web.whatsapp.com/"
  )
    return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: sender.tab!.id!, documentIds: [sender.documentId] },
      world: "MAIN",
      func: readHistoryAccount,
    });
    if (
      results.length !== 1 ||
      results[0].frameId !== 0 ||
      results[0].documentId !== sender.documentId ||
      typeof results[0].result !== "string" ||
      !/^[0-9]{1,32}@(c\.us|s\.whatsapp\.net)$/.test(results[0].result)
    )
      return null;
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(results[0].result),
    );
    return [...new Uint8Array(bytes)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}
