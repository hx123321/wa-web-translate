import { serializedWid } from "./chat-id";
// Thin wrappers around WhatsApp Web's internal Metro modules, exposed via window.require
// once the bundle is loaded (Web 2.3000+).

declare global {
  interface Window {
    require: (name: string) => any;
    Debug?: { VERSION?: string };
  }
}

export const isReady = (): boolean => typeof window.require === "function";

// Capability-based and bounded: Debug.VERSION is optional and is not an API.
export function waitTillReady(timeoutMs = 30000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (isReady()) resolve(true);
      else if (Date.now() - started >= timeoutMs) resolve(false);
      else setTimeout(tick, 500);
    };
    tick();
  });
}

export interface CapabilityInstallers {
  send(): boolean;
  incoming(): boolean;
  status(value: { send: boolean; incoming: boolean; waiting: boolean }): void;
}
// Independently try each missing capability. A missing incoming API cannot delay
// an available outgoing hook. Never reinstall a successful hook.
export function installCapabilities(
  installers: CapabilityInstallers,
  timeoutMs = 30000,
): () => void {
  let send = false,
    incoming = false,
    stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  const tick = () => {
    if (stopped) return;
    if (isReady()) {
      if (!send) send = installers.send();
      if (!incoming) incoming = installers.incoming();
    }
    const waiting = !(send && incoming) && Date.now() - started < timeoutMs;
    installers.status({ send, incoming, waiting });
    if (waiting) timer = setTimeout(tick, 1500);
  };
  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// WhatsApp lazy-loads many modules only after the user authenticates and opens a chat.
// Wait until the modules our hooks depend on are reachable via window.require, or until
// timeoutMs elapses (so the rest of init still proceeds even if some module is renamed).
export function waitForModules(
  modules: string[],
  timeoutMs = 60_000,
): Promise<string[]> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      const missing = modules.filter((m) => !tryRequire(m));
      if (missing.length === 0) return resolve([]);
      if (Date.now() - startedAt > timeoutMs) return resolve(missing);
      setTimeout(tick, 250);
    };
    tick();
  });
}

export function tryRequire<T = any>(name: string): T | null {
  try {
    return window.require(name) as T;
  } catch {
    return null;
  }
}

export function injectToFunction(
  target: { module: string; function: string },
  callback: (orig: (...args: any[]) => any, ...args: any[]) => any,
): boolean {
  const mod = tryRequire(target.module);
  if (!mod || typeof mod[target.function] !== "function") return false;
  const orig = mod[target.function].bind(mod);
  mod[target.function] = (...args: any[]) => callback(orig, ...args);
  return true;
}

export function getActiveChatId(): string | null {
  // Current WAWebCollections.Chat is used by whatsapp-web.js. Active-model
  // selection via findFirst(c => c.active) is documented by wa-js.
  const modern = tryRequire("WAWebCollections")?.Chat;
  // Do not probe a missing legacy module when the current collection exists.
  const stores = modern
    ? [modern]
    : [tryRequire("WAWebChatCollection")?.ChatCollection];
  for (const store of stores) {
    if (!store) continue;
    try {
      const active =
        typeof store.findFirst === "function"
          ? store.findFirst((c: any) => c?.active === true)
          : undefined;
      const id = serializedWid(active?.id);
      if (id) return id;
    } catch {}
    try {
      const active =
        typeof store.getActive === "function" ? store.getActive() : undefined;
      const id = serializedWid(active?.id);
      if (id) return id;
    } catch {}
    try {
      const models =
        typeof store.getModelsArray === "function"
          ? store.getModelsArray()
          : undefined;
      if (Array.isArray(models)) {
        const id = serializedWid(
          models.find((c: any) => c?.active === true)?.id,
        );
        if (id) return id;
      }
    } catch {}
  }
  // Never infer chat identity from a display title or header data-id.
  return null;
}
