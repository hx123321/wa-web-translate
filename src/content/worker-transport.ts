import type { RpcMessage } from "@/shared/messages";
// A dead extension connection is not an external-provider network error.
// Never replay a request after dispatch: its external outcome may be uncertain.
export class WorkerTransport {
  private port: chrome.runtime.Port | null = null;
  private pending = new Map<string, chrome.runtime.Port>();
  constructor(
    private connectPort: () => chrome.runtime.Port,
    private publish: (message: RpcMessage) => void,
  ) {}
  private fail(id: string): void {
    this.pending.delete(id);
    this.publish({
      __waTrans: true,
      kind: "TRANSLATE_RESULT",
      id,
      ok: false,
      code: "bridge",
      error: "扩展连接已失效，请重新加载扩展后刷新 WhatsApp 页面，再手动重试。",
    });
  }
  private connect(): chrome.runtime.Port {
    if (this.port) return this.port;
    const port = this.connectPort();
    this.port = port;
    port.onMessage.addListener((message: RpcMessage) => {
      if (
        message?.kind !== "TRANSLATE_RESULT" ||
        this.pending.get(message.id) !== port
      )
        return;
      this.pending.delete(message.id);
      this.publish(message);
    });
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.port = null;
      for (const [id, owner] of this.pending) if (owner === port) this.fail(id);
    });
    return port;
  }
  prime(): void {
    try {
      this.connect();
    } catch {
      /* Report on explicit request, not page initialization. */
    }
  }
  post(message: RpcMessage): void {
    if (
      message.kind !== "TRANSLATE_REQUEST" &&
      message.kind !== "TRANSLATE_CANCEL"
    )
      return;
    if (
      typeof message.id !== "string" ||
      !message.id ||
      message.id.length > 100
    )
      return;
    if (message.kind === "TRANSLATE_CANCEL") {
      const port = this.pending.get(message.id);
      this.pending.delete(message.id);
      try {
        port?.postMessage(message);
      } catch {}
      return;
    }
    if (this.pending.has(message.id)) return;
    if (this.pending.size >= 100) {
      this.publish({
        __waTrans: true,
        kind: "TRANSLATE_RESULT",
        id: message.id,
        ok: false,
        code: "rate_limit",
        error: "翻译请求过于频繁，请稍候再试。",
      });
      return;
    }
    try {
      const port = this.connect();
      this.pending.set(message.id, port);
      port.postMessage(message);
    } catch {
      const dead = this.pending.get(message.id);
      this.port = null;
      if (dead) {
        for (const [id, owner] of this.pending)
          if (owner === dead) this.fail(id);
        try {
          dead.disconnect();
        } catch {}
      } else this.fail(message.id);
    }
  }
  dispose(): void {
    const port = this.port;
    this.port = null;
    this.pending.clear();
    try {
      port?.disconnect();
    } catch {}
  }
}
