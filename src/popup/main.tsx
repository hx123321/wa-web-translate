import { customEndpoint } from "@/shared/endpoint";
import { quickChoices, selectedChoice } from "@/shared/quick-providers";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  loadConfig,
  saveConfig,
  watchConfig,
  selectTranslationChoice,
} from "@/shared/storage";
import { configured, type Config } from "@/shared/types";
import "./styles.css";

function PopupApp() {
  const [config, setConfig] = useState<Config | null>(null);
  const [customPermission, setCustomPermission] = useState(false);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    loadConfig()
      .then(setConfig)
      .catch(() => setError("设置加载失败，请重新打开。"));
    return watchConfig(setConfig);
  }, []);

  useEffect(() => {
    let current = true;
    setCustomPermission(false);
    if (config?.customCredential) {
      try {
        const endpoint = customEndpoint(config.customBaseUrl);
        chrome.permissions
          .contains({ origins: [endpoint.origin + "/*"] })
          .then((ok) => {
            if (current) setCustomPermission(ok);
          })
          .catch(() => {});
      } catch {}
    }
    return () => {
      current = false;
    };
  }, [config]);
  if (!config) return <div className="popup-shell" role="status">{error || "正在加载…"}</div>;

  const hasKey = configured(config);
  const choices = quickChoices(config).filter(
    (c) => c.id !== "llm:custom" || customPermission,
  );
  const selected = selectedChoice(config);
  const available = choices.some((c) => c.id === selected);
  return (
    <div className="popup-shell">
      <div className="popup-row">
        <strong>WA Web Translate</strong>
        <span className={hasKey ? "popup-pill ok" : "popup-pill warn"}>
          {hasKey ? "已配置" : "待配置"}
        </span>
      </div>
      <div className="popup-row">
        <span>当前供应商</span>
        <span>
          {config.mode === "service"
            ? `${config.service === "google" ? "Google 翻译" : "Microsoft / 必应"}（免密钥）`
            : config.provider}
        </span>
      </div>
      <label htmlFor="quick-provider">切换翻译服务</label>
      <select
        id="quick-provider"
        value={available ? selected : ""}
        disabled={switching}
        onChange={async (e) => {
          setSwitching(true);
          setError("");
          try {
            setConfig(await selectTranslationChoice(e.target.value));
          } catch {
            setError(
              "此供应商尚未配置或授权已失效，请打开设置检查。",
            );
            loadConfig()
              .then(setConfig)
              .catch(() => {});
          } finally {
            setSwitching(false);
          }
        }}
      >
        {!available && (
          <option value="" disabled>
            请选择已配置的供应商
          </option>
        )}
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      {error && <div role="status">{error}</div>}
      <p>接收和发送的语言及开关，请在聊天输入框旁的翻译面板分别设置。切换服务只保存设置，不发送现有草稿。</p>
      <label className="popup-toggle">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => {
            const next = { ...config, enabled: e.target.checked };
            setConfig(next);
            saveConfig({ enabled: e.target.checked }).catch(() => { setConfig(config); setError("保存失败，请重试。"); });
          }}
        />
        启用翻译
      </label>
      <button
        type="button"
        className="popup-btn"
        onClick={() => chrome.runtime.openOptionsPage()}
      >
        打开设置
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
