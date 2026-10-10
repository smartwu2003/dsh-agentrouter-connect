/**
 * AgentRouter plugin for DeepSeek Harness.
 *
 * Connects AgentRouter aggregated models into DSH with built-in proxy support,
 * client-identity header spoofing, and a native settings page.
 *
 * Implements a pure native LlmAdapter: zero local ports, zero child processes,
 * and direct proxy-aware undici dispatch.
 *
 * @module dsh-agentrouter-connect
 */

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import {
  resolveConfig,
  syncModelCatalog,
  dropLegacyApiKeyIfSuperseded,
  hasLegacyApiKey,
  credentialApiKey,
  DEFAULT_QUOTA_HINT,
  DEFAULT_API_KEY_REF,
  type AgentRouterConfig,
} from './config.ts';
import { validateProxyUrl, testConnection } from './net.ts';
import {
  AgentRouterLlmAdapter,
  AGENTROUTER_PROVIDER,
  describeActiveModels,
  effectiveModels,
} from './adapter.ts';

export {
  AgentRouterLlmAdapter,
  AGENTROUTER_PROVIDER,
  describeActiveModels,
  effectiveModels,
} from './adapter.ts';
export {
  AGENTROUTER_DEFAULT_MODELS,
  resolveActiveModels,
  resolveModelProtocol,
  applyProtocolOverrides,
} from './catalog.ts';
export {
  resolveConfig,
  saveConfig,
  syncModelCatalog,
  effectiveModelIds,
  stateDir,
  configFile,
  credentialApiKey,
  dropLegacyApiKeyIfSuperseded,
  hasLegacyApiKey,
  DEFAULT_QUOTA_HINT,
  DEFAULT_API_KEY_REF,
} from './config.ts';
export {
  testConnection,
  fetchRelayModels,
  getAgentRouterUserAgent,
  agentRouterFetch,
  getDispatcherForEndpoint,
  shouldBypassProxy,
  validateProxyUrl,
} from './net.ts';

export const name = 'llm-agentrouter';
export const inject = ['llm'];

/**
 * 一个 volatile 配置引用单元（与 cosmokit 的 `Volatile` 结构一致）。
 */
export interface Volatile<T> { get(): T }

/** 解包一个 volatile 引用单元；普通值原样返回。 */
function readCell<T>(value: T | Volatile<T> | undefined): T | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as Volatile<T>).get === 'function') {
    return (value as Volatile<T>).get();
  }
  return value as T | undefined;
}

/**
 * apply() 收到的运行时配置形状。
 */
export interface PluginConfig {
  apiKeyEnv: Volatile<string>;
  proxy: Volatile<string>;
  endpoint: Volatile<string>;
  userAgent: Volatile<string>;
  customModels: Volatile<string[]>;
  directEndpoints: Volatile<'auto' | 'always' | 'none'>;
  protocolPreference: Volatile<'anthropic-first' | 'openai-first'>;
  autoRefreshModels: Volatile<boolean>;
  silentRetry: Volatile<boolean>;
  silentRetryAttempts: Volatile<number>;
  quotaHint: Volatile<string>;
}

export const Config = z.object({
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_REF)
    .role('credential-ref')
    .volatile()
    .description('凭据引用名：密钥从环境变量或 .credentials.yaml 的 refs 段解析（只写不回读，防外泄）'),
  proxy: z.string().default('http://127.0.0.1:7897')
    .volatile()
    .description('上游网络代理（如 http://127.0.0.1:7897；填 direct 表示直连；不支持 SOCKS）'),
  endpoint: z.string().default('https://ps.air-outer.com/v1')
    .volatile()
    .description('AgentRouter API 端点（默认国内源站直连 https://ps.air-outer.com/v1；国际源站 agentrouter.org 需代理）'),
  userAgent: z.string().default('')
    .volatile()
    .description('客户端 User-Agent 标识（留空自动生成官方支持的 pi 客户端标识）'),
  customModels: z.array(z.string()).default([])
    .volatile()
    .description('自定义模型列表（留空使用在线同步缓存或内置种子表）'),
  directEndpoints: z.union([z.const('auto'), z.const('always'), z.const('none')]).default('auto')
    .volatile()
    .description('端点传输方式：auto=国内源站直连其余走代理；always=全部直连；none=全部走代理'),
  protocolPreference: z.union([z.const('anthropic-first'), z.const('openai-first')]).default('anthropic-first')
    .volatile()
    .description('协议择优策略：anthropic-first=优先 /v1/messages（带思考签名）；openai-first=全部走 /v1/chat/completions'),
  autoRefreshModels: z.boolean().default(true)
    .volatile()
    .description('启动时用中转站 /v1/models 的真实在售列表刷新模型目录'),
  silentRetry: z.boolean().default(true)
    .volatile()
    .description('中转站渠道抖动（5xx / 渠道方言 400）时自动重发，harness 只看到最终结果'),
  silentRetryAttempts: z.number().step(1).min(1).max(10).default(3)
    .volatile()
    .description('单次请求的最大发送次数（含首次）'),
  quotaHint: z.string().default(DEFAULT_QUOTA_HINT)
    .volatile()
    .description('402 配额错误后追加的提示文案；留空关闭'),
});

