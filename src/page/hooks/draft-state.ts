import {
  outgoingFailureStage,
  type OutgoingDiagnosticStage,
} from "../outgoing-diagnostics";
import type { TranslateRequest, TranslateResult } from "@/shared/types";
import { safeTranslationError } from "@/shared/errors";
export interface DraftState {
  chatId: string | null;
  targetLang: string | null;
  source: string;
  previewSource: string;
  previewTarget: string | null;
  previewDetectedSource: string;
  previewTranslation: string;
  translation: string;
  detectedSource: string;
  loading: boolean;
  error: string | null;
  activated: boolean;
  visible: boolean;
}
interface Entry extends DraftState {
  context: string;
  generation: number;
  abort?: AbortController;
}
export class DraftSessions {
  private entries = new Map<string, Entry>();
  constructor(
    private translate: (
      req: TranslateRequest,
      signal: AbortSignal,
    ) => Promise<TranslateResult>,
    private changed: () => void,
    private diagnostic: (stage: OutgoingDiagnosticStage) => void = () => {},
  ) {}
  read(chatId: string | null): DraftState {
    const e = chatId ? this.entries.get(chatId) : undefined;
    return e
      ? {
          chatId: e.chatId,
          targetLang: e.targetLang,
          source: e.source,
          previewSource: e.previewSource,
          previewTarget: e.previewTarget,
          previewDetectedSource: e.previewDetectedSource,
          previewTranslation: e.previewTranslation,
          translation: e.translation,
          detectedSource: e.detectedSource,
          loading: e.loading,
          error: e.error,
          activated: e.activated,
          visible: e.visible,
        }
      : {
          chatId,
          targetLang: null,
          source: "",
          previewSource: "",
          previewTarget: null,
          previewDetectedSource: "unknown",
          previewTranslation: "",
          translation: "",
          detectedSource: "unknown",
          loading: false,
          error: null,
          activated: false,
          visible: false,
        };
  }
  observe(
    chatId: string,
    text: string,
    target: string | null,
    context: string,
  ): void {
    let e = this.entries.get(chatId);
    if (!e) {
      e = { ...this.read(chatId), context, generation: 0 };
      this.entries.set(chatId, e);
    }
    if (e.source !== text || e.targetLang !== target || e.context !== context) {
      if (e.loading) this.diagnostic("cancelled");
      if (e.activated) this.diagnostic("invalidated");
      e.abort?.abort();
      e.generation++;
      e.translation = "";
      e.detectedSource = "unknown";
      e.loading = false;
      e.source = text;
      e.targetLang = target;
      e.context = context;
      if (!text) {
        e.activated = false;
        e.visible = false;
      }
      e.error = e.activated
        ? "草稿或设置已变化，请按 Alt+Enter 重新翻译。"
        : null;
      this.changed();
    }
    while (this.entries.size > 30) {
      // Activated state is a send-safety gate, not a disposable cache.
      // Only inactive entries may be evicted; retain active drafts until close/send.
      const id = [...this.entries].find(
        ([id, entry]) => id !== chatId && !entry.activated,
      )?.[0];
      if (!id) break;
      this.entries.get(id)?.abort?.abort();
      this.entries.delete(id);
    }
  }
  focus(chatId: string, focused: boolean): void {
    const e = this.entries.get(chatId);
    if (e) {
      const visible = focused && e.activated;
      if (e.visible !== visible)
        this.diagnostic(visible ? "preview_shown" : "preview_hidden");
      e.visible = visible;
      this.changed();
    }
  }
  async activate(
    chatId: string,
    text: string,
    target: string | null,
    context: string,
    enabled: boolean,
  ): Promise<void> {
    this.diagnostic("activated");
    this.observe(chatId, text, target, context);
    const e = this.entries.get(chatId)!;
    if (e.loading) this.diagnostic("cancelled");
    e.abort?.abort();
    const generation = ++e.generation;
    e.activated = true;
    e.previewSource = text;
    e.previewTarget = target;
    e.previewDetectedSource = "unknown";
    e.previewTranslation = "";
    e.visible = true;
    e.translation = "";
    e.error = null;
    e.loading = false;
    if (!enabled || !target || !text.trim()) {
      this.diagnostic(
        !enabled
          ? "rejected_disabled"
          : !target
            ? "rejected_target"
            : "rejected_body",
      );
      e.error = "请开启翻译、选择发送目标语言并输入文字。";
      this.changed();
      return;
    }
    this.diagnostic("eligible");
    e.loading = true;
    e.abort = new AbortController();
    this.changed();
    try {
      this.diagnostic("request_started");
      const result = await this.translate(
        { text, source: "auto", target },
        e.abort.signal,
      );
      if (e.generation !== generation || this.entries.get(chatId) !== e) {
        this.diagnostic("stale_discarded");
        return;
      }
      this.diagnostic("response_received");
      if (
        result.target !== target ||
        typeof result.translated !== "string" ||
        !result.translated.trim()
      )
        throw new Error("Invalid or empty translation");
      e.translation = result.translated;
      e.previewTranslation = result.translated;
      e.detectedSource = result.source;
      e.previewDetectedSource = result.source;
      e.loading = false;
      this.diagnostic("preview_ready");
      this.changed();
    } catch (error) {
      if (e.generation !== generation || this.entries.get(chatId) !== e) {
        this.diagnostic("stale_discarded");
        return;
      }
      this.diagnostic(outgoingFailureStage(error));
      e.loading = false;
      e.error = safeTranslationError(error).message;
      this.changed();
    }
  }
  forSend(
    chatId: string,
    text: string,
    target: string | null,
    context: string,
  ): TranslateResult | null {
    const e = this.entries.get(chatId);
    if (!e?.activated) return null;
    if (
      e.source !== text ||
      e.targetLang !== target ||
      e.context !== context ||
      e.loading ||
      !e.translation ||
      !target
    )
      throw new Error("Activated draft needs a matching translation");
    return { translated: e.translation, source: e.detectedSource, target };
  }
  updateTargets(
    target: (chatId: string) => string | null,
    context: string,
  ): void {
    for (const [chatId, e] of this.entries)
      this.observe(chatId, e.source, target(chatId), context);
  }
  invalidate(): void {
    for (const e of this.entries.values()) {
      if (e.loading) this.diagnostic("cancelled");
      if (e.activated) this.diagnostic("invalidated");
      e.abort?.abort();
      e.generation++;
      e.translation = "";
      e.loading = false;
      if (e.activated) e.error = "设置已变化，请按 Alt+Enter 重新翻译。";
    }
    this.changed();
  }
  sendFailed(chatId: string): void {
    const e = this.entries.get(chatId);
    if (e?.activated) {
      e.error =
        "草稿没有匹配的有效译文，请按 Alt+Enter 重试，或关闭草稿翻译后发送原文。";
      e.visible = true;
      this.changed();
    }
  }
  close(chatId: string): void {
    const e = this.entries.get(chatId);
    if (e) {
      if (e.loading) this.diagnostic("cancelled");
      if (e.activated) this.diagnostic("closed");
      e.abort?.abort();
      e.generation++;
      e.activated = false;
      e.visible = false;
      e.loading = false;
      e.translation = "";
      e.error = null;
      this.changed();
    }
  }
  sent(chatId: string, text: string): void {
    if (this.entries.get(chatId)?.source === text) this.close(chatId);
  }
  dispose(): void {
    for (const e of this.entries.values()) {
      if (e.loading) this.diagnostic("cancelled");
      e.abort?.abort();
    }
    if (this.entries.size) this.diagnostic("disposed");
    this.entries.clear();
    this.changed();
  }
}
