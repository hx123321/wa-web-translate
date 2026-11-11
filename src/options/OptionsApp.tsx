import { HistorySettingsPanel } from "./HistorySettingsPanel";
import { receivedTranslationError } from "@/shared/errors";
import { BUILTIN_CONNECTIONS, editableConnection } from "./connection-settings";
import { customEndpoint } from "@/shared/endpoint";
import { useEffect, useMemo, useState, useRef } from "react";
import { LANGUAGES } from "@/shared/languages";
import { DEFAULT_CONFIG, type Config, type Provider } from "@/shared/types";
import {
  loadConfig,
  saveConfig,
  approveCustomCredential,
} from "@/shared/storage";

const PROVIDERS: { id: Provider; label: string; keyHint: string }[] = [
  { id: "anthropic", label: "Anthropic (Claude)", keyHint: "sk-ant-..." },
  { id: "deepseek", label: "DeepSeek", keyHint: "API 密钥" },
  {
    id: "custom",
    label: "自定义 OpenAI 兼容服务",
    keyHint: "此地址专用密钥",
  },
  { id: "openai", label: "OpenAI (GPT)", keyHint: "sk-..." },
  { id: "google", label: "Google (Gemini)", keyHint: "AIza..." },
];

export function OptionsApp() {
  const [config, setConfig] = useState<Config | null>(null);
  const saveSequence = useRef(0);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState("");
  const [status, setStatus] = useState<{
    tone: "ok" | "err" | "";
    text: string;
  }>({ tone: "", text: "" });

  useEffect(() => {
    loadConfig()
      .then(setConfig)
      .catch(() =>
        setStatus({ tone: "err", text: "设置加载失败，请重新打开设置页。" }),
      );
  }, []);

  const setAndSave = useMemo(
    () => (patch: Partial<Config>) => {
      const sequence = ++saveSequence.current;
      setPendingSaves((n) => n + 1);
      if (Object.hasOwn(patch, "customBaseUrl"))
        patch = {
          ...patch,
          apiKeys: { ...patch.apiKeys, custom: "" },
          customCredential: null,
        };
      else if (patch.apiKeys && Object.hasOwn(patch.apiKeys, "custom"))
        patch = { ...patch, customCredential: null };
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              ...patch,
              apiKeys: { ...prev.apiKeys, ...patch.apiKeys },
              model: { ...prev.model, ...patch.model },
            }
          : prev,
      );
      saveConfig(patch)
        .then((saved) => {
          if (sequence === saveSequence.current) setConfig(saved);
          setStatus({ tone: "ok", text: "已保存" });
          setTimeout(() => setStatus({ tone: "", text: "" }), 1200);
        })
        .catch(() => setStatus({ tone: "err", text: "设置保存失败，请重试。" }))
        .finally(() => setPendingSaves((n) => n - 1));
    },
    [],
  );

  if (!config) {
    return (
      <div className="opts-shell" role="status">
        {status.text || "正在加载…"}
      </div>
    );
  }

  const setApiKey = (provider: Provider, key: string) => {
    setAndSave({ apiKeys: { [provider]: key } });
  };

  const setModel = (provider: Provider, model: string) => {
    setAndSave({ model: { [provider]: model } });
  };

  return (
    <div className="opts-shell">
      <h1>WA Web Translate</h1>
      <p className="opts-sub">
        WhatsApp 网页翻译。设置自动保存；接收与发送语言在聊天输入框旁分别设置。
      </p>

      <section className="opts-section">
        <h2>旧设置迁移默认语言</h2>
        <div className="opts-row">
          <label htmlFor="native-lang">旧聊天接收目标的迁移默认值</label>
          <select
            id="native-lang"
            value={config.nativeLang}
            onChange={(e) => setAndSave({ nativeLang: e.target.value })}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.native} ({l.name})
              </option>
            ))}
          </select>
          <div className="opts-help">
            仅用于旧聊天设置迁移。接收与发送均自动识别原文语言，各自目标与开关请在聊天翻译面板设置。修改此项不会改变已迁移聊天的目标。
          </div>
        </div>
      </section>

      <section className="opts-section">
        <h2>翻译供应商</h2>
        <p className="opts-help">
          翻译请求对已核实支持的 DeepSeek、Claude 4.x、Gemini 2.5 Flash 和指定
          GPT
          模型显式关闭思考。其他模型不发送未知参数，不保证关闭；自定义服务可选择关闭参数格式。
        </p>
        <div className="opts-row">
          <label htmlFor="translation-mode">翻译类型</label>
          <select
            id="translation-mode"
            value={config.mode}
            onChange={(e) =>
              setAndSave({ mode: e.target.value as Config["mode"] })
            }
          >
            <option value="llm">大语言模型</option>
            <option value="service">翻译服务（无需 API 密钥）</option>
          </select>
        </div>
        {config.mode === "service" ? (
          <div className="opts-row">
            <label htmlFor="translation-service">服务</label>
            <select
              id="translation-service"
              value={config.service}
              onChange={(e) =>
                setAndSave({ service: e.target.value as Config["service"] })
              }
            >
              <option value="google">Google 翻译（免密钥）</option>
              <option value="microsoft">Microsoft / 必应翻译（免密钥）</option>
            </select>
            <p className="opts-help">
              沿用 VantreLingo 的非官方 Google / Microsoft Edge 接口，无需用户
              API
              密钥，不保证可用性或额度。需要翻译的文本会发送给当前选中的服务；失败不会自动切换供应商。
            </p>
          </div>
        ) : (
          <>
            <div className="opts-row">
              <p className="opts-help">
                连通性测试仅在点击时向当前已保存的模型服务发送固定文本“Connection
                test. Reply
                OK.”，可能产生少量费用。不会发送聊天内容，不自动重试。自定义地址须先授权；修改设置后请等待保存完成。
              </p>
              <button
                type="button"
                disabled={testing || pendingSaves > 0}
                onClick={async () => {
                  setTesting(true);
                  setTestStatus("正在测试已保存的配置…");
                  try {
                    const result = await chrome.runtime.sendMessage({
                      kind: "TEST_MODEL_CONNECTION",
                    });
                    if (result?.ok === true)
                      setTestStatus(
                        `服务已响应（${Number.isFinite(result.elapsedMs) ? result.elapsedMs : 0}毫秒）。这不代表WhatsApp聊天定位已验证。`,
                      );
                    else
                      setTestStatus(
                        receivedTranslationError(result?.code, result?.status)
                          .message,
                      );
                  } catch {
                    setTestStatus(
                      "扩展后台连接失效，请重载扩展并重新打开设置页。",
                    );
                  } finally {
                    setTesting(false);
                  }
                }}
              >
                测试连通性（可能产生费用）
              </button>
              {testStatus && <p role="status">{testStatus}</p>}
            </div>
            {config.provider !== "custom" && (
              <div className="opts-row">
                <label htmlFor="builtin-connection">当前连接地址</label>
                <input
                  id="builtin-connection"
                  value={BUILTIN_CONNECTIONS[config.provider]}
                  readOnly
                />
                <button
                  type="button"
                  disabled={pendingSaves > 0}
                  onClick={() => setAndSave(editableConnection(config))}
                >
                  修改连接地址（独立授权）
                </button>
                <p className="opts-help">
                  模型名称可在下方直接修改。修改地址将切换到自定义 OpenAI
                  兼容连接，不会复制现有密钥；请填写该地址专用密钥并授权。Claude/Gemini
                  原生协议地址不能直接作为 OpenAI 兼容地址。
                </p>
              </div>
            )}
            {config.provider === "custom" && (
              <div className="opts-row">
                <label htmlFor="custom-thinking">
                  关闭思考参数（按服务文档选择）
                </label>
                <select
                  id="custom-thinking"
                  value={config.customThinking}
                  onChange={(e) =>
                    setAndSave({
                      customThinking: e.target
                        .value as Config["customThinking"],
                    })
                  }
                >
                  <option value="omit">
                    不发送未知参数（不保证服务关闭思考）
                  </option>
                  <option value="thinking_disabled">
                    thinking.type = disabled（DeepSeek兼容）
                  </option>
                  <option value="reasoning_none">
                    reasoning_effort = none（支持此值的OpenAI兼容模型）
                  </option>
                </select>
                <p className="opts-help">
                  内置服务仅对官方明确支持的模型关闭思考；未知模型不猜参数。自定义选择仅控制请求参数，不更改地址授权。
                </p>
                <label htmlFor="custom-url">
                  OpenAI 兼容 HTTPS 基础地址（例如 https://example.com/v1）
                </label>
                <input
                  id="custom-url"
                  value={config.customBaseUrl}
                  onChange={(e) =>
                    setAndSave({ customBaseUrl: e.target.value })
                  }
                />
                <button
                  type="button"
                  disabled={pendingSaves > 0 || !config.apiKeys.custom}
                  onClick={() => {
                    try {
                      const endpoint = customEndpoint(config.customBaseUrl);
                      chrome.permissions
                        .request({ origins: [endpoint.origin + "/*"] })
                        .then(async (ok) => {
                          if (!ok) throw new Error("未获得地址访问权限。");
                          const saved = await approveCustomCredential({
                            customBaseUrl: config.customBaseUrl,
                            customRevision: config.customRevision,
                            key: config.apiKeys.custom ?? "",
                          });
                          setConfig(saved);
                          setStatus({
                            tone: "ok",
                            text: "此地址和专用密钥已获授权。",
                          });
                        })
                        .catch(() =>
                          setStatus({
                            tone: "err",
                            text: "尚未授权，配置可能已变化，请核对后重试。",
                          }),
                        );
                    } catch {
                      setStatus({
                        tone: "err",
                        text: "请输入公开的 HTTPS 基础地址，不包含账号密码、查询参数或片段。",
                      });
                    }
                  }}
                >
                  授权此地址和专用密钥
                </button>
                <p className="opts-help">
                  请输入专用密钥，再明确授权此地址与密钥。修改地址会清除密钥及授权；修改密钥会撤销授权。浏览器现有访问权限不等同于本次授权。实际目标：{" "}
                  {(() => {
                    try {
                      return customEndpoint(config.customBaseUrl).href;
                    } catch {
                      return "请输入有效 HTTPS 地址";
                    }
                  })()}{" "}
                  {config.customCredential ? "已授权。" : "未授权。"}
                </p>
              </div>
            )}

            <div className="opts-providers">
              {PROVIDERS.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="opts-provider"
                  data-active={config.provider === p.id ? "true" : "false"}
                  onClick={() => setAndSave({ provider: p.id })}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {PROVIDERS.map((p) => (
              <div
                key={p.id}
                style={{ display: config.provider === p.id ? "block" : "none" }}
              >
                <div className="opts-row">
                  <label htmlFor={`apikey-${p.id}`}>{p.label} API 密钥</label>
                  <input
                    id={`apikey-${p.id}`}
                    type="password"
                    placeholder={p.keyHint}
                    value={config.apiKeys[p.id] ?? ""}
                    onChange={(e) => setApiKey(p.id, e.target.value)}
                  />
                  <div className="opts-help">
                    密钥仅保存在本机扩展存储中，不进行云同步。
                  </div>
                </div>
                <div className="opts-row">
                  <label htmlFor={`model-${p.id}`}>模型名称</label>
                  <input
                    id={`model-${p.id}`}
                    type="text"
                    value={
                      config.model[p.id] ?? DEFAULT_CONFIG.model[p.id] ?? ""
                    }
                    onChange={(e) => setModel(p.id, e.target.value)}
                  />
                </div>
              </div>
            ))}
          </>
        )}
      </section>

      <section className="opts-section">
        <h2>翻译风格（仅大模型）</h2>
        <div className="opts-row">
          <label htmlFor="personality">翻译风格说明</label>
          <textarea
            id="personality"
            value={config.personality}
            onChange={(e) => setAndSave({ personality: e.target.value })}
          />
          <div className="opts-help">
            作为系统提示使用。例如：“保持原文的轻松语气，使用英式拼写。”
          </div>
        </div>
      </section>

      <section className="opts-section">
        <h2>接收与发送翻译</h2>
        <p className="opts-help">
          接收和发送在每个聊天中独立开启并选择目标语言，原文语言自动识别。只有主动开启接收翻译的聊天，新收到的纯文本才会发送给当时选中的供应商；必须可靠匹配当前聊天及唯一可见气泡。译文仅作临时旁注，不修改原消息，不自动翻译历史或图片、媒体说明。你主动点选的单条收到的历史纯文本可单独翻译。关闭或切换服务不会补翻旧消息。未激活草稿时普通发送原文。Alt+Enter仅激活或重新请求当前草稿预览，不发送消息；激活后只发送匹配的就绪译文。正文或设置变更后须再次按快捷键，或关闭草稿翻译恢复原文发送。失焦隐藏、回焦恢复预览且不重新请求。兼容性检查失败时不向供应商发送收件内容，也不错误标注。
        </p>
      </section>

      <section className="opts-section">
        <h2>失败与重试</h2>
        <p className="opts-help">
          网络、超时及临时服务错误最多自动重试一次；失败后可手动重试。只使用原供应商和配置，变更设置或取消操作会停止待重试。大模型重复请求可能额外计费；已发出的请求无法撤回。不会自动重试
          WhatsApp 消息发送。
        </p>
      </section>

      <HistorySettingsPanel />

      <section className="opts-section">
        <h2>发送格式</h2>
        <div className="opts-toggle">
          <input
            id="send-both"
            type="checkbox"
            checked={config.sendBoth}
            onChange={(e) => setAndSave({ sendBoth: e.target.checked })}
          />
          <label htmlFor="send-both">发送时在译文下附上原文</label>
        </div>
        <div className="opts-help">
          格式： <code>{"<translation>\\n-----\\n<original>"}</code>
        </div>
      </section>

      <section className="opts-section">
        <h2>总开关</h2>
        <div className="opts-toggle">
          <input
            id="enabled"
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setAndSave({ enabled: e.target.checked })}
          />
          <label htmlFor="enabled">启用翻译功能</label>
        </div>
        <div className="opts-help">
          总开关关闭后停止翻译；各聊天的接收与发送开关保持独立。
        </div>
      </section>

      <div className="opts-status" data-tone={status.tone}>
        {status.text}
      </div>
    </div>
  );
}
