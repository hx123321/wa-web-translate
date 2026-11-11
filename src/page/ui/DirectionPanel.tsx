import { useState } from "react";
import { LANGUAGES } from "@/shared/languages";
import { getChatLang, getIncomingLang, setChatLang } from "../store";
import type { Direction } from "@/shared/chat-directions";
const names = new Intl.DisplayNames(["zh-CN"], { type: "language" });
export function chineseLanguage(code: string): string {
  try {
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}
export function DirectionPanel({ chatId }: { chatId: string }) {
  const [direction, setDirection] = useState<Direction>("incoming");
  const [query, setQuery] = useState("");
  const current =
    direction === "incoming" ? getIncomingLang(chatId) : getChatLang(chatId);
  const q = query.trim().toLowerCase();
  const languages = LANGUAGES.filter((l) =>
    [l.code, l.name, l.native, chineseLanguage(l.code)].some((v) =>
      v.toLowerCase().includes(q),
    ),
  );
  return (
    <div className="wa-translate-direction-panel">
      <div
        className="wa-translate-direction-tabs"
        role="group"
        aria-label="翻译方向"
      >
        <button
          type="button"
          aria-pressed={direction === "incoming"}
          onClick={() => setDirection("incoming")}
        >
          接收翻译
        </button>
        <button
          type="button"
          aria-pressed={direction === "outgoing"}
          onClick={() => setDirection("outgoing")}
        >
          发送翻译
        </button>
      </div>
      <p>
        接收：
        {getIncomingLang(chatId)
          ? chineseLanguage(getIncomingLang(chatId)!)
          : "关闭"}{" "}
        · 发送：
        {getChatLang(chatId) ? chineseLanguage(getChatLang(chatId)!) : "关闭"}
      </p>
      <p>
        {direction === "incoming"
          ? "自动识别来源，仅翻译开启后新收到的可定位纯文本。"
          : "自动识别输入语言，翻译成功后再发送；失败不发送。按 Alt+Enter 激活或重新翻译草稿；未激活则发送原文。"}
      </p>
      <button
        type="button"
        aria-pressed={!current}
        onClick={() => setChatLang(chatId, null, direction)}
      >
        关闭{direction === "incoming" ? "接收" : "发送"}翻译
      </button>
      <p>
        悬停一条已收到的纯文本，在表情按钮旁点击圆形“译”，仅将这一条原文交给当前服务。可主动重译历史消息，不翻译合并后的显示文本。
      </p>
      <input
        className="wa-translate-picker-search"
        placeholder="搜索语言（中文 / 代码）"
        aria-label="搜索目标语言"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="wa-translate-picker-list">
        {languages.map((l) => (
          <button
            type="button"
            key={l.code}
            className="wa-translate-picker-item"
            aria-pressed={current === l.code}
            onClick={() => setChatLang(chatId, l.code, direction)}
          >
            <span>
              {chineseLanguage(l.code)} · {l.native}
            </span>
            <span>{l.code}</span>
          </button>
        ))}
        {!languages.length && <p>没有匹配的语言</p>}
      </div>
    </div>
  );
}
