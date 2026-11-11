import { useEffect, useState } from "react";
import { getActiveChatId } from "../wa";
import { subscribe } from "../store";
import { ATTACH_MENU_OPEN_EVENT } from "../hooks/attach-menu";
import { DirectionPanel } from "./DirectionPanel";
export function ModalPicker() {
  const [chatId, setChatId] = useState<string | null>(null);
  const [, force] = useState(0);
  useEffect(() => subscribe("chatLangs", () => force((n) => n + 1)), []);
  useEffect(() => {
    const open = (e: Event) => {
      const active = getActiveChatId();
      setChatId(
        active && (e as CustomEvent).detail?.chatId === active ? active : null,
      );
    };
    window.addEventListener(ATTACH_MENU_OPEN_EVENT, open);
    return () => window.removeEventListener(ATTACH_MENU_OPEN_EVENT, open);
  }, []);
  useEffect(() => {
    if (!chatId) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChatId(null);
    };
    const timer = setInterval(() => {
      if (getActiveChatId() !== chatId) setChatId(null);
    }, 500);
    window.addEventListener("keydown", key);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", key);
    };
  }, [chatId]);
  if (!chatId) return null;
  return (
    <div className="wa-translate-modal-overlay" onClick={() => setChatId(null)}>
      <div
        className="wa-translate-modal-card"
        role="dialog"
        aria-label="收发翻译设置"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wa-translate-modal-head">
          <strong>收发翻译设置</strong>
          <button type="button" onClick={() => setChatId(null)}>
            关闭
          </button>
        </div>
        <DirectionPanel key={chatId} chatId={chatId} />
      </div>
    </div>
  );
}
