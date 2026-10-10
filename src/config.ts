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

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isDirectEndpointsMode, fetchRelayModels, type DirectEndpointsMode } from './net.ts';
import type { AgentRouterProtocol, AgentRouterProtocolPreference } from './catalog.ts';
/** 402 配额错误的默认提示文案。 */
export const DEFAULT_QUOTA_HINT = '该模型的预算池本批额度已用完，请等待下一批投放，或改用其他模型。';

/** 凭据引用的默认名字（与设置卡片、.credentials.yaml 的 refs 段一致）。 */
export const DEFAULT_API_KEY_REF = 'AGENTROUTER_API_KEY';

/** 默认端点：国内源站，实测直连可达。 */
export const DEFAULT_ENDPOINT = 'https://ps.air-outer.com/v1';

/**
 * 已知不可用的端点主机。
 *
 * `co.agentrouter.org` 曾被误当作国际源站写进 profile 补丁；实测它会触发阿里云
 * WAF 并拒绝密钥。配置里若仍留着这个值（旧补丁、旧文档、手工编辑），解析时自动
 * 回落到默认端点并在日志里说明 —— 否则插件会安静地用一个必然失败的地址，
 * 而用户看到的只是「请求失败」。
 */
export const LEGACY_ENDPOINT_HOSTS: readonly string[] = ['co.agentrouter.org'];

export interface AgentRouterConfig {
  /** 凭据引用名：密钥从环境变量或 .credentials.yaml 的这个键解析。 */
  apiKeyEnv: string;
  proxyUrl: string;
  apiKey: string;
  endpoint: string;
  userAgent: string;
  customModels?: string[];
  /**
   * 端点传输方式：
   *  - `auto`（默认）国内源站直连、其余走代理
   *  - `always` 全部直连
   *  - `none` 全部走代理（国内源站直连不可用时的回退）
   */
  directEndpoints: DirectEndpointsMode;
  /**
   * 协议择优策略：`anthropic-first`（默认）或 `openai-first`。
   * 用户按模型的显式覆盖始终优先于它。
   */
  protocolPreference: AgentRouterProtocolPreference;
  /**
   * 按模型指定的协议覆盖，形如 `{ "deepseek-v4-flash": "openai" }`。
   *
   * 未指定的模型按 `protocols` 与 `protocolPreference` 自动择优。
   */
  modelProtocols?: Record<string, AgentRouterProtocol>;
  /**
   * 中转站把同一模型轮询到多个上游渠道，渠道方言不一致时会回一个普通 400；
   * 打开后由回环 shim 自行重发（最多 `silentRetryAttempts` 次）。
   */
  silentRetry: boolean;
  /** 单次请求的最大发送次数（含首次）。 */
  silentRetryAttempts: number;
  /** 402 配额错误后追加的提示文案；空串关闭该提示。 */
  quotaHint: string;
  /**
   * 是否在启动/设置变更时用中转站 `/v1/models` 的真实在售列表覆盖
   * `customModels`。中转站模型上下线频繁，内置种子表只能近似。
   */
  autoRefreshModels: boolean;
  /**
   * 中转站 `/v1/models` 实测在售列表的缓存。
   *
   * 这是**缓存**而不是配置：设置卡片里没有填写模型列表时用它，填了就听用户的。
   * 之所以不直接写进设置文档，是因为插件无法改写 profile 补丁（那是宿主的领域），
   * 而写进 config.json 的 `customModels` 又会让「页面显示的值」和「实际使用的值」
   * 变成两个来源 —— 那正是这次要消灭的问题。
   */
  relayModels?: string[];
  /** 上一次成功同步模型目录的时间（ISO 字符串）；从未同步时为空串。 */
  modelCatalogSyncedAt: string;
  /** 被自动纠正掉的旧端点；没有纠正时为 undefined。 */
  correctedEndpoint?: string;
}

export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

export function stateDir(): string {
  return join(dshHome(), 'agentrouter');
}

export function configFile(): string {
  return join(stateDir(), 'config.json');
}

/**
 * 带 mtime 缓存的 JSON 读取。
 *
 * shim 会在每次 chat completion 时调用 resolveConfig()，同步读盘 + 解析
 * 会给每个请求增加不必要的开销；文件未变化时直接复用上次解析结果。
 * @param file - 目标文件路径。
 * @returns 解析后的对象；不存在、损坏或读取失败时返回空对象。
 */
function readJsonFile(file: string): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {};
    const stat = statSync(file);
    if (cachedFile === file && cachedMtimeMs === stat.mtimeMs) {
      return cachedData;
    }
    const content = readFileSync(file, 'utf8');
    const parsed = JSON.parse(content);
    const data = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    cachedFile = file;
    cachedMtimeMs = stat.mtimeMs;
    cachedData = data;
    return data;
  } catch {
    return {};
  }
}

let cachedFile = '';
let cachedMtimeMs = -1;
let cachedData: Record<string, unknown> = {};

/** 合法的协议取值。 */
export function isAgentRouterProtocol(value: unknown): value is AgentRouterProtocol {
  return value === 'openai' || value === 'anthropic';
}

