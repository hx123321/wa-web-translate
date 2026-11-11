# WA Web Translate 中文优化版

基于 [purpshell/wa-web-translate](https://github.com/purpshell/wa-web-translate) 的非官方 Chrome 扩展改版，为 WhatsApp Web 提供翻译辅助，并优化中文界面和本地译文保存。感谢原作者 Rajeh Taher；原项目采用 MIT 许可证，版权声明见 [LICENSE](LICENSE)。

本项目与 WhatsApp、Meta 均无关联，也未获其认可。使用扩展可能受到平台规则或网页变动影响，**不保证账号不会被封禁**。

## 功能

- 按聊天分别设置接收和发送翻译及目标语言；新聊天默认关闭。
- 草稿按 `Alt+Enter` 主动请求翻译并预览，确认后发送；过期或失败的译文不会作为有效译文发送。可选择仅发送译文或附带原文。
- 可翻译已启用聊天中新收到的纯文本，也可主动选择当前可见的单条历史纯文本；不自动遍历历史记录或翻译媒体说明。
- 支持 OpenAI、Anthropic、Gemini、DeepSeek、自定义 OpenAI 兼容端点，以及非官方 Google 和 Microsoft 翻译服务。服务可变更、限流或收费；自备所需密钥。
- 接收译文可存入扩展本地存储，或存入用户选择的目录，并在满足条件时恢复。容量、权限、清理、卸载和文件删除可能导致记录不可用或丢失；目录模式的实际环境兼容性需要自行验证。

## 安装与使用

### 下载并安装

从 [Releases](https://github.com/hx123321/wa-web-translate/releases) 下载插件 ZIP 并解压。在支持 Manifest V3 的 Chrome 中打开 `chrome://extensions`，开启开发者模式，点击“加载已解压的扩展程序”，选择解压后包含 `manifest.json` 的目录。

### 从源码构建

需要 Node.js 20+、pnpm 和支持 Manifest V3 的 Chrome。克隆本仓库后运行：

```bash
pnpm install
pnpm build
```

在 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”并选中 `dist/`。打开扩展选项配置服务、模型和必要的 API 密钥；在 WhatsApp Web 聊天中使用浮动“收发翻译”面板配置方向和语言。发送前请检查预览内容。

## 兼容性

用户曾于 **2026-11-11** 测试该项目，但没有可核实的 WhatsApp Web 精确版本及完整实机验收记录；自动化验证主要使用模拟服务、合成消息和回归测试，因此不能保证适用某个当前 Web 版本。扩展依赖 WhatsApp Web 的非公开模块和页面结构，网页更新可能使其失效。`0.1.0` 是扩展版本，不是 WhatsApp Web 版本。实际使用前请用非敏感测试内容验证。

## 隐私与安全

本地保存译文**不等于离线翻译**：请求翻译时，所选文本会发送给用户选定的服务及其端点，受该服务的政策约束。预览、自动接收翻译和手动历史消息翻译均可能产生请求；大模型重试可能产生额外费用。自定义端点需要明确批准。非官方免密服务可能随时改变或不可用。

API 密钥保存在浏览器本地存储中，未加密；本地译文记录同样未加密，包含译文及身份元数据，不包含原文或密钥。拥有浏览器配置或所选目录访问权限的人可能读取这些数据。页面脚本之间的桥接不是可信隔离边界；被攻陷的页面可能滥用翻译额度。请勿翻译不愿交给所选服务处理的内容。

## 开发与验证

```bash
pnpm test
pnpm build
```

测试以模拟和合成数据为主，不能代替真实浏览器、供应商和 WhatsApp Web 版本的集成验收。

## English

An unofficial Chinese-localized fork of [WA Web Translate](https://github.com/purpshell/wa-web-translate), adding translation controls and local translation storage. Translation still sends selected text to the configured provider. This project is not affiliated with or endorsed by WhatsApp or Meta, and cannot guarantee against account bans.

## 许可证

[MIT](LICENSE)，保留原作者版权声明。
