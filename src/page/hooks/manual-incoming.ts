import { committedBubbleModel } from "./rendered-message";
import { getActiveChatId } from "../wa";
import { getConfig, getIncomingLang, subscribe } from "../store";
import { setIncomingError } from "../capabilities";
import {
  findIncomingBubble,
  incomingIdentity,
  type Message,
} from "./incoming-annotations";

export const PICK_MESSAGE_EVENT = "wa-translate:pick-message";
export interface ManualPickerDeps {
  getModel(id: string, chat: string): Message | null;
  select(msg: Message, id: string, chat: string): boolean;
}
// Public maintained source: whatsapp-web.js src/util/Injected/Utils.js uses
// WAWebCollections.Msg.get(msgId). No getMessagesById/network/history fallback.
export function installManualIncomingPicker(
  deps: ManualPickerDeps,
): () => void {
  let chat: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    chat = null;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    document.removeEventListener("click", click, true);
    window.removeEventListener("keydown", keydown);
  };
  const click = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const selectedChat = chat;
    const target = event.target instanceof Element ? event.target : null;
    const bubble = target?.closest<HTMLElement>("#main [data-id]");
    const id = bubble?.getAttribute("data-id");
    if (!bubble || !id || target?.closest(".wa-translate-incoming-note"))
      return;
    event.preventDefault();
    event.stopPropagation();
    if (
      !selectedChat ||
      getActiveChatId() !== selectedChat ||
      !getConfig().enabled ||
      !getIncomingLang(selectedChat) ||
      id.length > 512 ||
      /[\x00-\x1f\x7f]/.test(id) ||
      findIncomingBubble(id, selectedChat) !== bubble
    ) {
      if (getActiveChatId() !== selectedChat) cancel();
      setIncomingError(
        "无法确认这条消息，请重新选择当前聊天中可见的单条纯文本。",
      );
      return;
    }
    try {
      // Resolve a complete key or a proven committed rendered model.
      // Active chat alone never proves ownership of a raw-ID bubble.
      const model = deps.getModel(id, selectedChat);
      if (
        !model ||
        !deps.select(model, incomingIdentity(model)!.id, selectedChat)
      )
        setIncomingError(
          "无法验证所选气泡的完整消息身份与当前渲染归属，请重新选择。",
        );
      else {
        cancel();
        setIncomingError("");
      }
    } catch {
      setIncomingError("无法读取所选消息的兼容接口，请稍后再试。");
    }
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      cancel();
      setIncomingError("");
    }
  };
  const arm = () => {
    cancel();
    chat = getActiveChatId();
    if (!chat || !getConfig().enabled || !getIncomingLang(chat)) {
      chat = null;
      setIncomingError("请先在当前聊天选择接收翻译语言，再点选一条消息。");
      return;
    }
    setIncomingError(
      "请点击当前聊天的一条已收到纯文本；按 Esc 取消，30秒后自动取消。",
    );
    document.addEventListener("click", click, true);
    window.addEventListener("keydown", keydown);
    timer = setTimeout(() => {
      cancel();
      setIncomingError(
        "点选已超时结束；请重新点击点选翻译后选择一条已收到的纯文本。",
      );
    }, 30000);
  };
  const unconfig = subscribe("config", cancel);
  const unchat = subscribe("chatLangs", cancel);
  window.addEventListener(PICK_MESSAGE_EVENT, arm);
  return () => {
    cancel();
    unconfig();
    unchat();
    window.removeEventListener(PICK_MESSAGE_EVENT, arm);
  };
}

// Msg.get(fullId) is documented by wwebjs Utils.js. Raw IDs are accepted only
// via the verified current rendered model and same-object store membership.
// Never scan active-chat models or infer a complete key from a raw ID.
export function resolveManualIncomingModel(
  domId: string,
  chatId: string,
  collections: any,
): Message | null {
  if (
    !domId ||
    domId.length > 512 ||
    /[\x00-\x1f\x7f]/.test(domId) ||
    getActiveChatId() !== chatId
  )
    return null;
  // Some WA stores reject a raw key by throwing. That is not a failed
  // render proof: resolve the clicked node independently before full-key lookup.
  let direct: Message | null = null;
  try {
    direct =
      typeof collections?.Msg?.get === "function"
        ? collections.Msg.get(domId)
        : null;
  } catch {
    /* Only the independently proven full key may be queried next. */
  }
  const identity = direct ? incomingIdentity(direct) : null;
  if (!identity || identity.id !== domId) {
    const bubble =
      typeof document !== "undefined"
        ? findIncomingBubble(domId, chatId)
        : null;
    const rendered = bubble
      ? (committedBubbleModel(bubble) as Message | null)
      : null;
    const bound = rendered ? incomingIdentity(rendered) : null;
    if (
      !bound ||
      bound.rawId !== domId ||
      bound.chat !== chatId ||
      getActiveChatId() !== chatId ||
      collections?.Msg?.get(bound.id) !== rendered
    )
      return null;
    return rendered;
  }
  return identity?.id === domId &&
    identity.chat === chatId &&
    getActiveChatId() === chatId
    ? direct
    : null;
}
