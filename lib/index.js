import z from "@deepseek-ai/schemastery";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arch, homedir, platform, release } from "node:os";
import { EnvHttpProxyAgent, ProxyAgent, fetch, request } from "undici";
import { LlmAdapter, LlmError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
//#region src/net.ts
/**
* Proxy-aware networking implementation using undici, mirroring dsh-agy-link.
*
* Node's built-in fetch ignores system proxies on Windows GUI apps.
* Using undici's ProxyAgent and EnvHttpProxyAgent ensures all outgoing traffic
* can be directed through clash/mihomo (e.g. http://127.0.0.1:7897), bypassing
* DNS pollution and GFW.
*/
let envAgent;
const perProxyAgents = /* @__PURE__ */ new Map();
/**
* 进程级环境代理，惰性构造。
*
* 构造 `EnvHttpProxyAgent` 会打印 undici 的实验性特性告警，而插件在多数部署里
* 走的是显式 ProxyAgent —— 只有 `proxyUrl` 留空时才需要它，因此推迟到那一刻。
* @returns 环境代理 dispatcher。
*/
function getEnvAgent() {
	envAgent ??= new EnvHttpProxyAgent();
	return envAgent;
}
/**
* 国内源站主机。中转站在国内与国际两个源站提供同一组模型，差别只在 origin。
*
* 关键差异（已实测，见 scratch/probe5-endpoints.mjs）：国内源站**直连可达**，
* 而国际源站直连不通、必须走代理。反过来，走代理访问国内源站会经过数据中心
* 出口 IP —— 正是中转站 WAF 质询的对象，回的是 200 的 HTML 验证页而非 SSE 流。
*/
const CN_HOST = "ps.air-outer.com";
/** 校验来自配置文件/请求体的取值是否合法。 */
function isDirectEndpointsMode(value) {
	return value === "auto" || value === "always" || value === "none";
}
/**
* 校验一个代理地址是否可用。
*
* undici 的 `ProxyAgent` 只接受 `http:` / `https:` —— SOCKS 会在构造时抛
* `Invalid URL protocol`。那是一个来自依赖库深处的英文异常，用户看到它无从判断
* 该改什么，所以在**保存时**就拦住并给出可执行的建议（与 DSH 自身
* `dsh-http-proxy` 对 SOCKS 的处理口径一致）。
* @param raw - 用户填写的代理地址；空串与 `direct` 均表示直连。
* @returns 校验结果。
*/
function validateProxyUrl(raw) {
	const value = raw.trim();
	if (value === "" || value.toLowerCase() === "direct") return { ok: true };
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		return {
			ok: false,
			message: `代理地址 "${value}" 不是合法 URL；请填写形如 http://127.0.0.1:7897 的地址，或填 direct 表示直连。`
		};
	}
	if (parsed.protocol === "http:" || parsed.protocol === "https:") return { ok: true };
	if (/^socks/i.test(parsed.protocol)) return {
		ok: false,
		message: `代理地址 "${value}" 使用的是 ${parsed.protocol}// 协议，本插件不支持 SOCKS 代理；请改用 Clash/Mihomo 的 HTTP 端口（例如 http://127.0.0.1:7897），或在代理软件里开启 HTTP 混合端口。`
	};
	return {
		ok: false,
		message: `代理地址 "${value}" 使用了不支持的 ${parsed.protocol}// 协议；请填写 http:// 或 https:// 开头的地址。`
	};
}
/**
* 判断某个端点是否应绕过进程代理直连。
* @param endpoint - 上游 API 端点。
* @param mode - 传输方式，默认 `auto`（仅国内源站直连）。
*/
function shouldBypassProxy(endpoint, mode = "auto") {
	if (mode === "none") return false;
	if (mode === "always") return true;
	try {
		const host = new URL(endpoint).hostname.toLowerCase();
		return host === CN_HOST || host.endsWith(`.${CN_HOST}`);
	} catch {
		return false;
	}
}
/**
* 为一个端点挑选 dispatcher。
*
* 默认在国内源站上绕过代理直连，因为它的 WAF 会质询代理出口 IP（回 200 的 HTML
* 验证页而非 SSE 流）。注意：此时你配置的代理对国内端点**不生效**——卡片会明确
* 标注实际传输方式。若该直连在你的网络下不可用，把 `directEndpoints` 设为 `none`
* 即可让国内端点改走代理。
* @param endpoint - 上游 API 端点。
* @param proxyUrl - 用户配置的代理地址。
* @param mode - 传输方式。
* @returns 该端点应使用的 dispatcher；undefined 表示直连。
* @throws 代理地址不受支持时抛出带修正建议的错误。
*/
function getDispatcherForEndpoint(endpoint, proxyUrl, mode = "auto") {
	if (shouldBypassProxy(endpoint, mode)) return void 0;
	return getDispatcher(proxyUrl);
}
function getDispatcher(proxyUrl) {
	if (!proxyUrl || !proxyUrl.trim()) return getEnvAgent();
	const clean = proxyUrl.trim();
	if (clean.toLowerCase() === "direct") return;
	const validation = validateProxyUrl(clean);
	if (!validation.ok) throw new Error(validation.message);
	let agent = perProxyAgents.get(clean);
	if (!agent) {
		agent = new ProxyAgent(clean);
		perProxyAgents.set(clean, agent);
	}
	return agent;
}
/**
* AgentRouter gates its gateway on a recognized-client User-Agent: an unlisted
* client gets `401 Invalid API Key!` even when the key is valid, and clients it
* classifies as unsupported are billed in the double-rate `probation` group.
*
* `pi` is the officially supported client identity that `@earendil-works/pi-ai`
* sends natively, so we reproduce its exact shape. AgentRouter matches the
* `pi (<platform> <release>; <arch>)` prefix, which means OS upgrades keep
* working without hard-coding a version that would eventually rot.
*
* Verified 2026-10-10 against `ps.air-outer.com/v1/models`: no User-Agent (or
* the harness attribution `deepseek-harness/<version>`) answers
* `401 unauthorized_client_error`, while this value, `claude-cli/2.1.161` and
* `RooCode/3.54.0` all answer 200.
*/
function getAgentRouterUserAgent() {
	return `pi (${platform()} ${release()}; ${arch()})`;
}
function buildAgentRouterHeaders(apiKey, userAgent) {
	return {
		"Authorization": `Bearer ${apiKey}`,
		"User-Agent": userAgent?.trim() || getAgentRouterUserAgent()
	};
}
async function agentRouterFetch(url, init = {}, proxyUrl, directMode = "auto") {
	const dispatcher = getDispatcherForEndpoint(url, proxyUrl, directMode);
	return fetch(url, {
		...init,
		...dispatcher ? { dispatcher } : {}
	});
}
/**
* 读取中转站当前在售的模型 id 列表。
*
* 中转站的模型目录随上游资源动态变化，内置种子表只能近似；设置卡片用这个
* 调用把「实际在售」同步进配置，避免把已下线的模型留在模型选择器里。
* @param options - 端点、密钥、传输方式与超时。
* @returns 去重后的模型 id 列表。
* @throws 网络失败、鉴权失败或响应不是模型列表时抛出带原因的错误。
*/
async function fetchRelayModels(options) {
	const { endpoint, apiKey, proxyUrl, userAgent, directMode = "auto", timeoutMs = 15e3 } = options;
	const url = `${endpoint.replace(/\/+$/, "")}/models`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await agentRouterFetch(url, {
			method: "GET",
			headers: {
				...buildAgentRouterHeaders(apiKey, userAgent),
				"Accept": "application/json"
			},
			signal: controller.signal
		}, proxyUrl, directMode);
		const text = await res.text();
		if (!res.ok) throw new Error(`读取模型列表失败 (HTTP ${res.status}): ${text.slice(0, 200)}`);
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed?.data)) throw new Error("模型列表响应缺少 data 数组（可能被 WAF 拦截返回了 HTML）。");
		const ids = parsed.data.map((entry) => entry && typeof entry === "object" ? entry.id : void 0).filter((id) => typeof id === "string" && id.trim().length > 0).map((id) => id.trim());
		return [...new Set(ids)];
	} finally {
		clearTimeout(timer);
	}
}
async function testConnection(options) {
	const { endpoint, apiKey, proxyUrl, userAgent, directMode = "auto" } = options;
	const start = Date.now();
	try {
		const res = await agentRouterFetch(`${endpoint.replace(/\/+$/, "")}/models`, {
			method: "GET",
			headers: {
				...buildAgentRouterHeaders(apiKey, userAgent),
				"Accept": "application/json"
			}
		}, proxyUrl, directMode);
		const latencyMs = Date.now() - start;
		const text = await res.text();
		const contentType = res.headers.get("content-type") || "";
		const usedDirect = shouldBypassProxy(endpoint, directMode);
		const transport = usedDirect ? "直连" : `代理 ${proxyUrl || "(未配置)"}`;
		if (contentType.includes("text/html") || text.includes("aliyun_waf") || text.includes("CF_APP_WAF") || text.includes("<!doctype html") || text.includes("<html")) return {
			ok: false,
			status: res.status,
			latencyMs,
			message: usedDirect ? `触发上游阿里云 WAF 验证码拦截（返回了 HTML 网页而不是 API 数据）。当前为直连（${transport}），通常是出口 IP 被风控，请稍后重试。` : `触发上游阿里云 WAF 验证码拦截（返回了 HTML 网页而不是 API 数据）。当前走${transport} —— 中转站 WAF 会质询代理出口 IP，这正是最可能的原因：改用国内端点 https://ps.air-outer.com/v1（会自动直连）通常即可解决。`
		};
		if (res.ok) try {
			const parsed = JSON.parse(text);
			const count = Array.isArray(parsed?.data) ? parsed.data.length : void 0;
			return {
				ok: true,
				status: res.status,
				latencyMs,
				message: `连接成功！响应耗时 ${latencyMs}ms，${transport} 与 API Key 正常${count !== void 0 ? `（已获取到 ${count} 个模型）` : ""}。`
			};
		} catch {
			return {
				ok: false,
				status: res.status,
				latencyMs,
				message: `接口返回非 JSON 格式内容，请确认端点地址是否正确（推荐国内源站 https://ps.air-outer.com/v1）。`
			};
		}
		if (res.status === 401) return {
			ok: false,
			status: 401,
			latencyMs,
			message: `HTTP 401: 密钥无效或被判定为未授权客户端！网络与端点连接通畅 (${latencyMs}ms，${transport})，但 AgentRouter 上游拒绝了该请求。请登录控制台 https://ps.air-outer.com/console/personal 重新获取有效 Token；若 Token 确认有效，则是客户端标识被拒，请在插件设置里检查 User-Agent 配置。`
		};
		let msg = `HTTP ${res.status}`;
		try {
			const parsed = JSON.parse(text);
			if (parsed.msg) msg += `: ${parsed.msg}`;
			else if (parsed.error?.message) msg += `: ${parsed.error.message}`;
			else if (parsed.message) msg += `: ${parsed.message}`;
		} catch {
			msg += `: ${text.slice(0, 100)}`;
		}
		return {
			ok: false,
			status: res.status,
			latencyMs,
			message: msg
		};
	} catch (err) {
		return {
			ok: false,
			status: 0,
			latencyMs: Date.now() - start,
			message: `网络连接失败 (${err?.message || String(err)})。请检查本地代理软件（如 Clash 7897 端口）是否正在运行，以及代理地址是否受支持。`
		};
	}
}
//#endregion
//#region src/config.ts
/**
* Configuration resolution for AgentRouter Connect.
*
* **One source per thing** — this is the invariant the earlier "config.json also
* holds settings" design violated:
*
*  - **User-facing settings** (proxy, endpoint, UA, model list, transport,
*    protocol preference, retry policy, quota hint, credential ref) come from
*    the plugin's own Config section in the profile patch, surfaced and edited
*    by the native settings page. `resolveConfig()` reads them from the entry
*    config passed by the host; it never reads them from `config.json`.
*  - **The API key** lives in the credential store (`~/.dsh/.credentials.yaml`
*    under `refs.<apiKeyEnv>`, or the same-named environment variable). It never
*    enters the settings document or this plugin's JSON state file.
*  - **`~/.dsh/agentrouter/config.json`** is a *state/cache* file only: the
*    relay-verified model list (`relayModels`), the last sync time, and the
*    advanced per-model `modelProtocols` override (hand-edited; it cannot be a
*    volatile settings field — see index.ts).
*
* The loopback shim re-reads the resolved config on every request, so a settings
* save takes effect on the next call without a restart.
*/
/** 402 配额错误的默认提示文案。 */
const DEFAULT_QUOTA_HINT = "该模型的预算池本批额度已用完，请等待下一批投放，或改用其他模型。";
/** 凭据引用的默认名字（与设置卡片、.credentials.yaml 的 refs 段一致）。 */
const DEFAULT_API_KEY_REF = "AGENTROUTER_API_KEY";
/** 默认端点：国内源站，实测直连可达。 */
const DEFAULT_ENDPOINT = "https://ps.air-outer.com/v1";
/**
* 已知不可用的端点主机。
*
* `co.agentrouter.org` 曾被误当作国际源站写进 profile 补丁；实测它会触发阿里云
* WAF 并拒绝密钥。配置里若仍留着这个值（旧补丁、旧文档、手工编辑），解析时自动
* 回落到默认端点并在日志里说明 —— 否则插件会安静地用一个必然失败的地址，
* 而用户看到的只是「请求失败」。
*/
const LEGACY_ENDPOINT_HOSTS = ["co.agentrouter.org"];
function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
function stateDir() {
	return join(dshHome(), "agentrouter");
}
function configFile() {
	return join(stateDir(), "config.json");
}
/**
* 带 mtime 缓存的 JSON 读取。
*
* shim 会在每次 chat completion 时调用 resolveConfig()，同步读盘 + 解析
* 会给每个请求增加不必要的开销；文件未变化时直接复用上次解析结果。
* @param file - 目标文件路径。
* @returns 解析后的对象；不存在、损坏或读取失败时返回空对象。
*/
function readJsonFile(file) {
	try {
		if (!existsSync(file)) return {};
		const stat = statSync(file);
		if (cachedFile === file && cachedMtimeMs === stat.mtimeMs) return cachedData;
		const content = readFileSync(file, "utf8");
		const parsed = JSON.parse(content);
		const data = parsed && typeof parsed === "object" ? parsed : {};
		cachedFile = file;
		cachedMtimeMs = stat.mtimeMs;
		cachedData = data;
		return data;
	} catch {
		return {};
	}
}
let cachedFile = "";
let cachedMtimeMs = -1;
let cachedData = {};
/** 合法的协议取值。 */
function isAgentRouterProtocol(value) {
	return value === "openai" || value === "anthropic";
}
/** 合法的协议择优策略。 */
function isProtocolPreference(value) {
	return value === "anthropic-first" || value === "openai-first";
}
/**
* 共享的 volatile 引用协议（与 cosmokit 的 isVolatile 同一枚符号）。
*
* 声明为 .volatile() 的 Config 字段以**引用单元**形态到达插件：设置写入原地
* 更新单元而不重载 fiber，因此每次读取都必须解包取当前值。用 Symbol.for 而不是
* 直接依赖 cosmokit —— 插件不把 cosmokit 列为依赖，跨 ESM/CJS 副本也要认得出。
*/
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");
/** 该值是否为 volatile 引用单元。 */
function isVolatileCell(value) {
	return typeof value === "object" && value !== null && VOLATILE_WRITE in value;
}
/** 解包 volatile 单元；普通值原样返回。 */
function unwrap(value) {
	if (isVolatileCell(value)) return value.get();
	return value;
}
/**
* 从环境变量或 `$DSH_HOME/.credentials.yaml` 的 refs 段解析密钥。
* @param ref - 凭据引用名。
* @returns 密钥；两处都没有时返回空串。
*/
function credentialApiKey(ref = DEFAULT_API_KEY_REF) {
	return resolveCredentialApiKey(ref);
}
function resolveCredentialApiKey(ref) {
	const fromEnv = process.env[ref];
	if (fromEnv && fromEnv.trim()) return fromEnv.trim();
	try {
		const credPath = join(dshHome(), ".credentials.yaml");
		if (existsSync(credPath)) {
			const content = readFileSync(credPath, "utf8");
			const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const match = new RegExp("^[ \\t]+" + escaped + ":[ \\t]*(.*)$", "m").exec(content);
			if (match && match[1]) {
				const value = match[1].trim().replace(/^["']|["']$/g, "");
				if (value) return value;
			}
		}
	} catch {}
	return "";
}
function normalizeModelProtocols(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
	const out = {};
	for (const [k, v] of Object.entries(raw)) if (typeof k === "string" && k.trim() && isAgentRouterProtocol(v)) out[k.trim().toLowerCase()] = v;
	return Object.keys(out).length > 0 ? out : void 0;
}
function resolveConfig(entryConfig) {
	const fileData = readJsonFile(configFile());
	const env = process.env;
	const defaultProxy = "http://127.0.0.1:7897";
	const defaultEndpoint = DEFAULT_ENDPOINT;
	const defaultUserAgent = "";
	const entryApiKeyEnv = unwrap(entryConfig?.apiKeyEnv)?.trim();
	const entryProxy = unwrap(entryConfig?.proxyUrl)?.trim();
	const entryApiKey = unwrap(entryConfig?.apiKey)?.trim();
	const entryEndpoint = unwrap(entryConfig?.endpoint)?.trim();
	const entryUserAgent = unwrap(entryConfig?.userAgent)?.trim();
	const entryCustomModels = unwrap(entryConfig?.customModels);
	const entryDirectEndpoints = unwrap(entryConfig?.directEndpoints);
	const entryProtocolPreference = unwrap(entryConfig?.protocolPreference);
	const entryModelProtocols = unwrap(entryConfig?.modelProtocols);
	const entrySilentRetry = unwrap(entryConfig?.silentRetry);
	const entrySilentRetryAttempts = unwrap(entryConfig?.silentRetryAttempts);
	const entryQuotaHint = unwrap(entryConfig?.quotaHint);
	const entryAutoRefreshModels = unwrap(entryConfig?.autoRefreshModels);
	const proxyUrl = entryProxy || env.AGENTROUTER_PROXY || env.ALL_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY || defaultProxy;
	const apiKeyEnv = entryApiKeyEnv || "AGENTROUTER_API_KEY";
	const apiKey = entryApiKey || resolveCredentialApiKey(apiKeyEnv) || (typeof fileData.apiKey === "string" ? fileData.apiKey.trim() : "");
	const requestedEndpoint = entryEndpoint || env.AGENTROUTER_ENDPOINT || defaultEndpoint;
	let correctedEndpoint;
	let endpoint = requestedEndpoint;
	try {
		const host = new URL(requestedEndpoint).hostname.toLowerCase();
		if (LEGACY_ENDPOINT_HOSTS.includes(host)) {
			correctedEndpoint = requestedEndpoint;
			endpoint = defaultEndpoint;
		}
	} catch {}
	const userAgent = entryUserAgent || defaultUserAgent;
	const customModels = Array.isArray(entryCustomModels) ? entryCustomModels.filter((x) => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : void 0;
	const relayModels = Array.isArray(fileData.relayModels) ? fileData.relayModels.filter((x) => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : void 0;
	const directEndpoints = isDirectEndpointsMode(entryDirectEndpoints) ? entryDirectEndpoints : "auto";
	const protocolPreference = isProtocolPreference(entryProtocolPreference) ? entryProtocolPreference : "anthropic-first";
	const modelProtocols = normalizeModelProtocols(fileData.modelProtocols ?? entryModelProtocols);
	const silentRetry = typeof entrySilentRetry === "boolean" ? entrySilentRetry : true;
	const rawAttempts = entrySilentRetryAttempts;
	const silentRetryAttempts = Number.isFinite(rawAttempts) ? Math.min(10, Math.max(1, Math.round(rawAttempts))) : 3;
	const quotaHint = typeof entryQuotaHint === "string" ? entryQuotaHint : DEFAULT_QUOTA_HINT;
	const autoRefreshModels = typeof entryAutoRefreshModels === "boolean" ? entryAutoRefreshModels : true;
	const modelCatalogSyncedAt = typeof fileData.modelCatalogSyncedAt === "string" ? fileData.modelCatalogSyncedAt : "";
	return {
		apiKeyEnv,
		proxyUrl,
		apiKey,
		endpoint: endpoint.replace(/\/+$/, ""),
		userAgent,
		customModels,
		relayModels,
		directEndpoints,
		protocolPreference,
		modelProtocols,
		silentRetry,
		silentRetryAttempts,
		quotaHint,
		autoRefreshModels,
		modelCatalogSyncedAt,
		correctedEndpoint
	};
}
/**
* 写入插件状态文件。
*
* 这里只存**缓存与不属于设置段的运行时状态**（中转站实测模型列表、同步时间、
* 逐模型协议覆盖）。代理、端点、重试策略等配置项归 profile 补丁所有，写在这里
* 也不会被读取 —— 单一来源是这次重构的核心约束。
*
* apiKey 不属于这里（见文件头注释），传进来会被忽略。
* @param updates - 需要合并进 config.json 的字段。
* @returns 合并后的完整配置。
*/
function saveConfig(updates) {
	try {
		mkdirSync(stateDir(), { recursive: true });
	} catch {}
	const current = readJsonFile(configFile());
	const { apiKey: _ignoredApiKey, ...persistable } = updates;
	const merged = {
		...current,
		...persistable
	};
	const file = configFile();
	writeFileSync(file, JSON.stringify(merged, null, 2), {
		encoding: "utf8",
		mode: 384
	});
	try {
		chmodSync(file, 384);
	} catch {}
	return resolveConfig();
}
/**
* 旧版把 API Key 明文写在 config.json 里；现在它归设置卡片的 secret 字段所有。
*
* 只在**新归属处已经持有密钥**时才删除本地副本，避免任何情况下丢钥匙；
* 尚未迁移时保留原值并提示一次。
* @param superseded - 设置卡片是否已提供密钥。
* @returns 被移除的旧密钥；没有则返回空串。
*/
function dropLegacyApiKeyIfSuperseded(superseded) {
	const current = readJsonFile(configFile());
	const legacy = typeof current.apiKey === "string" ? current.apiKey.trim() : "";
	if (!legacy || !superseded) return "";
	const { apiKey: _removed, ...rest } = current;
	try {
		const file = configFile();
		writeFileSync(file, JSON.stringify(rest, null, 2), {
			encoding: "utf8",
			mode: 384
		});
		try {
			chmodSync(file, 384);
		} catch {}
		cachedFile = "";
		cachedMtimeMs = -1;
	} catch {}
	return legacy;
}
/** 旧版 config.json 里是否还留着明文密钥（尚未迁移）。 */
function hasLegacyApiKey() {
	const current = readJsonFile(configFile());
	return typeof current.apiKey === "string" && current.apiKey.trim().length > 0;
}
/**
* 用中转站 `/v1/models` 的真实在售列表刷新本地模型目录。
*
* 中转站的模型随上游资源上下线，内置种子表只能近似；把实测列表写进
* `customModels`，模型选择器里就不会再出现已经下线的条目。
* @param cfg - 已解析的配置。
* @param logger - 用于报告失败的日志接口。
* @returns 同步后的模型 id 列表；失败时返回 undefined（调用方保留原配置）。
*/
async function syncModelCatalog(cfg, logger) {
	if (!cfg.apiKey) return void 0;
	try {
		const ids = await fetchRelayModels({
			endpoint: cfg.endpoint,
			apiKey: cfg.apiKey,
			proxyUrl: cfg.proxyUrl,
			userAgent: cfg.userAgent,
			directMode: cfg.directEndpoints
		});
		if (ids.length === 0) return void 0;
		const cached = cfg.relayModels ?? [];
		if (cached.length === ids.length && ids.every((id) => cached.includes(id))) return ids;
		saveConfig({
			relayModels: ids,
			modelCatalogSyncedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		logger?.info?.("AgentRouter 模型目录已同步：" + ids.join(", ") + (cfg.customModels?.length ? "（设置里已指定模型列表，该缓存仅作参考）" : ""));
		return ids;
	} catch (err) {
		logger?.warn?.("AgentRouter 模型目录同步失败（保留现有列表）: " + (err?.message || String(err)));
		return;
	}
}
/**
* 当前实际生效的模型 id 列表。
*
* 优先级：设置段填写的列表 > 中转站实测缓存 > 内置种子表。
* 设置卡片与适配器共用它，因此「页面显示的模型」与「请求可用的模型」必然一致。
* @param cfg - 已解析配置。
* @returns 模型 id 列表；用户与缓存都没提供时返回空数组（由调用方回落到种子表）。
*/
function effectiveModelIds(cfg) {
	if (cfg.customModels && cfg.customModels.length > 0) return cfg.customModels;
	if (cfg.relayModels && cfg.relayModels.length > 0) return cfg.relayModels;
}
//#endregion
//#region src/catalog.ts
/**
* 内置种子模型表 —— **与中转站实测在售列表保持同步**。
*
* 上下文窗口 / 最大输出取自中转站返回值约束与实测；`protocols` 取自控制台
* 「可用端点类型」标注。模型上下线由上游资源决定，请以设置卡片里的
* 「刷新模型列表」或控制台为准。
*/
const AGENTROUTER_DEFAULT_MODELS = [
	{
		id: "claude-opus-5",
		name: "claude-opus-5",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: false,
		protocols: ["anthropic", "openai"],
		reasoning: {
			supports: true,
			canDisableThinking: true,
			supportedEfforts: [
				"low",
				"medium",
				"high"
			]
		}
	},
	{
		id: "claude-opus-4-8",
		name: "claude-opus-4-8",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: false,
		protocols: ["anthropic", "openai"],
		reasoning: {
			supports: true,
			canDisableThinking: true,
			supportedEfforts: [
				"low",
				"medium",
				"high"
			]
		}
	},
	{
		id: "deepseek-v4-flash",
		name: "deepseek-v4-flash",
		contextWindow: 1e6,
		maxTokens: 256e3,
		supportsImages: false,
		protocols: ["anthropic", "openai"],
		thinkingFormat: "deepseek",
		reasoning: {
			supports: true,
			canDisableThinking: true,
			supportedEfforts: [
				"low",
				"medium",
				"high"
			]
		}
	},
	{
		id: "gpt-6-astra",
		name: "gpt-6-astra",
		contextWindow: 272e3,
		maxTokens: 128e3,
		supportsImages: false,
		protocols: ["openai"],
		reasoning: {
			supports: true,
			canDisableThinking: true,
			supportedEfforts: [
				"low",
				"medium",
				"high"
			]
		}
	}
];
/**
* 在售模型的最小识别信息：非种子模型按 id 归类时的兜底参数。
* 上下文窗口与最大输出取保守值，宁可截断也不要让上游拒绝整个请求。
*/
const FALLBACK_MAX_TOKENS = 16384;
/**
* 从 id 推断该模型是否具备思考能力，以及它的上下文窗口。
*
* 只用于**种子表里没有**的 id（例如中转站新上线的模型）。命中不了就按
* 无思考 + 保守窗口处理，用户可以在卡片里手工确认协议。
* @param idLower - 已小写的模型 id。
* @returns 推断出的能力描述。
*/
function inferModelTraits(idLower) {
	const isReasoning = idLower.includes("reason") || idLower.includes("r1") || idLower.includes("o1") || idLower.includes("o3") || idLower.includes("v4") || idLower.includes("qwq") || idLower.includes("thinking") || idLower.includes("opus") || idLower.includes("astra");
	const isDeepSeekFamily = idLower.includes("deepseek");
	return {
		contextWindow: idLower.includes("gemini") || idLower.includes("1m") ? 1e6 : idLower.includes("opus") || idLower.includes("deepseek") || idLower.includes("gpt-6") ? 1e6 : idLower.includes("gpt-5") ? 272e3 : 2e5,
		maxTokens: FALLBACK_MAX_TOKENS,
		...isReasoning ? { reasoning: {
			supports: true,
			canDisableThinking: !idLower.includes("r1"),
			supportedEfforts: [
				"low",
				"medium",
				"high"
			]
		} } : {},
		...isDeepSeekFamily ? { thinkingFormat: "deepseek" } : {},
		protocols: ["openai"]
	};
}
/**
* 把一份 id 列表解析成完整的模型信息表。
*
* 种子表里有的 id 直接复用其（实测校订过的）参数；其余按 id 推断。
* @param customModelIds - 用户配置或中转站返回的模型 id 列表。
* @returns 去重后的模型信息表。
*/
function resolveActiveModels(customModelIds) {
	if (!customModelIds || customModelIds.length === 0) return [...AGENTROUTER_DEFAULT_MODELS];
	const modelMap = /* @__PURE__ */ new Map();
	for (const m of AGENTROUTER_DEFAULT_MODELS) modelMap.set(m.id.toLowerCase(), m);
	const seen = /* @__PURE__ */ new Set();
	const results = [];
	for (const rawId of customModelIds) {
		const id = rawId.trim();
		if (!id || seen.has(id.toLowerCase())) continue;
		seen.add(id.toLowerCase());
		const existing = modelMap.get(id.toLowerCase());
		if (existing) {
			results.push({
				...existing,
				id
			});
			continue;
		}
		results.push({
			id,
			name: id,
			supportsImages: false,
			...inferModelTraits(id.toLowerCase())
		});
	}
	return results.length > 0 ? results : [...AGENTROUTER_DEFAULT_MODELS];
}
/**
* 为未知模型 ID 生成推断兜底信息。
* @param id - 模型 ID。
* @returns 兜底模型信息。
*/
function fallbackModel(id) {
	return resolveActiveModels([id])[0];
}
/**
* 决定一个模型实际使用哪个协议端点。
*
* 优先级：
*  1. 用户显式指定的 `preferredProtocol`（且该模型确实支持）；
*  2. 按 `preference` 在模型声明的 `protocols` 中择优（默认 Anthropic 优先，
*     因为 thinking 块带 signature 可原样回传）；
*  3. 兜底 openai。
*
* 注意：只支持 openai 的模型（如 gpt-6-astra）无论如何都返回 openai。
* @param info - 模型信息。
* @param preference - 择优策略；默认 anthropic-first。
* @returns 实际应使用的协议。
*/
function resolveModelProtocol(info, preference = "anthropic-first") {
	const available = info.protocols ?? ["openai"];
	if (info.preferredProtocol && available.includes(info.preferredProtocol)) return info.preferredProtocol;
	const ranked = preference === "openai-first" ? ["openai", "anthropic"] : ["anthropic", "openai"];
	for (const protocol of ranked) if (available.includes(protocol)) return protocol;
	return "openai";
}
/**
* 把用户保存的按模型协议覆盖套用到模型表上。
*
* 这是 adapter 与状态接口**共用**的唯一实现：两边必须看到同一份结果，
* 否则设置卡片会显示一个与真实请求不符的「自动」值。
* @param list - 待套用的模型表。
* @param overrides - 形如 `{ "deepseek-v4-flash": "openai" }` 的覆盖表（键已小写）。
* @returns 套用覆盖后的新模型表；未命中的模型原样保留。
*/
function applyProtocolOverrides(list, overrides) {
	if (!overrides) return list;
	return list.map((m) => {
		const want = overrides[m.id.toLowerCase()];
		if (!want) return m;
		return (m.protocols ?? ["openai"]).includes(want) ? {
			...m,
			preferredProtocol: want
		} : m;
	});
}
//#endregion
//#region src/schema.ts
/**
* Outgoing JSON-Schema sanitizer for AgentRouter.
*
* DSH assembles tool definitions whose JSON Schema carries explicit `null`
* placeholders (notably `required: null` on tools with no required arguments,
* such as `get_goal`). OpenAI accepts those silently, but AgentRouter's gateway
* validates strictly and rejects the whole request:
*
*  400 Invalid schema for function 'get_goal': null is not of type "array"
*
* Normalizing the placeholders on the way out keeps the request acceptable
* without changing any tool's real meaning: an empty/missing `required` and an
* absent `additionalProperties` describe the same contract for our purposes.
*
* Two wire shapes have to be covered, because this plugin speaks both protocols:
*
*  - OpenAI `/chat/completions`  → `tools[].function.parameters`
*  - Anthropic `/messages`       → `tools[].input_schema`
*
* pi-ai fills the Anthropic root `required` itself (`required: schema.required ?? []`),
* but it rebuilds only the root node — nested object schemas ride through
* untouched — so the sanitizer still has to walk the tree.
*
* A `strict: true` tool is left alone in both shapes: under strict sampling
* `required` must name every property, so filling an empty array would change
* the tool's contract rather than repair a placeholder.
*/
/** Keys whose value must be an array; a null placeholder collapses to []. */
const ARRAY_KEYS = /* @__PURE__ */ new Set([
	"required",
	"enum",
	"allOf",
	"anyOf",
	"oneOf",
	"prefixItems"
]);
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Recursively normalize one JSON Schema node.
* @param node - the schema (or sub-schema) to clean.
* @returns a sanitized copy; the input is never mutated.
*/
function sanitizeJsonSchema(node) {
	if (Array.isArray(node)) return node.map(sanitizeJsonSchema);
	if (!isPlainObject(node)) return node;
	const out = {};
	for (const [key, raw] of Object.entries(node)) {
		if (raw === null) {
			if (ARRAY_KEYS.has(key)) {
				out[key] = [];
				continue;
			}
			if (key === "items") {
				out[key] = {};
				continue;
			}
			continue;
		}
		if (key === "additionalProperties" && isPlainObject(raw)) {
			out[key] = sanitizeJsonSchema(raw);
			continue;
		}
		out[key] = sanitizeJsonSchema(raw);
	}
	if ((out.type === "object" || Array.isArray(out.type) && out.type.includes("object") || isPlainObject(out.properties)) && !Array.isArray(out.required)) out.required = [];
	return out;
}
/** Whether one tool definition is pinned to strict sampling and must not be rewritten. */
function isStrictTool(tool) {
	return tool.strict === true || isPlainObject(tool.function) && (tool.function.strict === true || isPlainObject(tool.function.parameters) && tool.function.parameters.strict === true) || isPlainObject(tool.input_schema) && tool.input_schema.strict === true;
}
/**
* Normalize every tool definition in an outgoing request body, in whichever
* protocol shape the body uses.
* @param body - the parsed request body about to be forwarded upstream.
* @returns the number of tools whose schema had to be rewritten.
*/
function sanitizeToolSchemas(body) {
	if (!isPlainObject(body) || !Array.isArray(body.tools)) return 0;
	let repaired = 0;
	for (const tool of body.tools) {
		if (!isPlainObject(tool)) continue;
		if (isStrictTool(tool)) continue;
		const fn = tool.function;
		if (isPlainObject(fn) && "parameters" in fn) {
			const before = JSON.stringify(fn.parameters);
			const after = sanitizeJsonSchema(fn.parameters);
			if (JSON.stringify(after) !== before) {
				fn.parameters = after;
				repaired++;
			}
			continue;
		}
		if ("input_schema" in tool) {
			const before = JSON.stringify(tool.input_schema);
			const after = sanitizeJsonSchema(tool.input_schema);
			if (JSON.stringify(after) !== before) {
				tool.input_schema = after;
				repaired++;
			}
		}
	}
	return repaired;
}
//#endregion
//#region src/adapter.ts
/**
* Native AgentRouter LlmAdapter implementation for DeepSeek Harness.
*
* Implements DSH's abstract LlmAdapter directly without any local HTTP server,
* random port, or loopback shim. Outbound requests are sent directly via
* undici with proxy and client-identity header spoofing.
*
* Supports both OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`)
* upstream protocols, selected per model or via the user's protocol preference.
*
* @module dsh-agentrouter-connect/adapter
*/
const AGENTROUTER_PROVIDER = "agentrouter";
/** 5xx 状态码属于上游渠道瞬时错误。 */
const RETRYABLE_STATUS = /* @__PURE__ */ new Set([
	500,
	502,
	503,
	504
]);
/**
* 判定 400 是否为"渠道方言拒绝"（值得重发），而非真正的请求语法错误。
*/
function isTransientConversionError(body) {
	return body.includes("must be passed back to the API") || body.includes("upstream rejected the request as invalid") || body.includes("null is not of type \"array\"") || body.includes("tool_use_id") && body.includes("tool_result");
}
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
async function readBodyText(body) {
	let text = "";
	try {
		for await (const chunk of body) text += chunk.toString("utf8");
	} catch {}
	return text;
}
function formatErrorMessage(status, errBody, quotaHint) {
	let msg = `AgentRouter 上游错误 (HTTP ${status})`;
	try {
		const parsed = JSON.parse(errBody);
		if (parsed.msg) msg += `: ${parsed.msg}`;
		else if (parsed.error?.message) msg += `: ${parsed.error.message}`;
		else if (parsed.message) msg += `: ${parsed.message}`;
		else msg += `: ${errBody.slice(0, 200)}`;
	} catch {
		msg += `: ${errBody.slice(0, 200)}`;
	}
	if (status === 402 && quotaHint) msg += `（${quotaHint}）`;
	return msg;
}
function extractText(msg) {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) return msg.content.filter((b) => b && b.type === "text").map((b) => b.text ?? "").join("");
	return "";
}
function extractReasoning(msg) {
	if (Array.isArray(msg.content)) return msg.content.filter((b) => b && b.type === "reasoning").map((b) => b.text ?? "").join("");
	return "";
}
function extractToolCalls(msg) {
	if (Array.isArray(msg.content)) return msg.content.filter((b) => b && b.type === "tool-call").map((b) => ({
		id: String(b.id ?? ""),
		name: String(b.name ?? ""),
		arguments: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {})
	}));
	return [];
}
function safeParseJson(raw) {
	if (typeof raw === "object" && raw !== null) return raw;
	if (typeof raw === "string") try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) return parsed;
	} catch {
		return {};
	}
	return {};
}
/**
* 生效的模型表：用户自定义列表（或中转站缓存 / 内置种子表）→ 用户按模型的协议覆盖。
*/
function effectiveModels(cfg, models) {
	return applyProtocolOverrides(resolveActiveModels(effectiveModelIds(cfg) ?? models?.map((m) => m.id)), cfg.modelProtocols);
}
/**
* 供设置卡片/诊断使用的模型清单投影。
*/
function describeActiveModels(cfg, models) {
	return effectiveModels(cfg, models).map((m) => ({
		id: m.id,
		available: m.protocols ?? ["openai"],
		active: resolveModelProtocol(m, cfg.protocolPreference),
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens
	}));
}
var AgentRouterLlmAdapter = class extends LlmAdapter {
	resolveConfig;
	logger;
	constructor(options) {
		super();
		this.resolveConfig = options.resolveConfig;
		this.logger = options.logger;
	}
	providerInfo(_provider) {
		return {
			id: AGENTROUTER_PROVIDER,
			name: "AgentRouter"
		};
	}
	providerRetryPolicy(_provider) {
		return resolveRetryPolicy(void 0, "dsh-agentrouter-connect retryPolicy");
	}
	async listModels(_provider) {
		return effectiveModels(this.resolveConfig()).map((m) => ({
			provider: AGENTROUTER_PROVIDER,
			id: m.id,
			name: m.name,
			inputModalities: m.supportsImages ? ["text", "image"] : ["text"]
		}));
	}
	async resolveModel(_provider, model, _signal) {
		const info = effectiveModels(this.resolveConfig()).find((m) => m.id === model) ?? fallbackModel(model);
		const reasoning = info.reasoning?.supports;
		const efforts = reasoning && info.reasoning?.supportedEfforts?.length ? info.reasoning.supportedEfforts : [
			"low",
			"medium",
			"high"
		];
		return {
			provider: AGENTROUTER_PROVIDER,
			id: info.id,
			name: info.name,
			inputModalities: info.supportsImages ? ["text", "image"] : ["text"],
			context: { contextWindow: info.contextWindow },
			defaultMaxTokens: info.maxTokens,
			reasoning: reasoning ? {
				efforts: efforts.map((e) => ({
					id: e,
					name: e
				})),
				defaultEffort: "medium"
			} : void 0
		};
	}
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options)
		};
	}
	async *stream(options) {
		const cfg = this.resolveConfig();
		if (!cfg.apiKey) throw new LlmError("未配置 AgentRouter API Key。请在「设置 → 插件 → AgentRouter」中填写，或在 .credentials.yaml 中配置 AGENTROUTER_API_KEY。", "AUTH", { status: 401 });
		const proxyCheck = validateProxyUrl(cfg.proxyUrl);
		if (!proxyCheck.ok) throw new LlmError(`代理配置不可用：${proxyCheck.message}`, "INVALID_PROXY");
		const modelInfo = effectiveModels(cfg).find((m) => m.id === options.model) ?? fallbackModel(options.model);
		const protocol = resolveModelProtocol(modelInfo, cfg.protocolPreference);
		const dispatcher = getDispatcherForEndpoint(cfg.endpoint, cfg.proxyUrl, cfg.directEndpoints);
		const userAgent = cfg.userAgent?.trim() || getAgentRouterUserAgent();
		let url;
		let headers;
		let payload;
		if (protocol === "anthropic") {
			url = `${cfg.endpoint.replace(/\/+$/, "")}/messages`;
			headers = {
				"x-api-key": cfg.apiKey,
				"anthropic-version": "2023-06-01",
				"User-Agent": userAgent,
				"Content-Type": "application/json",
				"Accept": "text/event-stream"
			};
			payload = this.buildAnthropicPayload(options, modelInfo);
		} else {
			url = `${cfg.endpoint.replace(/\/+$/, "")}/chat/completions`;
			headers = {
				"Authorization": `Bearer ${cfg.apiKey}`,
				"User-Agent": userAgent,
				"Content-Type": "application/json",
				"Accept": "text/event-stream, application/json"
			};
			payload = this.buildOpenAiPayload(options, modelInfo);
		}
		const maxAttempts = cfg.silentRetry ? cfg.silentRetryAttempts : 1;
		let upstreamRes;
		let lastErrorBody = "";
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (options.signal?.aborted) throw new LlmError("Request aborted by caller", "ABORTED");
			try {
				upstreamRes = await request(url, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					dispatcher,
					signal: options.signal
				});
			} catch (err) {
				if (options.signal?.aborted) throw new LlmError("Request aborted by caller", "ABORTED", { cause: err });
				if (attempt < maxAttempts) {
					this.logger?.warn?.(`AgentRouter 网络请求异常，第 ${attempt + 1}/${maxAttempts} 次重发:`, err?.message || String(err));
					await delay(200 * attempt);
					continue;
				}
				throw new LlmError(`连接 AgentRouter 失败: ${err?.message || String(err)}`, "NETWORK_ERROR", { cause: err });
			}
			if (upstreamRes.statusCode === 200) break;
			const bodyText = await readBodyText(upstreamRes.body);
			lastErrorBody = bodyText;
			if ((RETRYABLE_STATUS.has(upstreamRes.statusCode) || upstreamRes.statusCode === 400 && isTransientConversionError(bodyText)) && attempt < maxAttempts) {
				this.logger?.warn?.(`AgentRouter 上游瞬时拒绝 (HTTP ${upstreamRes.statusCode})，第 ${attempt + 1}/${maxAttempts} 次重发:`, bodyText.slice(0, 200));
				await delay(200 * attempt);
				continue;
			}
			const formatted = formatErrorMessage(upstreamRes.statusCode, bodyText, cfg.quotaHint);
			const code = upstreamRes.statusCode === 401 ? "AUTH" : upstreamRes.statusCode === 402 ? "QUOTA" : upstreamRes.statusCode === 429 ? "RATE_LIMIT" : "UPSTREAM_ERROR";
			throw new LlmError(formatted, code, { status: upstreamRes.statusCode });
		}
		if (!upstreamRes || upstreamRes.statusCode !== 200) {
			const formatted = formatErrorMessage(upstreamRes?.statusCode ?? 500, lastErrorBody, cfg.quotaHint);
			throw new LlmError(formatted, "UPSTREAM_ERROR", { status: upstreamRes?.statusCode });
		}
		if (String(upstreamRes.headers["content-type"] ?? "").includes("text/html")) {
			await readBodyText(upstreamRes.body);
			throw new LlmError("AgentRouter 返回了 HTML 网页而不是模型数据流（触发了上游阿里云 WAF 验证码风控）。请尝试在设置里将端点传输方式设为直连或更换端点。", "WAF_BLOCKED", { status: 502 });
		}
		if (protocol === "anthropic") yield* this.streamAnthropic(upstreamRes.body, options.signal);
		else yield* this.streamOpenAi(upstreamRes.body, options.signal);
	}
	buildOpenAiPayload(options, info) {
		const messages = [];
		if (options.system && options.system.trim()) messages.push({
			role: "system",
			content: options.system.trim()
		});
		for (const msg of options.messages) {
			const role = msg.role;
			if (role === "system") {
				const text = extractText(msg);
				if (text) messages.push({
					role: "system",
					content: text
				});
			} else if (role === "developer") {
				const text = extractText(msg);
				if (text) messages.push({
					role: "system",
					content: text
				});
			} else if (role === "user") messages.push({
				role: "user",
				content: extractText(msg)
			});
			else if (role === "assistant") {
				const text = extractText(msg);
				const reasoning = extractReasoning(msg);
				const toolCalls = extractToolCalls(msg);
				const item = {
					role: "assistant",
					content: text || null
				};
				if (toolCalls.length > 0) item.tool_calls = toolCalls.map((tc) => ({
					id: tc.id,
					type: "function",
					function: {
						name: tc.name,
						arguments: tc.arguments
					}
				}));
				if (reasoning && info.thinkingFormat === "deepseek") item.reasoning_content = reasoning;
				messages.push(item);
			} else if (role === "tool") {
				const callId = msg.toolCallId ?? msg.source?.callId ?? "";
				messages.push({
					role: "tool",
					tool_call_id: callId,
					content: extractText(msg)
				});
			}
		}
		const payload = {
			model: info.id,
			messages,
			stream: true,
			stream_options: { include_usage: true }
		};
		if (options.tools && options.tools.length > 0) {
			const tools = options.tools.map((t) => {
				const strict = t.strict ?? t.function?.strict ?? (typeof t.parameters === "object" && t.parameters !== null ? t.parameters.strict : void 0);
				return {
					type: "function",
					function: {
						name: t.name,
						description: t.description,
						parameters: t.parameters ?? {
							type: "object",
							properties: {}
						},
						...strict !== void 0 ? { strict } : {}
					},
					...strict !== void 0 ? { strict } : {}
				};
			});
			sanitizeToolSchemas({ tools });
			payload.tools = tools;
		}
		if (info.reasoning?.supports) {
			const effort = options.reasoningEffort ?? "medium";
			if (effort !== "off" && effort !== "none") payload.reasoning_effort = effort;
		}
		if (options.temperature !== void 0) payload.temperature = options.temperature;
		if (options.maxTokens !== void 0) payload.max_tokens = options.maxTokens;
		if (options.stop && options.stop.length > 0) payload.stop = options.stop;
		return payload;
	}
	buildAnthropicPayload(options, info) {
		const systemParts = [];
		if (options.system && options.system.trim()) systemParts.push(options.system.trim());
		const rawMessages = [];
		for (const msg of options.messages) {
			const role = msg.role;
			if (role === "system" || role === "developer") {
				const text = extractText(msg);
				if (text) systemParts.push(text);
			} else if (role === "user") rawMessages.push({
				role: "user",
				content: [{
					type: "text",
					text: extractText(msg)
				}]
			});
			else if (role === "tool") {
				const callId = msg.toolCallId ?? msg.source?.callId ?? "";
				rawMessages.push({
					role: "user",
					content: [{
						type: "tool_result",
						tool_use_id: callId,
						content: extractText(msg),
						...msg.isError ? { is_error: true } : {}
					}]
				});
			} else if (role === "assistant") {
				const text = extractText(msg);
				const reasoning = extractReasoning(msg);
				const toolCalls = extractToolCalls(msg);
				const blocks = [];
				if (reasoning) blocks.push({
					type: "thinking",
					thinking: reasoning,
					signature: "signature"
				});
				if (text) blocks.push({
					type: "text",
					text
				});
				for (const tc of toolCalls) blocks.push({
					type: "tool_use",
					id: tc.id,
					name: tc.name,
					input: safeParseJson(tc.arguments)
				});
				rawMessages.push({
					role: "assistant",
					content: blocks.length > 0 ? blocks : [{
						type: "text",
						text: ""
					}]
				});
			}
		}
		const messages = [];
		for (const m of rawMessages) if (messages.length > 0 && messages[messages.length - 1].role === m.role) messages[messages.length - 1].content.push(...m.content);
		else messages.push({
			role: m.role,
			content: [...m.content]
		});
		if (messages.length === 0 || messages[0].role !== "user") messages.unshift({
			role: "user",
			content: [{
				type: "text",
				text: "Hello"
			}]
		});
		const payload = {
			model: info.id,
			messages,
			max_tokens: options.maxTokens ?? info.maxTokens ?? 4096,
			stream: true
		};
		if (systemParts.length > 0) payload.system = systemParts.join("\n\n");
		if (options.tools && options.tools.length > 0) {
			const tools = options.tools.map((t) => {
				const strict = t.strict ?? t.input_schema?.strict ?? (typeof t.parameters === "object" && t.parameters !== null ? t.parameters.strict : void 0);
				return {
					name: t.name,
					description: t.description,
					input_schema: t.parameters ?? {
						type: "object",
						properties: {}
					},
					...strict !== void 0 ? { strict } : {}
				};
			});
			sanitizeToolSchemas({ tools });
			payload.tools = tools;
		}
		if (info.reasoning?.supports) {
			const effort = options.reasoningEffort ?? "medium";
			if (effort !== "off" && effort !== "none") payload.thinking = {
				type: "enabled",
				budget_tokens: 1024
			};
		}
		if (options.temperature !== void 0) payload.temperature = options.temperature;
		if (options.stop && options.stop.length > 0) payload.stop_sequences = options.stop;
		return payload;
	}
	/**
	* 按块序关闭所有仍打开的块，产出对应的 block-end。
	* @param open - 块序索引 → 已打开块。
	*/
	*closeBlocks(open) {
		for (const [index, block] of [...open.entries()].sort((a, b) => a[0] - b[0])) if (block.kind === "text") yield {
			type: "block-end",
			index,
			block: {
				type: "text",
				text: block.acc
			}
		};
		else if (block.kind === "reasoning") yield {
			type: "block-end",
			index,
			block: {
				type: "reasoning",
				text: block.acc
			}
		};
		else yield {
			type: "block-end",
			index,
			block: {
				type: "tool-call",
				id: block.id || "call_" + index,
				name: block.name,
				arguments: block.acc
			}
		};
		open.clear();
	}
	async *streamOpenAi(body, signal) {
		let buffer = "";
		let nextBlockIdx = 0;
		let finishEmitted = false;
		let textIdx;
		let reasoningIdx;
		const open = /* @__PURE__ */ new Map();
		const toolBlockOf = /* @__PURE__ */ new Map();
		for await (const chunk of body) {
			if (signal?.aborted) {
				yield* this.closeBlocks(open);
				yield {
					type: "finish",
					reason: {
						kind: "aborted",
						failure: {
							code: "ABORTED",
							message: "Request aborted"
						}
					}
				};
				return;
			}
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (!line.startsWith("data: ")) continue;
				const dataStr = line.slice(6).trim();
				if (dataStr === "[DONE]") {
					yield* this.closeBlocks(open);
					if (!finishEmitted) yield {
						type: "finish",
						reason: { kind: "stop" }
					};
					return;
				}
				try {
					const json = JSON.parse(dataStr);
					const choice = json.choices?.[0];
					const delta = choice?.delta;
					const reasoningContent = delta?.reasoning_content ?? delta?.reasoning;
					if (typeof reasoningContent === "string" && reasoningContent.length > 0) {
						if (reasoningIdx === void 0) {
							reasoningIdx = nextBlockIdx++;
							open.set(reasoningIdx, {
								kind: "reasoning",
								acc: ""
							});
							yield {
								type: "block-start",
								index: reasoningIdx,
								blockType: "reasoning"
							};
						}
						const rb = open.get(reasoningIdx);
						rb.acc += reasoningContent;
						yield {
							type: "reasoning-delta",
							index: reasoningIdx,
							text: reasoningContent
						};
					}
					if (typeof delta?.content === "string" && delta.content.length > 0) {
						if (textIdx === void 0) {
							textIdx = nextBlockIdx++;
							open.set(textIdx, {
								kind: "text",
								acc: ""
							});
							yield {
								type: "block-start",
								index: textIdx,
								blockType: "text"
							};
						}
						const tb2 = open.get(textIdx);
						tb2.acc += delta.content;
						yield {
							type: "text-delta",
							index: textIdx,
							text: delta.content
						};
					}
					if (Array.isArray(delta?.tool_calls)) for (const tc of delta.tool_calls) {
						const tcIndex = tc.index ?? 0;
						let bIdx = toolBlockOf.get(tcIndex);
						if (bIdx === void 0) {
							bIdx = nextBlockIdx++;
							toolBlockOf.set(tcIndex, bIdx);
							open.set(bIdx, {
								kind: "tool-call",
								id: "",
								name: "",
								acc: ""
							});
							yield {
								type: "block-start",
								index: bIdx,
								blockType: "tool-call"
							};
						}
						const tb = open.get(bIdx);
						if (tc.id) tb.id = tc.id;
						if (tc.function?.name) tb.name = tc.function.name;
						const argsDelta = tc.function?.arguments ?? "";
						tb.acc += argsDelta;
						yield {
							type: "tool-call-delta",
							index: bIdx,
							id: tb.id || "call_" + tcIndex,
							...tb.name ? { name: tb.name } : {},
							argumentsDelta: argsDelta
						};
					}
					if (json.usage) yield {
						type: "usage",
						usage: {
							inputTokens: json.usage.prompt_tokens ?? 0,
							outputTokens: json.usage.completion_tokens ?? 0,
							totalTokens: json.usage.total_tokens ?? 0
						}
					};
					if (choice?.finish_reason && !finishEmitted) {
						finishEmitted = true;
						yield* this.closeBlocks(open);
						const fr = choice.finish_reason;
						yield {
							type: "finish",
							reason: fr === "tool_calls" ? { kind: "tool-calls" } : fr === "length" ? { kind: "max-tokens" } : { kind: "stop" }
						};
					}
				} catch {}
			}
		}
		yield* this.closeBlocks(open);
		if (!finishEmitted) yield {
			type: "finish",
			reason: { kind: "stop" }
		};
	}
	async *streamAnthropic(body, signal) {
		let buffer = "";
		let currentEvent = "";
		let nextBlockIdx = 0;
		let finishEmitted = false;
		const open = /* @__PURE__ */ new Map();
		for await (const chunk of body) {
			if (signal?.aborted) {
				yield* this.closeBlocks(open);
				yield {
					type: "finish",
					reason: {
						kind: "aborted",
						failure: {
							code: "ABORTED",
							message: "Request aborted"
						}
					}
				};
				return;
			}
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (line.startsWith("event: ")) currentEvent = line.slice(7).trim();
				else if (line.startsWith("data: ")) {
					const dataStr = line.slice(6).trim();
					try {
						const json = JSON.parse(dataStr);
						if (currentEvent === "content_block_start") {
							const b = json.content_block;
							const index = json.index ?? nextBlockIdx;
							if (b?.type === "text") {
								open.set(index, {
									kind: "text",
									acc: ""
								});
								yield {
									type: "block-start",
									index,
									blockType: "text"
								};
							} else if (b?.type === "thinking") {
								open.set(index, {
									kind: "reasoning",
									acc: ""
								});
								yield {
									type: "block-start",
									index,
									blockType: "reasoning"
								};
							} else if (b?.type === "tool_use") {
								open.set(index, {
									kind: "tool-call",
									id: b.id ?? "",
									name: b.name ?? "",
									acc: ""
								});
								yield {
									type: "block-start",
									index,
									blockType: "tool-call"
								};
							}
							nextBlockIdx = Math.max(nextBlockIdx, index + 1);
						} else if (currentEvent === "content_block_delta") {
							const d = json.delta;
							const index = json.index ?? 0;
							const block = open.get(index);
							if (d?.type === "text_delta") {
								if (block?.kind === "text") block.acc += d.text ?? "";
								yield {
									type: "text-delta",
									index,
									text: d.text ?? ""
								};
							} else if (d?.type === "thinking_delta") {
								if (block?.kind === "reasoning") block.acc += d.thinking ?? "";
								yield {
									type: "reasoning-delta",
									index,
									text: d.thinking ?? ""
								};
							} else if (d?.type === "input_json_delta") {
								const argsDelta = d.partial_json ?? "";
								if (block?.kind === "tool-call") block.acc += argsDelta;
								yield {
									type: "tool-call-delta",
									index,
									id: block?.kind === "tool-call" && block.id || "call_" + index,
									...block?.kind === "tool-call" && block.name ? { name: block.name } : {},
									argumentsDelta: argsDelta
								};
							}
						} else if (currentEvent === "content_block_stop") {
							const index = json.index ?? 0;
							const block = open.get(index);
							if (block !== void 0) {
								open.delete(index);
								yield* this.closeBlocks(/* @__PURE__ */ new Map([[index, block]]));
							}
						} else if (currentEvent === "message_delta") {
							if (json.usage) yield {
								type: "usage",
								usage: {
									inputTokens: json.usage.input_tokens ?? 0,
									outputTokens: json.usage.output_tokens ?? 0,
									totalTokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0)
								}
							};
							if (json.delta?.stop_reason && !finishEmitted) {
								finishEmitted = true;
								yield* this.closeBlocks(open);
								const sr = json.delta.stop_reason;
								yield {
									type: "finish",
									reason: sr === "tool_use" ? { kind: "tool-calls" } : sr === "max_tokens" ? { kind: "max-tokens" } : { kind: "stop" }
								};
							}
						}
					} catch {}
				}
			}
		}
		yield* this.closeBlocks(open);
		if (!finishEmitted) yield {
			type: "finish",
			reason: { kind: "stop" }
		};
	}
};
//#endregion
//#region src/index.ts
const name = "llm-agentrouter";
const inject = ["llm"];
/** 解包一个 volatile 引用单元；普通值原样返回。 */
function readCell(value) {
	if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
	return value;
}
const Config = z.object({
	apiKeyEnv: z.string().default(DEFAULT_API_KEY_REF).role("credential-ref").volatile().description("凭据引用名：密钥从环境变量或 .credentials.yaml 的 refs 段解析（只写不回读，防外泄）"),
	proxy: z.string().default("http://127.0.0.1:7897").volatile().description("上游网络代理（如 http://127.0.0.1:7897；填 direct 表示直连；不支持 SOCKS）"),
	endpoint: z.string().default("https://ps.air-outer.com/v1").volatile().description("AgentRouter API 端点（默认国内源站直连 https://ps.air-outer.com/v1；国际源站 agentrouter.org 需代理）"),
	userAgent: z.string().default("").volatile().description("客户端 User-Agent 标识（留空自动生成官方支持的 pi 客户端标识）"),
	customModels: z.array(z.string()).default([]).volatile().description("自定义模型列表（留空使用在线同步缓存或内置种子表）"),
	directEndpoints: z.union([
		z.const("auto"),
		z.const("always"),
		z.const("none")
	]).default("auto").volatile().description("端点传输方式：auto=国内源站直连其余走代理；always=全部直连；none=全部走代理"),
	protocolPreference: z.union([z.const("anthropic-first"), z.const("openai-first")]).default("anthropic-first").volatile().description("协议择优策略：anthropic-first=优先 /v1/messages（带思考签名）；openai-first=全部走 /v1/chat/completions"),
	autoRefreshModels: z.boolean().default(true).volatile().description("启动时用中转站 /v1/models 的真实在售列表刷新模型目录"),
	silentRetry: z.boolean().default(true).volatile().description("中转站渠道抖动（5xx / 渠道方言 400）时自动重发，harness 只看到最终结果"),
	silentRetryAttempts: z.number().step(1).min(1).max(10).default(3).volatile().description("单次请求的最大发送次数（含首次）"),
	quotaHint: z.string().default(DEFAULT_QUOTA_HINT).volatile().description("402 配额错误后追加的提示文案；留空关闭")
});
async function apply(ctx, config = {}) {
	const liveConfig = () => resolveConfig({
		apiKeyEnv: readCell(config.apiKeyEnv),
		proxyUrl: readCell(config.proxy),
		endpoint: readCell(config.endpoint),
		userAgent: readCell(config.userAgent),
		customModels: readCell(config.customModels),
		directEndpoints: readCell(config.directEndpoints),
		protocolPreference: readCell(config.protocolPreference),
		autoRefreshModels: readCell(config.autoRefreshModels),
		silentRetry: readCell(config.silentRetry),
		silentRetryAttempts: readCell(config.silentRetryAttempts),
		quotaHint: readCell(config.quotaHint)
	});
	const initialCfg = liveConfig();
	const proxyCheck = validateProxyUrl(initialCfg.proxyUrl);
	if (!proxyCheck.ok) ctx.logger?.warn?.(`AgentRouter 代理地址不可用：${proxyCheck.message}`);
	if (initialCfg.correctedEndpoint) ctx.logger?.warn?.(`AgentRouter 端点 "${initialCfg.correctedEndpoint}" 已知不可用（会触发上游 WAF 并拒绝密钥），已自动改用 ${initialCfg.endpoint}。`);
	const adapter = new AgentRouterLlmAdapter({
		resolveConfig: liveConfig,
		logger: ctx.logger
	});
	const release = ctx.llm.registerAdapter([AGENTROUTER_PROVIDER], adapter);
	ctx.effect(() => () => {
		release();
	});
	if (hasLegacyApiKey()) {
		if (credentialApiKey(initialCfg.apiKeyEnv)) {
			if (dropLegacyApiKeyIfSuperseded(true)) ctx.logger?.info?.("AgentRouter: API Key 已迁移到凭据存储，旧的明文副本已从 config.json 移除。");
		} else ctx.logger?.warn?.("AgentRouter: 检测到 ~/.dsh/agentrouter/config.json 里仍有明文 API Key。请在「设置 → 插件 → AgentRouter」里重新填写一次（写入凭据存储），插件随后会自动移除旧副本。");
	}
	(async () => {
		const cfg = liveConfig();
		if (!cfg.autoRefreshModels) return;
		const synced = await syncModelCatalog(cfg, ctx.logger);
		if (synced && synced.length > 0) try {
			ctx.emit("llm/adapters-updated");
		} catch {}
	})();
	registerDiagnostics(ctx, liveConfig);
}
/**
* 注册一个无参数的诊断路由。
*/
function registerDiagnostics(ctx, liveConfig) {
	ctx.inject(["webServer"], (sub) => {
		const webServer = sub.get("webServer");
		if (!webServer?.register) return;
		const sendJson = (res, status, body) => {
			const r = res;
			r.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
			r.end(JSON.stringify(body));
		};
		return webServer.register({
			kind: "exact",
			path: "/plugins/agentrouter/test",
			handler: (req, res) => {
				(async () => {
					if (String(req.method ?? "GET").toUpperCase() !== "POST") {
						sendJson(res, 405, { error: "POST only" });
						return;
					}
					const cfg = liveConfig();
					if (!cfg.apiKey) {
						sendJson(res, 200, {
							ok: false,
							status: 0,
							latencyMs: 0,
							message: "尚未配置 API Key：请在上方填写并保存，或在 .credentials.yaml 里配置 AGENTROUTER_API_KEY。"
						});
						return;
					}
					const result = await testConnection({
						endpoint: cfg.endpoint,
						apiKey: cfg.apiKey,
						proxyUrl: cfg.proxyUrl,
						userAgent: cfg.userAgent,
						directMode: cfg.directEndpoints
					});
					sendJson(res, 200, result);
				})();
			}
		});
	});
}
//#endregion
export { AGENTROUTER_DEFAULT_MODELS, AGENTROUTER_PROVIDER, AgentRouterLlmAdapter, Config, DEFAULT_API_KEY_REF, DEFAULT_QUOTA_HINT, agentRouterFetch, apply, applyProtocolOverrides, configFile, credentialApiKey, describeActiveModels, dropLegacyApiKeyIfSuperseded, effectiveModelIds, effectiveModels, fetchRelayModels, getAgentRouterUserAgent, getDispatcherForEndpoint, hasLegacyApiKey, inject, name, resolveActiveModels, resolveConfig, resolveModelProtocol, saveConfig, shouldBypassProxy, stateDir, syncModelCatalog, testConnection, validateProxyUrl };
