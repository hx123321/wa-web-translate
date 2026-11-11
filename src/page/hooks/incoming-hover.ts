import {
  incomingIdentity,
  findIncomingBubble,
  type Message,
} from "./incoming-annotations";
import { getConfig, getIncomingLang, subscribe } from "../store";
import { getActiveChatId } from "../wa";
import { setIncomingError } from "../capabilities";
import { createDomScheduler } from "../dom-scheduler";
export interface HoverActionDeps {
  getModel(id: string, chat: string): Message | null;
  select(msg: Message, id: string, chat: string): boolean;
}
// Verified content-free local inspection: the reaction action is the unique
// [role=button][data-testid=reaction-entry-point] inside the same data-id row.
// icon-down-context is a different action and must never serve as this anchor.
export function reactionAnchor(bubble: HTMLElement): HTMLElement | null {
  const matches = Array.from(
    bubble.querySelectorAll<HTMLElement>(
      '[role="button"][data-testid="reaction-entry-point"],button[data-testid="reaction-entry-point"]',
    ),
  ).filter(
    (el) =>
      el.closest("[data-id]") === bubble &&
      el.isConnected &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== "hidden",
  );
  return matches.length === 1 ? matches[0] : null;
}
export function installIncomingHoverAction(deps: HoverActionDeps): () => void {
  let hovered: HTMLElement | null = null;
  let bubble: HTMLElement | null = null,
    chat: string | null = null,
    model: Message | null = null,
    fullId: string | null = null;
  let button: HTMLButtonElement | null = null,
    hideTimer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    button?.remove();
    button = null;
    bubble = null;
    chat = null;
    model = null;
    fullId = null;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = undefined;
  };
  const valid = () => {
    if (
      !bubble ||
      !chat ||
      !model ||
      !fullId ||
      getActiveChatId() !== chat ||
      !getConfig().enabled ||
      !getIncomingLang(chat)
    )
      return false;
    const domId = bubble.getAttribute("data-id"),
      identity = incomingIdentity(model);
    return (
      !!domId &&
      identity?.id === fullId &&
      identity.chat === chat &&
      model.type === "chat" &&
      deps.getModel(domId, chat) === model &&
      findIncomingBubble(fullId, chat, identity.rawId) === bubble
    );
  };
  const position = () => {
    if (!button || !bubble) return;
    if (!valid()) {
      hide();
      return;
    }
    const anchor = reactionAnchor(bubble);
    if (!anchor) {
      if (button.matches(":hover") || document.activeElement === button) return;
      hide();
      return;
    }
    const rect = anchor.getBoundingClientRect(),
      viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0,
      top = viewport?.offsetTop ?? 0,
      width = viewport?.width ?? window.innerWidth,
      height = viewport?.height ?? window.innerHeight;
    const size = Math.max(26, Math.min(40, rect.width || 26)),
      gap = 6;
    let x = rect.right + gap;
    if (x + size > left + width - 8) x = rect.left - gap - size;
    if (x < left + 8 || rect.top < top || rect.bottom > top + height) {
      hide();
      return;
    }
    button.style.left = `${x}px`;
    button.style.top = `${Math.max(top + 8, Math.min(rect.top + (rect.height - size) / 2, top + height - size - 8))}px`;
    button.style.width = `${size}px`;
    button.style.height = `${size}px`;
  };
  const schedule = createDomScheduler(() => {
    if (hovered) show(hovered);
    else position();
  }, 50);
  const show = (candidate: HTMLElement) => {
    const active = getActiveChatId(),
      domId = candidate.getAttribute("data-id");
    if (
      button &&
      bubble === candidate &&
      (button.matches(":hover") || document.activeElement === button)
    ) {
      position();
      return;
    }
    if (
      !active ||
      !domId ||
      !getConfig().enabled ||
      !getIncomingLang(active) ||
      !reactionAnchor(candidate)
    ) {
      hide();
      return;
    }
    const resolved = deps.getModel(domId, active),
      identity = resolved ? incomingIdentity(resolved) : null;
    if (
      !resolved ||
      !identity ||
      identity.chat !== active ||
      resolved.type !== "chat" ||
      findIncomingBubble(identity.id, active, identity.rawId) !== candidate
    ) {
      hide();
      return;
    }
    if (button && bubble === candidate && model === resolved) {
      position();
      return;
    }
    hide();
    bubble = candidate;
    chat = active;
    model = resolved;
    fullId = identity.id;
    button = document.createElement("button");
    button.type = "button";
    button.className = "wa-translate-hover-action";
    button.textContent = "译";
    button.title = "翻译或重新翻译这条原文";
    button.setAttribute("aria-label", "翻译或重新翻译这条原文");
    button.style.cssText =
      "position:fixed;z-index:2147483646;border-radius:50%;display:flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--border-default,#52616a);background:var(--incoming-background,#202c33);color:var(--primary,#fff);font:600 14px system-ui;cursor:pointer;box-shadow:0 1px 4px #0004;";
    button.addEventListener("pointerenter", () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = undefined;
    });
    button.addEventListener("pointerleave", () => {
      hideTimer = setTimeout(() => {
        hovered = null;
        hide();
      }, 250);
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.isTrusted) return;
      if (!valid() || !model || !fullId || !chat) {
        hide();
        setIncomingError("消息位置已变化，请重新悬停后点击译。");
        return;
      }
      // Only this explicit click allows reading/transmitting the model's original.
      if (!deps.select(model, fullId, chat))
        setIncomingError(
          "这条消息暂时无法翻译，或已有请求处理中。请稍后重试。",
        );
      else setIncomingError("");
    });
    document.body.appendChild(button);
    position();
  };
  const over = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".wa-translate-hover-action")) return;
    const candidate = target?.closest<HTMLElement>("#main [data-id]");
    if (!candidate) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = undefined;
    hovered = candidate;
    show(candidate);
  };
  const leave = (event: PointerEvent) => {
    if (!bubble) return;
    const to = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (to && (bubble.contains(to) || button?.contains(to))) return;
    hideTimer = setTimeout(() => {
      hovered = null;
      hide();
    }, 250);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      hovered = null;
      hide();
    }
  };
  document.addEventListener("pointerover", over, true);
  document.addEventListener("focusin", over, true);
  document.addEventListener("pointerout", leave, true);
  window.addEventListener("keydown", key);
  window.addEventListener("scroll", position, true);
  window.addEventListener("resize", position);
  window.visualViewport?.addEventListener("resize", position);
  const observer = new MutationObserver(() => {
    if (hovered || button) schedule.request();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-id"],
  });
  const cancel = () => {
    hovered = null;
    hide();
  };
  const unconfig = subscribe("config", cancel),
    unchat = subscribe("chatLangs", cancel);
  return () => {
    hide();
    schedule.cancel();
    observer.disconnect();
    unconfig();
    unchat();
    document.removeEventListener("pointerover", over, true);
    document.removeEventListener("focusin", over, true);
    document.removeEventListener("pointerout", leave, true);
    window.removeEventListener("keydown", key);
    window.removeEventListener("scroll", position, true);
    window.removeEventListener("resize", position);
    window.visualViewport?.removeEventListener("resize", position);
  };
}