/** 合法的协议择优策略。 */
export function isProtocolPreference(value: unknown): value is AgentRouterProtocolPreference {
  return value === 'anthropic-first' || value === 'openai-first';
}

/**
 * 共享的 volatile 引用协议（与 cosmokit 的 isVolatile 同一枚符号）。
 *
 * 声明为 .volatile() 的 Config 字段以**引用单元**形态到达插件：设置写入原地
 * 更新单元而不重载 fiber，因此每次读取都必须解包取当前值。用 Symbol.for 而不是
 * 直接依赖 cosmokit —— 插件不把 cosmokit 列为依赖，跨 ESM/CJS 副本也要认得出。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** 一个 volatile 配置引用单元。 */
interface VolatileCell<T> { get(): T }

/** 该值是否为 volatile 引用单元。 */
function isVolatileCell<T>(value: unknown): value is VolatileCell<T> {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value;
}

/** 解包 volatile 单元；普通值原样返回。 */
function unwrap<T>(value: T | VolatileCell<T> | undefined): T | undefined {
  if (isVolatileCell<T>(value)) return value.get();
  return value as T | undefined;
}

/**
 * 从环境变量或 `$DSH_HOME/.credentials.yaml` 的 refs 段解析密钥。
 * @param ref - 凭据引用名。
 * @returns 密钥；两处都没有时返回空串。
 */
export function credentialApiKey(ref: string = DEFAULT_API_KEY_REF): string {
  return resolveCredentialApiKey(ref);
}

