/**
 * Proxy-aware networking implementation using undici, mirroring dsh-agy-link.
 *
 * Node's built-in fetch ignores system proxies on Windows GUI apps.
 * Using undici's ProxyAgent and EnvHttpProxyAgent ensures all outgoing traffic
 * can be directed through clash/mihomo (e.g. http://127.0.0.1:7897), bypassing
 * DNS pollution and GFW.
 */

import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { platform, release, arch } from 'node:os';

let envAgent: EnvHttpProxyAgent | undefined;
const perProxyAgents = new Map<string, ProxyAgent>();

/**
 * 进程级环境代理，惰性构造。
 *
 * 构造 `EnvHttpProxyAgent` 会打印 undici 的实验性特性告警，而插件在多数部署里
 * 走的是显式 ProxyAgent —— 只有 `proxyUrl` 留空时才需要它，因此推迟到那一刻。
 * @returns 环境代理 dispatcher。
 */
function getEnvAgent(): EnvHttpProxyAgent {
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
const CN_HOST = 'ps.air-outer.com';

/**
 * 端点传输方式。
 *  - `auto`（默认）：国内源站直连，其余端点走配置的代理
 *  - `always`：全部直连，不使用代理
 *  - `none`：全部走配置的代理（连国内源站也不绕过，供直连不可用时回退）
 */
export type DirectEndpointsMode = 'auto' | 'always' | 'none';

/** 校验来自配置文件/请求体的取值是否合法。 */
export function isDirectEndpointsMode(value: unknown): value is DirectEndpointsMode {
  return value === 'auto' || value === 'always' || value === 'none';
}

/**
 * 代理地址的可用性判定结果。
 */
export interface ProxyValidation {
  ok: boolean;
  /** 不可用时的用户可读原因（含修正建议）。 */
  message?: string;
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
export function validateProxyUrl(raw: string): ProxyValidation {
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'direct') return { ok: true };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      message: `代理地址 "${value}" 不是合法 URL；请填写形如 http://127.0.0.1:7897 的地址，或填 direct 表示直连。`,
    };
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return { ok: true };
  if (/^socks/i.test(parsed.protocol)) {
    return {
      ok: false,
      message: `代理地址 "${value}" 使用的是 ${parsed.protocol}// 协议，本插件不支持 SOCKS 代理；请改用 Clash/Mihomo 的 HTTP 端口（例如 http://127.0.0.1:7897），或在代理软件里开启 HTTP 混合端口。`,
    };
  }
  return {
    ok: false,
    message: `代理地址 "${value}" 使用了不支持的 ${parsed.protocol}// 协议；请填写 http:// 或 https:// 开头的地址。`,
  };
}

/**
 * 判断某个端点是否应绕过进程代理直连。
 * @param endpoint - 上游 API 端点。
 * @param mode - 传输方式，默认 `auto`（仅国内源站直连）。
 */
