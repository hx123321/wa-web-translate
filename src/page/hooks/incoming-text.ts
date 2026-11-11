// Selector family documented in public WhatsApp Web extensions. Structural only:
// never read DOM text or infer message identity from the text subtree.
export function incomingTextAnchor(bubble: HTMLElement): HTMLElement | null {
  const candidates = Array.from(
    bubble.querySelectorAll<HTMLElement>(".copyable-text .selectable-text"),
  ).filter(
    (el) =>
      el.closest("[data-id]") === bubble &&
      !el.closest(
        '[data-testid="quoted-message"], .quoted-message, blockquote, .wa-translate-incoming-note',
      ),
  );
  const outer = candidates.filter(
    (el) => !candidates.some((other) => other !== el && other.contains(el)),
  );
  return outer.length === 1 &&
    outer[0].parentElement?.closest("[data-id]") === bubble
    ? outer[0]
    : null;
}
export function showIncomingText(
  bubble: HTMLElement,
  text: string,
  retry?: () => void,
): { remove(): void; connected(): boolean } {
  const anchor = incomingTextAnchor(bubble);
  if (!anchor) return { remove() {}, connected: () => false };
  // An annotation may outlive a hot reinjection; deduplicate only our own nodes.
  for (const old of bubble.querySelectorAll(".wa-translate-incoming-note"))
    old.remove();
  const note = document.createElement("div");
  note.className = "wa-translate-incoming-note";
  note.setAttribute("dir", "auto");
  note.setAttribute("role", "note");
  note.style.cssText =
    "white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;color:inherit;margin-top:6px;";
  note.textContent = text;
  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "重试";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.isTrusted) retry();
    });
    note.appendChild(button);
  }
  anchor.insertAdjacentElement("afterend", note);
  return {
    remove: () => note.remove(),
    connected: () =>
      note.isConnected &&
      anchor.isConnected &&
      note.previousElementSibling === anchor &&
      incomingTextAnchor(bubble) === anchor,
  };
}
