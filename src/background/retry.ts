import { safeTranslationError, TranslationError } from "@/shared/errors";

export function transientFailure(error: unknown): boolean {
  const e = safeTranslationError(error);
  return (
    e.code === "network" ||
    e.code === "timeout" ||
    (typeof e.status === "number" &&
      (e.status === 408 || e.status === 429 || e.status >= 500))
  );
}
// One retry budget for the entire translation, not for every chunk. Successful
// chunks remain in the caller's accumulator. This never invokes WhatsApp send.
export class TranslationOperation {
  readonly signal: AbortSignal;
  private controller = new AbortController();
  private retries = 1;
  private timer: ReturnType<typeof setTimeout>;
  private detach: () => void;
  constructor(
    private verify: () => Promise<void>,
    external?: AbortSignal,
    deadlineMs = 28000,
  ) {
    this.signal = this.controller.signal;
    const cancel = () =>
      this.controller.abort(new TranslationError("cancelled"));
    external?.addEventListener("abort", cancel, { once: true });
    this.detach = () => external?.removeEventListener("abort", cancel);
    if (external?.aborted) cancel();
    this.timer = setTimeout(
      () => this.controller.abort(new TranslationError("timeout")),
      deadlineMs,
    );
  }
  async run<T>(action: () => Promise<T>): Promise<T> {
    for (;;) {
      this.signal.throwIfAborted();
      await this.verify();
      this.signal.throwIfAborted();
      try {
        const result = await action();
        this.signal.throwIfAborted();
        return result;
      } catch (error) {
        this.signal.throwIfAborted();
        if (!this.retries || !transientFailure(error)) throw error;
        this.retries--;
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(this.signal.reason);
          };
          const timer = setTimeout(() => {
            this.signal.removeEventListener("abort", abort);
            resolve();
          }, 350);
          this.signal.addEventListener("abort", abort, { once: true });
        });
      }
    }
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.detach();
  }
}
