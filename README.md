# DSH AgentRouter Connect (`dsh-agentrouter-connect`)

让 [AgentRouter](https://agentrouter.org) 聚合模型接入 **DeepSeek Harness (DSH)**。

设置页走宿主**原生表单**（`configForms` + `settings` 命名空间），密钥归凭据域所有，
插件自身不暴露任何可写配置的 HTTP 接口。

---

## ✨ 核心特性

- 🚫 **零本地端口**：不启回环 HTTP 服务、不 spawn 子进程；出站请求由进程内的原生 LlmAdapter 直发，User-Agent / 代理 / 重试全部自主可控。
- 🧩 **原生设置卡片**：注册进「插件」页的三个配置插槽（`plugins.bundle.config` /
  `plugins.row.config` / `plugins.item`），与 DSH 自带插件同一套表单原语
  （`SettingsForm` / `SettingsValueField` / `SettingsSecretField` / `Switch` /
  `SegmentedControl`），保存即写入 profile 补丁。
- ⚡ **分层生效**：代理、端点、模型列表、协议择优、重试策略都声明为 `.volatile()`，
  设置写入原地更新引用单元而不重载 fiber —— **改完下一次请求即生效**。
- 🔐 **密钥不进设置文件**：设置段只保存**凭据引用名**（`apiKeyEnv`，默认
  `AGENTROUTER_API_KEY`），密钥本体存在 `~/.dsh/.credentials.yaml` 或同名环境变量里，
  只允许写入、不随任何响应回传。
- 🛡️ **专治 DNS 污染与 WAF 拦截**：基于 `undici` 的 `ProxyAgent` 隧道转发；
  国内源站 `ps.air-outer.com` **自动直连**以绕开 WAF 对代理出口 IP 的质询
  （`directEndpoints` 可切换 `auto` / `always` / `none`）。
- 🔑 **客户端指纹**：自动携带 `pi (平台 版本; 架构)` —— 中转站按 User-Agent 放行客户端，
  没有它（或带 harness 自身的 `deepseek-harness/<版本>`）会被判 `401 unauthorized client`。
- 📦 **模型目录自动同步**：启动时把中转站 `/v1/models` 的真实在售列表写入缓存，
  模型选择器就不会再出现已下线的条目（可用 `autoRefreshModels` 关闭）。
  你在设置里填了模型列表就以你的为准 —— 缓存只是兜底，不会覆盖你的输入。
- ♻️ **上游抖动自愈**：对渠道方言 400 与 5xx 自动重发（次数可配、可整体关闭）；
  客户端点「停止生成」时同步中止上游请求。
- 🧮 **协议择优**：`anthropic-first`（默认）优先走 `/v1/messages`，thinking 块连同
  signature 原样往返；`openai-first` 全部走 `/v1/chat/completions`。

---

## 🛠️ 构建与部署

```bash
cd dsh-agentrouter-connect
pnpm install
pnpm run check    # tsc --noEmit
pnpm test         # node --test test/*.test.mjs（24 项，全部离线）
npx tsdown        # 产出 lib/index.js（Host）与 lib/client.js（Web 模块）
```

> 插件经 junction 部署到 `~/.dsh/profiles/<profile>/node_modules/dsh-agentrouter-connect`，
> 重新构建后需**完全重启 DSH** 才会加载新的 `lib/`。

---

## ⚙️ 配置

插件由 Cordis 在启动时加载（见 `cordis.patch.yml`）。设置页在
**「插件」→ AgentRouter 聚合代理**，也可从 bundle 卡片的详情页进入。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `apiKeyEnv` | 引用名 | `AGENTROUTER_API_KEY` | 密钥的解析来源（环境变量或 `.credentials.yaml` 的 `refs` 段） |
| `proxy` | 文本 | `http://127.0.0.1:7897` | 上游代理；`direct` 表示直连。**不支持 SOCKS**，保存时会校验 |
| `endpoint` | 文本 | `https://ps.air-outer.com/v1` | 中转站端点（国内源站直连可达） |
| `userAgent` | 文本 | 空 → `pi (平台 版本; 架构)` | 客户端标识；留空即官方支持的取值 |
| `customModels` | 文本（一行一个） | 空 → 中转站实测缓存 → 内置种子表 | 模型 id 列表 |
| `directEndpoints` | 三选一 | `auto` | `auto` 国内直连其余走代理 / `always` 全部直连 / `none` 全部走代理 |
| `protocolPreference` | 二选一 | `anthropic-first` | 协议择优策略 |
| `autoRefreshModels` | 开关 | 开 | 启动时用 `/v1/models` 刷新模型目录 |
| `silentRetry` | 开关 | 开 | 渠道抖动时由回环服务重发 |
| `silentRetryAttempts` | 数字 1–10 | `3` | 单次请求的最大发送次数（含首次） |
| `quotaHint` | 文本 | 见下 | 402 配额错误后追加的提示；留空关闭 |

> **为什么没有「逐模型协议」下拉框？** schemastery 拒绝「volatile 字段嵌套在 volatile
> 字段内部」，而按模型覆盖表的键是动态的（`z.dict`），因此它无法作为可热改字段暴露。
> 需要逐模型控制时，直接在 `~/.dsh/agentrouter/config.json` 里写
> `{"modelProtocols": {"deepseek-v4-flash": "openai"}}`，插件每次请求都会读取它。

**配置只有一个来源：设置段（profile 补丁）。** `~/.dsh/agentrouter/config.json` 不再是
任何配置项的第二个来源 —— 它只保存**缓存与覆盖**（中转站实测模型列表、同步时间、
逐模型协议覆盖）。这消灭了「设置页显示 A、插件实际用 B」这类问题：页面显示的值与
请求使用的值由同一份解析结果产生。

环境变量只在设置段没有提供该字段时兜底（`AGENTROUTER_PROXY` / `AGENTROUTER_ENDPOINT` /
`AGENTROUTER_API_KEY`）。

---

## 🔌 唯一的 HTTP 接口

设置读写全部走宿主原生通道，插件**不注册任何配置接口**。只保留一个无参数的诊断接口：

```
POST /plugins/agentrouter/test
```

它按当前**已保存**的配置向上游发一次 `GET /v1/models`，返回
`{ ok, status, latencyMs, message }`。之所以需要服务端参与：中转站要求
`User-Agent` 客户端指纹，而浏览器禁止脚本设置该头 —— 由浏览器直接请求必然被判
`401 unauthorized client`。

该接口不接收端点、代理或密钥参数，也不回传密钥，因此不存在把密钥导向任意主机的可能。

---

## 🔐 密钥存放

1. **推荐**：在设置卡片的「API Key」框里填写。它写入凭据域
   （`~/.dsh/.credentials.yaml` 的 `refs` 段），设置文件里只留引用名。
2. 也可以自己写进 `~/.dsh/.credentials.yaml`：
   ```yaml
   version: 1
   refs:
     AGENTROUTER_API_KEY: sk-...
   ```
3. 或设置环境变量 `AGENTROUTER_API_KEY`。

旧版本曾把明文密钥写在 `~/.dsh/agentrouter/config.json`。启动时若检测到该副本，
插件会在**凭据域确实已持有密钥**之后才删除它；否则只打印一条提示，绝不丢钥匙。

---

## 🧪 测试

```bash
node test/plugin.test.mjs     # 或 pnpm test
```

36 项，全部离线（对本地 stub 中转站），覆盖：未鉴权即时拦截、无效代理拦截、零本地回环端口验证、两种协议的出站线格式、`strict` 工具保护、静默重试的四种判定、OpenAI 与 Anthropic SSE 双协议流式增量解析、代理 scheme 校验、volatile 解包、模型目录同步的幂等性、协议择优、原生适配器契约与动态配置、以及「唯一的 HTTP 接口」这一约束。

> 若 `node --test` 因沙箱禁止子进程而报 `spawn EPERM`，直接 `node test/plugin.test.mjs` 即可。

---

## 📁 结构

```
src/index.ts        Host 入口：Config schema、apply()、原生适配器注册、诊断路由
src/config.ts       配置解析与持久化、模型目录同步、旧密钥迁移
src/catalog.ts      种子模型表、协议择优、覆盖套用
src/net.ts          undici 传输、代理校验、连通性探测、UA 指纹
src/schema.ts       出站工具 schema 清洗（两种协议形状、严格模式保护）
src/adapter.ts      原生 AgentRouterLlmAdapter（内存直连、双协议流式、方言重发）
src/client/index.ts 浏览器半边：原生设置卡片
test/               行为测试（36 项，全离线）
```
