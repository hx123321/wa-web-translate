// Share one conservative DOM probe between the existing picker and draft observer.
// Never bind to WhatsApp's sidebar search editor or an unrelated editable element.
export function findComposer(): HTMLElement | null {
  const main = document.querySelector("#main");
  if (!main) return null;
  const candidates = main.querySelectorAll<HTMLElement>(
    '[contenteditable="true"][role="textbox"]',
  );
  return candidates.length ? candidates[candidates.length - 1] : null;
}
export function findFooter(): HTMLElement | null {
  const composer = findComposer();
  if (!composer) return null;
  return (
    composer.closest<HTMLElement>("footer") ??
    composer.parentElement?.parentElement ??
    null
  );
}