export async function apply(ctx: Context, config: PluginConfig = {} as PluginConfig): Promise<void> {
  const liveConfig = (): AgentRouterConfig => resolveConfig({
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
    quotaHint: readCell(config.quotaHint),
  });

  const initialCfg = liveConfig();

  const proxyCheck = validateProxyUrl(initialCfg.proxyUrl);
  if (!proxyCheck.ok) {
    ctx.logger?.warn?.(`AgentRouter 代理地址不可用：${proxyCheck.message}`);
  }

  if (initialCfg.correctedEndpoint) {
    ctx.logger?.warn?.(
      `AgentRouter 端点 "${initialCfg.correctedEndpoint}" 已知不可用（会触发上游 WAF 并拒绝密钥），` +
      `已自动改用 ${initialCfg.endpoint}。`,
    );
  }

  // 纯原生 LlmAdapter：零本地端口、零子进程、纯内存直连
  const adapter = new AgentRouterLlmAdapter({
    resolveConfig: liveConfig,
    logger: ctx.logger,
  });

  const release = ctx.llm.registerAdapter([AGENTROUTER_PROVIDER], adapter);

  ctx.effect(() => () => {
    release();
  });

  // 旧版明文密钥迁移保护
  if (hasLegacyApiKey()) {
    if (credentialApiKey(initialCfg.apiKeyEnv)) {
      const migrated = dropLegacyApiKeyIfSuperseded(true);
      if (migrated) {
        ctx.logger?.info?.('AgentRouter: API Key 已迁移到凭据存储，旧的明文副本已从 config.json 移除。');
      }
    } else {
      ctx.logger?.warn?.(
        'AgentRouter: 检测到 ~/.dsh/agentrouter/config.json 里仍有明文 API Key。' +
        '请在「设置 → 插件 → AgentRouter」里重新填写一次（写入凭据存储），插件随后会自动移除旧副本。',
      );
    }
  }

  // 模型目录同步
  void (async () => {
    const cfg = liveConfig();
    if (!cfg.autoRefreshModels) return;
    const synced = await syncModelCatalog(cfg, ctx.logger);
    if (synced && synced.length > 0) {
      try {
        (ctx as any).emit('llm/adapters-updated');
      } catch {
        // 忽略通知失败
      }
    }
  })();

  registerDiagnostics(ctx, liveConfig);
}

/**
 * 注册一个无参数的诊断路由。
 */
function registerDiagnostics(ctx: Context, liveConfig: () => AgentRouterConfig): void {
  ctx.inject(['webServer'], (sub) => {
    const webServer = sub.get('webServer') as {
      register?(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) | undefined;
    } | undefined;
    if (!webServer?.register) return;

    const sendJson = (res: unknown, status: number, body: unknown): void => {
      const r = res as { writeHead(status: number, headers?: Record<string, string>): void; end(chunk?: string): void };
      r.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      r.end(JSON.stringify(body));
    };

    return webServer.register({
      kind: 'exact',
      path: '/plugins/agentrouter/test',
      handler: (req, res) => {
        void (async () => {
          const method = String((req as { method?: unknown }).method ?? 'GET').toUpperCase();
          if (method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' });
            return;
          }
          const cfg = liveConfig();
          if (!cfg.apiKey) {
            sendJson(res, 200, { ok: false, status: 0, latencyMs: 0, message: '尚未配置 API Key：请在上方填写并保存，或在 .credentials.yaml 里配置 AGENTROUTER_API_KEY。' });
            return;
          }
          const result = await testConnection({
            endpoint: cfg.endpoint,
            apiKey: cfg.apiKey,
            proxyUrl: cfg.proxyUrl,
            userAgent: cfg.userAgent,
            directMode: cfg.directEndpoints,
          });
          sendJson(res, 200, result);
        })();
      },
    });
  });
}
