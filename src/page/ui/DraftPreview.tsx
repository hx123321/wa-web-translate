import { useEffect, useState } from "react";
import {
  subscribeComposer,
  closeDraft,
  retryDraft,
  sessions,
  type ComposerState,
} from "../hooks/composer";
import { chineseLanguage } from "./DirectionPanel";
export function DraftPreview() {
  const [state, setState] = useState<ComposerState | null>(null);
  useEffect(() => subscribeComposer(setState), []);
  return <DraftPreviewView state={state} />;
}
export function DraftPreviewView({ state }: { state: ComposerState | null }) {
  if (!state?.activated || !state.visible) return null;
  return (
    <div
      className="wa-translate-draft"
      onBlur={(e) => {
        const next = e.relatedTarget as Element | null;
        if (
          !next?.closest?.(
            '#wa-translate-draft-host, [contenteditable="true"][role="textbox"]',
          ) &&
          state.chatId
        )
          sessions.focus(state.chatId, false);
      }}
    >
      <div className="wa-translate-draft-heading">
        <span className="wa-translate-draft-label">
          发送预览 ·{" "}
          {state.previewTarget
            ? chineseLanguage(state.previewTarget)
            : "未选择目标"}{" "}
          · 来源：
          {state.previewDetectedSource === "unknown"
            ? "待识别"
            : chineseLanguage(state.previewDetectedSource)}
        </span>
        <button
          type="button"
          onClick={closeDraft}
          title="关闭此草稿翻译，恢复原文发送"
        >
          关闭
        </button>
      </div>
      <div className="wa-translate-draft-row">
        <strong>原文：</strong>
        <span>{state.previewSource}</span>
      </div>
      <div className="wa-translate-draft-row">
        <strong>译文：</strong>
        <span>
          {state.loading ? "正在翻译…" : state.previewTranslation || "暂无译文"}
        </span>
      </div>
      {state.error ? (
        <>
          <span className="wa-translate-draft-error">{state.error}</span>
          <button type="button" onClick={retryDraft}>
            重试
          </button>
        </>
      ) : null}
    </div>
  );
}