function resolveCredentialApiKey(ref: string): string {
  const fromEnv = process.env[ref];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const credPath = join(dshHome(), '.credentials.yaml');
    if (existsSync(credPath)) {
      const content = readFileSync(credPath, 'utf8');
      // 转义 ref 里可能出现的正则元字符：apiKeyEnv 是用户可改的名字，含 . + ( 等
      // 字符时未转义会让这个正则匹配错误甚至抛异常。
      const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 只匹配缩进（refs 段）里该名字对应的标量值，避免命中顶层同名键。
      const pattern = new RegExp('^[ \\t]+' + escaped + ':[ \\t]*(.*)$', 'm');
      const match = pattern.exec(content);
      if (match && match[1]) {
        const value = match[1].trim().replace(/^["']|["']$/g, '');
        if (value) return value;
      }
    }
  } catch {
    // Ignore error
  }
  return '';
}

export interface ResolveConfigInput {
  apiKeyEnv?: string;
  proxyUrl?: string;
  apiKey?: string;
  endpoint?: string;
  userAgent?: string;
  customModels?: string[];
  directEndpoints?: DirectEndpointsMode;
  protocolPreference?: AgentRouterProtocolPreference;
  modelProtocols?: Record<string, AgentRouterProtocol>;
  silentRetry?: boolean;
  silentRetryAttempts?: number;
  quotaHint?: string;
  autoRefreshModels?: boolean;
}

function normalizeModelProtocols(raw: unknown): Record<string, AgentRouterProtocol> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, AgentRouterProtocol> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === 'string' && k.trim() && isAgentRouterProtocol(v)) {
      out[k.trim().toLowerCase()] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function resolveConfig(entryConfig?: ResolveConfigInput): AgentRouterConfig {
  const fileData = readJsonFile(configFile());
  const env = process.env;

  const defaultProxy = 'http://127.0.0.1:7897';
  // 默认使用国内源站：实测直连可达，且能绕开代理出口 IP 触发的 WAF 质询
  // （国际源站直连不通、必须走代理，而代理出口正是 WAF 质询对象）。
  const defaultEndpoint = DEFAULT_ENDPOINT;
  const defaultUserAgent = '';

  // Config 段里声明了 .volatile() 的字段以引用单元到达，读取前必须解包。
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

  // 这些字段**只**来自设置段（profile 补丁）+ 环境变量；config.json 不再作为第二
  // 来源。因此设置页显示的值就是插件使用的值，二者不可能各说各话。
  const proxyUrl = entryProxy || env.AGENTROUTER_PROXY || env.ALL_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY || defaultProxy;

  const apiKeyEnv = entryApiKeyEnv || DEFAULT_API_KEY_REF;

  // 密钥优先级：设置卡片的 secret 字段（entryConfig）> 环境变量 > .credentials.yaml
  // > 旧版 config.json 里的明文（仅为向后兼容，命中后会提示迁移）。
  const apiKey = entryApiKey
    || resolveCredentialApiKey(apiKeyEnv)
    || (typeof fileData.apiKey === 'string' ? fileData.apiKey.trim() : '');

  const requestedEndpoint = entryEndpoint || env.AGENTROUTER_ENDPOINT || defaultEndpoint;

  // 旧补丁里可能留着已知不可用的主机；静默失败比自动纠正更糟，所以纠正并记录。
  let correctedEndpoint: string | undefined;
  let endpoint = requestedEndpoint;
  try {
    const host = new URL(requestedEndpoint).hostname.toLowerCase();
    if (LEGACY_ENDPOINT_HOSTS.includes(host)) {
      correctedEndpoint = requestedEndpoint;
      endpoint = defaultEndpoint;
    }
  } catch {
    // 非法 URL 留给请求阶段报错，这里不吞掉用户的输入。
  }

  const userAgent = entryUserAgent || defaultUserAgent;

  const customModels: string[] | undefined = Array.isArray(entryCustomModels)
    ? entryCustomModels.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim())
    : undefined;

  const relayModels: string[] | undefined = Array.isArray(fileData.relayModels)
    ? (fileData.relayModels as unknown[])
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map(x => x.trim())
    : undefined;

  const directEndpoints: DirectEndpointsMode = isDirectEndpointsMode(entryDirectEndpoints) ? entryDirectEndpoints : 'auto';

  const protocolPreference: AgentRouterProtocolPreference = isProtocolPreference(entryProtocolPreference) ? entryProtocolPreference : 'anthropic-first';

  // 按模型的协议覆盖表：只接受合法的协议取值。
  const modelProtocols = normalizeModelProtocols(fileData.modelProtocols ?? entryModelProtocols);

  const silentRetry = typeof entrySilentRetry === 'boolean' ? entrySilentRetry : true;

  const rawAttempts = entrySilentRetryAttempts;
  const silentRetryAttempts = Number.isFinite(rawAttempts)
    ? Math.min(10, Math.max(1, Math.round(rawAttempts as number)))
    : 3;

  const quotaHint = typeof entryQuotaHint === 'string' ? entryQuotaHint : DEFAULT_QUOTA_HINT;

  const autoRefreshModels = typeof entryAutoRefreshModels === 'boolean' ? entryAutoRefreshModels : true;

  const modelCatalogSyncedAt = typeof fileData.modelCatalogSyncedAt === 'string'
    ? fileData.modelCatalogSyncedAt
    : '';

  return {
    apiKeyEnv,
    proxyUrl,
    apiKey,
    endpoint: endpoint.replace(/\/+$/, ''),
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
    correctedEndpoint,
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
export function saveConfig(updates: Partial<AgentRouterConfig>): AgentRouterConfig {
  try {
    mkdirSync(stateDir(), { recursive: true });
  } catch {
    // Ignore
  }
  const current = readJsonFile(configFile());
  const { apiKey: _ignoredApiKey, ...persistable } = updates;
  const merged = { ...current, ...persistable };
  const file = configFile();
  writeFileSync(file, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // 平台不支持时忽略
  }
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
export function dropLegacyApiKeyIfSuperseded(superseded: boolean): string {
  const current = readJsonFile(configFile());
  const legacy = typeof current.apiKey === 'string' ? current.apiKey.trim() : '';
  if (!legacy || !superseded) return '';
  const { apiKey: _removed, ...rest } = current;
  try {
    const file = configFile();
    writeFileSync(file, JSON.stringify(rest, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // 平台不支持时忽略
    }
    cachedFile = '';
    cachedMtimeMs = -1;
  } catch {
    // 写失败时保留原文件，下次启动再试
  }
  return legacy;
}

/** 旧版 config.json 里是否还留着明文密钥（尚未迁移）。 */
export function hasLegacyApiKey(): boolean {
  const current = readJsonFile(configFile());
  return typeof current.apiKey === 'string' && current.apiKey.trim().length > 0;
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
export async function syncModelCatalog(
  cfg: AgentRouterConfig,
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void },
): Promise<string[] | undefined> {
  if (!cfg.apiKey) return undefined;
  try {
    const ids = await fetchRelayModels({
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey,
      proxyUrl: cfg.proxyUrl,
      userAgent: cfg.userAgent,
      directMode: cfg.directEndpoints,
    });
    if (ids.length === 0) return undefined;
    // 与已缓存的列表逐字相同时无需写盘：避免每次启动都因为「时间戳变了」而重写，
    // 也避免为一次空操作触发适配器重建。
    const cached = cfg.relayModels ?? [];
    const unchanged = cached.length === ids.length && ids.every(id => cached.includes(id));
    if (unchanged) return ids;
    // 只更新缓存：设置卡片里填了模型列表时，用户的选择优先。
    saveConfig({ relayModels: ids, modelCatalogSyncedAt: new Date().toISOString() });
    logger?.info?.(
      'AgentRouter 模型目录已同步：' + ids.join(', ') +
      (cfg.customModels?.length ? '（设置里已指定模型列表，该缓存仅作参考）' : ''),
    );
    return ids;
  } catch (err: any) {
    logger?.warn?.('AgentRouter 模型目录同步失败（保留现有列表）: ' + (err?.message || String(err)));
    return undefined;
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
export function effectiveModelIds(cfg: AgentRouterConfig): string[] | undefined {
  if (cfg.customModels && cfg.customModels.length > 0) return cfg.customModels;
  if (cfg.relayModels && cfg.relayModels.length > 0) return cfg.relayModels;
  return undefined;
}
