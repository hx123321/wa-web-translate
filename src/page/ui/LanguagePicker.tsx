import { directionSymbol, diagnosticWarning } from "./picker-indicator";
import { getHistoryStatus, HISTORY_STATUS_EVENT } from "../translation-history";
import {
  getOutgoingDiagnostics,
  getOutgoingDiagnosticLabel,
} from "../outgoing-diagnostics";
import { FLOATING_DRAG_START } from "./floating-layout";
import { closeDraft } from "../hooks/composer";
import {
  getIncomingDiagnostics,
  getIncomingDiagnosticLabel,
  exportTranslationDiagnostics,
  clearTranslationDiagnostics,
} from "../diagnostics";
import {
  getCapabilities,
  getPreviewLayout,
  getIncomingError,
  getIncomingStatus,
} from "../capabilities";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pickerPosition, trackPicker } from "./picker-position";
import { getActiveChatId } from "../wa";
import { getChatLang, getIncomingLang, subscribe } from "../store";
import { DirectionPanel } from "./DirectionPanel";
export function LanguagePicker({ chatIdSignal }: { chatIdSignal: number }) {
  void chatIdSignal;
  const chatId = getActiveChatId();
  const [, force] = useState(0);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"settings" | "logs">("settings");
  const [copyStatus, setCopyStatus] = useState("");
  const [logText, setLogText] = useState("");
  const [previewLayout, setPreviewLayout] = useState(getPreviewLayout);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<
    typeof pickerPosition
  > | null>(null);
  const [historyStatus, setHistoryStatus] = useState(getHistoryStatus);
  const [incomingStatus, setIncomingStatus] = useState(getIncomingStatus);
  const [incomingError, setIncomingError] = useState(getIncomingError);
  const [capabilities, setCapabilities] = useState(getCapabilities);
  useEffect(() => {
    const historyChanged = () => setHistoryStatus(getHistoryStatus());
    window.addEventListener(HISTORY_STATUS_EVENT, historyChanged);
    const changed = (e: Event) => setCapabilities((e as CustomEvent).detail);
    const errorChanged = () => {
      force((n) => n + 1);
      setIncomingError(getIncomingError());
      setIncomingStatus(getIncomingStatus());
    };
    const pick = () => setOpen(false);
    const dragStarted = (event: Event) => {
      if (event.target === buttonRef.current) setOpen(false);
    };
    window.addEventListener(FLOATING_DRAG_START, dragStarted);
    const layout = () => setPreviewLayout(getPreviewLayout());
    layout();
    window.addEventListener("wa-translate:preview-layout", layout);
    window.addEventListener("wa-translate:pick-message", pick);
    window.addEventListener("wa-translate:incoming-status", errorChanged);
    window.addEventListener("wa-translate:capabilities", changed);
    return () => {
      window.removeEventListener(HISTORY_STATUS_EVENT, historyChanged);
      window.removeEventListener(FLOATING_DRAG_START, dragStarted);
      window.removeEventListener("wa-translate:preview-layout", layout);
      window.removeEventListener("wa-translate:capabilities", changed);
      window.removeEventListener("wa-translate:incoming-status", errorChanged);
      window.removeEventListener("wa-translate:pick-message", pick);
    };
  }, []);
  useEffect(() => subscribe("chatLangs", () => force((n) => n + 1)), []);
  useEffect(() => {
    setOpen(false);
  }, [chatId]);
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !panelRef.current) return;
    const button = buttonRef.current;
    const panel = panelRef.current;
    const place = () => {
      const visual = window.visualViewport;
      const next = pickerPosition(button.getBoundingClientRect(), {
        left: visual?.offsetLeft ?? 0,
        top: visual?.offsetTop ?? 0,
        width: visual?.width ?? window.innerWidth,
        height: visual?.height ?? window.innerHeight,
      });
      setPosition((previous) =>
        previous && JSON.stringify(previous) === JSON.stringify(next)
          ? previous
          : next,
      );
    };
    return trackPicker(button, panel, place, () => setOpen(false));
  }, [open, chatId]);
  const incomingLabel = capabilities.waiting
    ? "接收检测中"
    : !capabilities.incoming
      ? "接收暂不可用"
      : incomingStatus;
  const active = chatId && (getChatLang(chatId) || getIncomingLang(chatId));
  const incomingTarget = chatId ? getIncomingLang(chatId) : null;
  const outgoingTarget = chatId ? getChatLang(chatId) : null;
  const warning =
    !!historyStatus ||
    !!incomingError ||
    previewLayout === false ||
    (!capabilities.waiting &&
      ((!capabilities.incoming && !!incomingTarget) ||
        (!capabilities.send && !!outgoingTarget))) ||
    diagnosticWarning(getIncomingDiagnostics()) ||
    diagnosticWarning(getOutgoingDiagnostics());
  const buttonLabel = `收发翻译设置，接收目标${directionSymbol(incomingTarget)}，发送目标${directionSymbol(outgoingTarget)}${warning ? "；有异常，请查看日志" : ""}`;
  return (
    <div className="wa-translate-picker-host">
      <button
        ref={buttonRef}
        className="wa-translate-picker-btn"
        data-active={active ? "true" : "false"}
        type="button"
        disabled={!chatId}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? "wa-translate-picker-pop" : undefined}
        title={buttonLabel}
        aria-label={buttonLabel}
        data-warning={warning ? "true" : "false"}
      >
        <span aria-hidden="true">{warning || !chatId ? "⚠" : "🌐"}</span>
        <span aria-hidden="true">收 {directionSymbol(incomingTarget)}</span>
        <span aria-hidden="true">发 {directionSymbol(outgoingTarget)}</span>
      </button>
      {open &&
        chatId &&
        createPortal(
          <div
            id="wa-translate-picker-pop"
            ref={panelRef}
            className="wa-translate-picker-pop"
            role="dialog"
            aria-label="收发翻译设置"
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              width: position?.width ?? 340,
              height: position?.height ?? 420,
              visibility: position ? "visible" : "hidden",
            }}
          >
            <button
              type="button"
              className="wa-translate-picker-close"
              onClick={() => setOpen(false)}
              aria-label="关闭收发翻译设置"
            >
              关闭
            </button>
            <div
              className="wa-translate-panel-tabs"
              role="tablist"
              aria-label="翻译面板"
            >
              {(["settings", "logs"] as const).map((name, index) => (
                <button
                  key={name}
                  id={`wa-tab-${name}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === name}
                  aria-controls={`wa-panel-${name}`}
                  tabIndex={tab === name ? 0 : -1}
                  onClick={() => setTab(name)}
                  onKeyDown={(event) => {
                    let next: "settings" | "logs" | null = null;
                    if (event.key === "ArrowRight" || event.key === "ArrowLeft")
                      next = index === 0 ? "logs" : "settings";
                    if (event.key === "Home") next = "settings";
                    if (event.key === "End") next = "logs";
                    if (next) {
                      event.preventDefault();
                      setTab(next);
                      document.getElementById(`wa-tab-${next}`)?.focus();
                    }
                  }}
                >
                  {name === "settings" ? "设置" : "日志"}
                </button>
              ))}
            </div>
            <div
              id="wa-panel-settings"
              className="wa-translate-tab-panel"
              role="tabpanel"
              aria-labelledby="wa-tab-settings"
              hidden={tab !== "settings"}
            >
              <p role="status">
                {capabilities.waiting
                  ? "正在检测收发兼容性…"
                  : `发送：${capabilities.send ? "已就绪" : "暂不兼容"}；接收：${capabilities.incoming ? "已就绪" : "暂不兼容"}。未就绪时请刷新页面重试。`}
              </p>
              {incomingError && <p role="status">接收翻译：{incomingError}</p>}
              {previewLayout === false && (
                <p role="status">
                  当前窗口没有足够空间显示预览，请放大窗口。也可在下方关闭草稿翻译，恢复原文发送。
                </p>
              )}

              <button
                type="button"
                className="wa-translate-picker-close"
                onClick={closeDraft}
              >
                关闭当前草稿翻译，恢复原文发送
              </button>
              <DirectionPanel key={chatId} chatId={chatId} />
            </div>
            <div
              id="wa-panel-logs"
              className="wa-translate-tab-panel"
              role="tabpanel"
              aria-labelledby="wa-tab-logs"
              hidden={tab !== "logs"}
            >
              <div className="wa-translate-diagnostics">
                <h3>收发阶段日志</h3>
                <div
                  className="wa-translate-status-details"
                  role="status"
                  aria-label="完整翻译状态"
                >
                  <p>接收状态：{incomingError || incomingLabel}</p>
                  <p>保存状态：{historyStatus || "暂无保存异常"}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const text = exportTranslationDiagnostics();
                    setLogText(text);
                    void Promise.resolve()
                      .then(() => navigator.clipboard.writeText(text))
                      .then(() => setCopyStatus("脱敏日志已复制"))
                      .catch(() =>
                        setCopyStatus("无法自动复制，请从下方文本框手动复制"),
                      );
                  }}
                >
                  复制脱敏日志
                </button>
                {copyStatus && <p role="status">{copyStatus}</p>}
                {logText && (
                  <textarea
                    aria-label="可复制脱敏日志"
                    readOnly
                    value={logText}
                  />
                )}
                <p>
                  仅记录本窗口状态；不含消息内容。未核实实际消息送达，不显示未观测到的后台重试次数。
                </p>
                <button
                  type="button"
                  onClick={() => {
                    clearTranslationDiagnostics();
                    setLogText("");
                    setCopyStatus("");
                  }}
                >
                  清空日志
                </button>
                <strong>发送链</strong>
                <ol>
                  {getOutgoingDiagnostics().map((entry, index) => (
                    <li key={index}>
                      {new Date(entry.time).toLocaleTimeString()} ·{" "}
                      {getOutgoingDiagnosticLabel(entry.stage)}（{entry.stage}）
                      · {entry.count}
                    </li>
                  ))}
                </ol>
                <strong>接收链</strong>
                <ol>
                  {getIncomingDiagnostics().map((entry, index) => (
                    <li key={index}>
                      {new Date(entry.time).toLocaleTimeString()} ·{" "}
                      {getIncomingDiagnosticLabel(entry.stage)}（{entry.stage}）
                      · {entry.count}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