export function shouldBypassProxy(endpoint: string, mode: DirectEndpointsMode = 'auto'): boolean {
  if (mode === 'none') return false;
  if (mode === 'always') return true;
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
export function getDispatcherForEndpoint(
  endpoint: string,
  proxyUrl?: string,
  mode: DirectEndpointsMode = 'auto',
): EnvHttpProxyAgent | ProxyAgent | undefined {
  if (shouldBypassProxy(endpoint, mode)) return undefined;
  return getDispatcher(proxyUrl);
}

export function getDispatcher(proxyUrl?: string): EnvHttpProxyAgent | ProxyAgent | undefined {
  if (!proxyUrl || !proxyUrl.trim()) {
    return getEnvAgent();
  }
  const clean = proxyUrl.trim();
  if (clean.toLowerCase() === 'direct') {
    return undefined; // direct connection
  }
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
export function getAgentRouterUserAgent(): string {
  return `pi (${platform()} ${release()}; ${arch()})`;
}

export function buildAgentRouterHeaders(apiKey: string, userAgent?: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent': userAgent?.trim() || getAgentRouterUserAgent(),
  };
}

export async function agentRouterFetch(
  url: string,
  init: RequestInit = {},
  proxyUrl?: string,
  directMode: DirectEndpointsMode = 'auto',
): Promise<Response> {
  // 按目标端点挑选传输：国内源站默认绕过代理以避开 WAF 对代理出口 IP 的质询。
  const dispatcher = getDispatcherForEndpoint(url, proxyUrl, directMode);
  return undiciFetch(url, {
    ...(init as object),
    ...(dispatcher ? { dispatcher } : {}),
  }) as unknown as Promise<Response>;
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
export async function fetchRelayModels(options: {
  endpoint: string;
  apiKey: string;
  proxyUrl?: string;
  userAgent?: string;
  directMode?: DirectEndpointsMode;
  timeoutMs?: number;
}): Promise<string[]> {
  const { endpoint, apiKey, proxyUrl, userAgent, directMode = 'auto', timeoutMs = 15000 } = options;
  const url = `${endpoint.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await agentRouterFetch(url, {
      method: 'GET',
      headers: {
        ...buildAgentRouterHeaders(apiKey, userAgent),
        'Accept': 'application/json',
      },
      signal: controller.signal,
    }, proxyUrl, directMode);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`读取模型列表失败 (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    const parsed = JSON.parse(text) as { data?: unknown };
    if (!Array.isArray(parsed?.data)) {
      throw new Error('模型列表响应缺少 data 数组（可能被 WAF 拦截返回了 HTML）。');
    }
    const ids = parsed.data
      .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim());
    return [...new Set(ids)];
  } finally {
    clearTimeout(timer);
  }
}

export async function testConnection(options: {
  endpoint: string;
  apiKey: string;
  proxyUrl?: string;
  userAgent?: string;
  directMode?: DirectEndpointsMode;
}): Promise<{ ok: boolean; status: number; latencyMs: number; message: string }> {
  const { endpoint, apiKey, proxyUrl, userAgent, directMode = 'auto' } = options;
  const start = Date.now();
  try {
    const url = `${endpoint.replace(/\/+$/, '')}/models`;
    const res = await agentRouterFetch(
      url,
      {
        method: 'GET',
        headers: {
          ...buildAgentRouterHeaders(apiKey, userAgent),
          'Accept': 'application/json',
        },
      },
      proxyUrl,
      directMode,
    );
    const latencyMs = Date.now() - start;
    const text = await res.text();
    const contentType = res.headers.get('content-type') || '';
    // 本次测试实际使用的传输方式，用于在失败时给出对症的建议。
    const usedDirect = shouldBypassProxy(endpoint, directMode);
    const transport = usedDirect ? '直连' : `代理 ${proxyUrl || '(未配置)'}`;

    // WAF or HTML interception detection
    if (
      contentType.includes('text/html') ||
      text.includes('aliyun_waf') ||
      text.includes('CF_APP_WAF') ||
      text.includes('<!doctype html') ||
      text.includes('<html')
    ) {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        message: usedDirect
          ? `触发上游阿里云 WAF 验证码拦截（返回了 HTML 网页而不是 API 数据）。当前为直连（${transport}），通常是出口 IP 被风控，请稍后重试。`
          : `触发上游阿里云 WAF 验证码拦截（返回了 HTML 网页而不是 API 数据）。当前走${transport} —— 中转站 WAF 会质询代理出口 IP，这正是最可能的原因：改用国内端点 https://ps.air-outer.com/v1（会自动直连）通常即可解决。`,
      };
    }

    if (res.ok) {
      try {
        const parsed = JSON.parse(text);
        const count = Array.isArray(parsed?.data) ? parsed.data.length : undefined;
        return {
          ok: true,
          status: res.status,
          latencyMs,
          message: `连接成功！响应耗时 ${latencyMs}ms，${transport} 与 API Key 正常${count !== undefined ? `（已获取到 ${count} 个模型）` : ''}。`,
        };
      } catch {
        return {
          ok: false,
          status: res.status,
          latencyMs,
          message: `接口返回非 JSON 格式内容，请确认端点地址是否正确（推荐国内源站 https://ps.air-outer.com/v1）。`,
        };
      }
    }

    if (res.status === 401) {
      return {
        ok: false,
        status: 401,
        latencyMs,
        message: `HTTP 401: 密钥无效或被判定为未授权客户端！网络与端点连接通畅 (${latencyMs}ms，${transport})，但 AgentRouter 上游拒绝了该请求。请登录控制台 https://ps.air-outer.com/console/personal 重新获取有效 Token；若 Token 确认有效，则是客户端标识被拒，请在插件设置里检查 User-Agent 配置。`,
      };
    }

    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed.msg) msg += `: ${parsed.msg}`;
      else if (parsed.error?.message) msg += `: ${parsed.error.message}`;
      else if (parsed.message) msg += `: ${parsed.message}`;
    } catch {
      msg += `: ${text.slice(0, 100)}`;
    }

    return { ok: false, status: res.status, latencyMs, message: msg };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    return {
      ok: false,
      status: 0,
      latencyMs,
      message: `网络连接失败 (${err?.message || String(err)})。请检查本地代理软件（如 Clash 7897 端口）是否正在运行，以及代理地址是否受支持。`,
    };
  }
}
