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

import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  RequestMessage,
  ResolvedRetryPolicy,
  StreamChunk,
  ToolCallId,
  ReplayEnvelope,
} from '@deepseek-ai/dsh-llm';
import { request as undiciRequest } from 'undici';
import {
  fallbackModel,
  resolveActiveModels,
  resolveModelProtocol,
  applyProtocolOverrides,
  type AgentRouterModelInfo,
  type AgentRouterProtocol,
} from './catalog.ts';
import {
  effectiveModelIds,
  type AgentRouterConfig,
} from './config.ts';
import {
  getAgentRouterUserAgent,
  getDispatcherForEndpoint,
  validateProxyUrl,
} from './net.ts';
import { sanitizeToolSchemas } from './schema.ts';

export const AGENTROUTER_PROVIDER = 'agentrouter';

/** 5xx 状态码属于上游渠道瞬时错误。 */
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

/**
 * 判定 400 是否为"渠道方言拒绝"（值得重发），而非真正的请求语法错误。
 */
function isTransientConversionError(body: string): boolean {
  return body.includes('must be passed back to the API') ||
    body.includes('upstream rejected the request as invalid') ||
    body.includes('null is not of type "array"') ||
    (body.includes('tool_use_id') && body.includes('tool_result'));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBodyText(body: import('undici').Dispatcher.ResponseData['body']): Promise<string> {
  let text = '';
  try {
    for await (const chunk of body) {
      text += (chunk as Buffer).toString('utf8');
    }
  } catch {
    // 忽略读取错误
  }
  return text;
}

function formatErrorMessage(status: number, errBody: string, quotaHint: string): string {
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
  if (status === 402 && quotaHint) {
    msg += `（${quotaHint}）`;
  }
  return msg;
}

function extractText(msg: RequestMessage): string {
  if (typeof (msg as any).content === 'string') return (msg as any).content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b: any) => b && b.type === 'text')
      .map((b: any) => b.text ?? '')
      .join('');
  }
  return '';
}

function extractReasoning(msg: RequestMessage): string {
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b: any) => b && b.type === 'reasoning')
      .map((b: any) => b.text ?? '')
      .join('');
  }
  return '';
}

function extractToolCalls(msg: RequestMessage): Array<{ id: string; name: string; arguments: string }> {
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b: any) => b && b.type === 'tool-call')
      .map((b: any) => ({
        id: String(b.id ?? ''),
        name: String(b.name ?? ''),
        arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}),
      }));
  }
  return [];
}

function safeParseJson(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * 生效的模型表：用户自定义列表（或中转站缓存 / 内置种子表）→ 用户按模型的协议覆盖。
 */
export function effectiveModels(
  cfg: AgentRouterConfig,
  models?: readonly AgentRouterModelInfo[],
): AgentRouterModelInfo[] {
  return applyProtocolOverrides(
    resolveActiveModels(effectiveModelIds(cfg) ?? models?.map(m => m.id)),
    cfg.modelProtocols,
  );
}

/**
 * 供设置卡片/诊断使用的模型清单投影。
 */
export function describeActiveModels(
  cfg: AgentRouterConfig,
  models?: readonly AgentRouterModelInfo[],
) {
  return effectiveModels(cfg, models).map(m => ({
    id: m.id,
    available: m.protocols ?? ['openai'],
    active: resolveModelProtocol(m, cfg.protocolPreference),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));
}

export interface AgentRouterAdapterOptions {
  resolveConfig: () => AgentRouterConfig;
  logger?: {
    info?(...args: unknown[]): void;
    warn?(...args: unknown[]): void;
    error?(...args: unknown[]): void;
  };
}

/**
 * 流式解码期间登记的一个已打开内容块。
 *
 * 需要在块结束时交出拼装好的内容：pi-ai 的 chunk 契约是
 * `block-start` → `*-delta` → **`block-end`**（带完整 block）。只发 delta 时
 * harness 的 BlockAssembler 仍能在流末尾兜底拼出结果，但「权威内容」就只剩
 * delta 拼接这一条来源；补上 block-end 才是契约内的形状。
 */
type OpenBlock =
  | { kind: 'text'; acc: string }
  | { kind: 'reasoning'; acc: string; signature?: string }
  | { kind: 'tool-call'; id: string; name: string; acc: string };

export class AgentRouterLlmAdapter extends LlmAdapter {
  private readonly resolveConfig: () => AgentRouterConfig;
  private readonly logger?: AgentRouterAdapterOptions['logger'];

  constructor(options: AgentRouterAdapterOptions) {
    super();
    this.resolveConfig = options.resolveConfig;
    this.logger = options.logger;
  }

  providerInfo(_provider: string): LlmProviderInfo {
    return {
      id: AGENTROUTER_PROVIDER,
      name: 'AgentRouter',
    };
  }

  providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    // 适配器内部已通过 silentRetry 控制渠道方言与 5xx 重试，
    // 此处设为 maxRetries: 0，避免外层 harness 产生指数级重试乘数。
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'dsh-agentrouter-connect retryPolicy');
  }

  async listModels(_provider: string): Promise<LlmModelInfo[]> {
    const cfg = this.resolveConfig();
    const active = effectiveModels(cfg);
    return active.map(m => ({
      provider: AGENTROUTER_PROVIDER,
      id: m.id,
      name: m.name,
      inputModalities: m.supportsImages ? ['text', 'image'] : ['text'],
    }));
  }

  async resolveModel(_provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const cfg = this.resolveConfig();
    const active = effectiveModels(cfg);
    const info = active.find(m => m.id === model) ?? fallbackModel(model);
    const reasoning = info.reasoning?.supports;

    const efforts = reasoning && info.reasoning?.supportedEfforts?.length
      ? info.reasoning.supportedEfforts
      : ['low', 'medium', 'high'];

    return {
      provider: AGENTROUTER_PROVIDER,
      id: info.id,
      name: info.name,
      inputModalities: info.supportsImages ? ['text', 'image'] : ['text'],
      context: { contextWindow: info.contextWindow },
      defaultMaxTokens: info.maxTokens,
      reasoning: reasoning ? {
        efforts: efforts.map((e: string) => ({ id: e as any, name: e })),
        defaultEffort: 'medium' as any,
      } : undefined,
    };
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const cfg = this.resolveConfig();
    if (!cfg.apiKey) {
      throw new LlmError(
        '未配置 AgentRouter API Key。请在「设置 → 插件 → AgentRouter」中填写，或在 .credentials.yaml 中配置 AGENTROUTER_API_KEY。',
        'AUTH',
        { status: 401 },
      );
    }

    const proxyCheck = validateProxyUrl(cfg.proxyUrl);
    if (!proxyCheck.ok) {
      throw new LlmError(`代理配置不可用：${proxyCheck.message}`, 'INVALID_PROXY');
    }

    const active = effectiveModels(cfg);
    const modelInfo = active.find(m => m.id === options.model) ?? fallbackModel(options.model);
    const protocol: AgentRouterProtocol = resolveModelProtocol(modelInfo, cfg.protocolPreference);

    const dispatcher = getDispatcherForEndpoint(cfg.endpoint, cfg.proxyUrl, cfg.directEndpoints);
    const userAgent = cfg.userAgent?.trim() || getAgentRouterUserAgent();

    let url: string;
    let headers: Record<string, string>;
    let payload: Record<string, unknown>;

    if (protocol === 'anthropic') {
      url = `${cfg.endpoint.replace(/\/+$/, '')}/messages`;
      headers = {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'User-Agent': userAgent,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      };
      payload = this.buildAnthropicPayload(options, modelInfo);
    } else {
      url = `${cfg.endpoint.replace(/\/+$/, '')}/chat/completions`;
      headers = {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'User-Agent': userAgent,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream, application/json',
      };
      payload = this.buildOpenAiPayload(options, modelInfo);
    }

    // 静默重发循环
    const maxAttempts = cfg.silentRetry ? cfg.silentRetryAttempts : 1;
    let upstreamRes: import('undici').Dispatcher.ResponseData | undefined;
    let lastErrorBody = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted' } } };
        return;
      }

      try {
        upstreamRes = await undiciRequest(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          dispatcher,
          signal: options.signal,
        });
      } catch (err: any) {
        if (options.signal?.aborted) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted' } } };
          return;
        }
        if (attempt < maxAttempts) {
          this.logger?.warn?.(`AgentRouter 网络请求异常，第 ${attempt + 1}/${maxAttempts} 次重发:`, err?.message || String(err));
          await delay(200 * attempt);
          continue;
        }
        throw new LlmError(`连接 AgentRouter 失败: ${err?.message || String(err)}`, 'NETWORK_ERROR', { cause: err });
      }

      if (upstreamRes.statusCode === 200) {
        break; // 成功，退出重发循环
      }

      const bodyText = await readBodyText(upstreamRes.body);
      lastErrorBody = bodyText;

      const isRetryable = RETRYABLE_STATUS.has(upstreamRes.statusCode) ||
        (upstreamRes.statusCode === 400 && isTransientConversionError(bodyText));

      if (isRetryable && attempt < maxAttempts) {
        this.logger?.warn?.(
          `AgentRouter 上游瞬时拒绝 (HTTP ${upstreamRes.statusCode})，第 ${attempt + 1}/${maxAttempts} 次重发:`,
          bodyText.slice(0, 200),
        );
        await delay(200 * attempt);
        continue;
      }

      // 不可重发或已用尽重试次数
      const formatted = formatErrorMessage(upstreamRes.statusCode, bodyText, cfg.quotaHint);
      const code = upstreamRes.statusCode === 401 ? 'AUTH'
        : upstreamRes.statusCode === 402 ? 'QUOTA'
        : upstreamRes.statusCode === 429 ? 'RATE_LIMIT'
        : 'UPSTREAM_ERROR';
      throw new LlmError(formatted, code, { status: upstreamRes.statusCode });
    }

    if (!upstreamRes || upstreamRes.statusCode !== 200) {
      const formatted = formatErrorMessage(upstreamRes?.statusCode ?? 500, lastErrorBody, cfg.quotaHint);
      throw new LlmError(formatted, 'UPSTREAM_ERROR', { status: upstreamRes?.statusCode });
    }

    const contentType = String(upstreamRes.headers['content-type'] ?? '');
    if (contentType.includes('text/html')) {
      await readBodyText(upstreamRes.body);
      throw new LlmError(
        'AgentRouter 返回了 HTML 网页而不是模型数据流（触发了上游阿里云 WAF 验证码风控）。请尝试在设置里将端点传输方式设为直连或更换端点。',
        'WAF_BLOCKED',
        { status: 502 },
      );
    }

    try {
      if (protocol === 'anthropic') {
        yield* this.streamAnthropic(upstreamRes.body, options.signal);
      } else {
        yield* this.streamOpenAi(upstreamRes.body, options.signal);
      }
    } finally {
      try {
        upstreamRes.body.destroy();
      } catch {
        // 忽略关闭异常
      }
    }
  }

  private buildOpenAiPayload(options: GenerateOptions, info: AgentRouterModelInfo): Record<string, unknown> {
    const messages: any[] = [];

    if (options.system && options.system.trim()) {
      messages.push({ role: 'system', content: options.system.trim() });
    }

    for (const msg of options.messages) {
      const role = (msg as any).role;
      if (role === 'system') {
        const text = extractText(msg);
        if (text) messages.push({ role: 'system', content: text });
      } else if (role === 'developer') {
        const text = extractText(msg);
        if (text) messages.push({ role: 'system', content: text }); // 改写 developer 为 system
      } else if (role === 'user') {
        messages.push({ role: 'user', content: extractText(msg) });
      } else if (role === 'assistant') {
        const text = extractText(msg);
        const reasoning = extractReasoning(msg);
        const toolCalls = extractToolCalls(msg);
        const item: any = { role: 'assistant', content: text || null };
        if (toolCalls.length > 0) {
          item.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        if (reasoning && info.thinkingFormat === 'deepseek') {
          item.reasoning_content = reasoning;
        }
        messages.push(item);
      } else if (role === 'tool') {
        const callId = (msg as any).toolCallId ?? (msg as any).source?.callId ?? '';
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          content: extractText(msg),
        });
      }
    }

    const payload: Record<string, unknown> = {
      model: info.id,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options.tools && options.tools.length > 0) {
      const tools = options.tools.map((t: any) => {
        const strict = t.strict ?? t.function?.strict ?? (typeof t.parameters === 'object' && t.parameters !== null ? t.parameters.strict : undefined);
        return {
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters ?? { type: 'object', properties: {} },
            ...(strict !== undefined ? { strict } : {}),
          },
          ...(strict !== undefined ? { strict } : {}),
        };
      });
      sanitizeToolSchemas({ tools });
      payload.tools = tools;
    }

    if (info.reasoning?.supports) {
      const effort = options.reasoningEffort ?? 'medium';
      if (effort !== 'off' && effort !== 'none') {
        payload.reasoning_effort = effort;
      }
    }

    if (options.temperature !== undefined) payload.temperature = options.temperature;
    if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens;
    if (options.stop && options.stop.length > 0) payload.stop = options.stop;

    return payload;
  }

  private buildAnthropicPayload(options: GenerateOptions, info: AgentRouterModelInfo): Record<string, unknown> {
    const systemParts: string[] = [];
    if (options.system && options.system.trim()) {
      systemParts.push(options.system.trim());
    }

    const rawMessages: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];

    for (const msg of options.messages) {
      const role = (msg as any).role;
      if (role === 'system' || role === 'developer') {
        const text = extractText(msg);
        if (text) systemParts.push(text);
      } else if (role === 'user') {
        rawMessages.push({
          role: 'user',
          content: [{ type: 'text', text: extractText(msg) }],
        });
      } else if (role === 'tool') {
        const callId = (msg as any).toolCallId ?? (msg as any).source?.callId ?? '';
        rawMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: callId,
            content: extractText(msg),
            ...((msg as any).isError ? { is_error: true } : {}),
          }],
        });
      } else if (role === 'assistant') {
        const text = extractText(msg);
        const reasoning = extractReasoning(msg);
        const toolCalls = extractToolCalls(msg);
        const blocks: any[] = [];
        if (reasoning) {
          // 查找该 assistant 消息的历史 replayState 里记录的真实签名
          const replayBlocks = (msg as any).source?.replayState?.blocks as Array<any> | undefined;
          const matchedBlock = replayBlocks?.find((b: any) => b?.type === 'thinking' && b.signature);
          const signature = matchedBlock?.signature || (msg as any).thinkingSignature;
          if (signature && typeof signature === 'string' && signature.trim()) {
            blocks.push({ type: 'thinking', thinking: reasoning, signature: signature.trim() });
          } else {
            // 无真实签名（如跨模型会话、未捕获签名的历史回合），按 Anthropic 规范降级为 text 块，
            // 绝不注入 'signature' 假字面量，避免上游 400 校验拒绝
            blocks.push({ type: 'text', text: reasoning });
          }
        }
        if (text) {
          blocks.push({ type: 'text', text });
        }
        for (const tc of toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: safeParseJson(tc.arguments),
          });
        }
        rawMessages.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
      }
    }

    // Anthropic 要求 user / assistant 严格交替出现：将连续同角色的消息合并
    const messages: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];
    for (const m of rawMessages) {
      if (messages.length > 0 && messages[messages.length - 1].role === m.role) {
        messages[messages.length - 1].content.push(...m.content);
      } else {
        messages.push({ role: m.role, content: [...m.content] });
      }
    }

    // Anthropic 要求首条消息必须是 user
    if (messages.length === 0 || messages[0].role !== 'user') {
      messages.unshift({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
    }

    const payload: Record<string, unknown> = {
      model: info.id,
      messages,
      max_tokens: options.maxTokens ?? info.maxTokens ?? 4096,
      stream: true,
    };

    if (systemParts.length > 0) {
      payload.system = systemParts.join('\n\n');
    }

    if (options.tools && options.tools.length > 0) {
      const tools = options.tools.map((t: any) => {
        const strict = t.strict ?? t.input_schema?.strict ?? (typeof t.parameters === 'object' && t.parameters !== null ? t.parameters.strict : undefined);
        return {
          name: t.name,
          description: t.description,
          input_schema: t.parameters ?? { type: 'object', properties: {} },
          ...(strict !== undefined ? { strict } : {}),
        };
      });
      sanitizeToolSchemas({ tools });
      payload.tools = tools;
    }

    if (info.reasoning?.supports) {
      const effort = options.reasoningEffort ?? 'medium';
      if (effort !== 'off' && effort !== 'none') {
        const maxTokens = typeof payload.max_tokens === 'number' ? payload.max_tokens : (info.maxTokens ?? 4096);
        let budget = 1024;
        if (effort === 'low') {
          budget = Math.max(1024, Math.min(2048, Math.floor(maxTokens * 0.25)));
        } else if (effort === 'high') {
          budget = Math.max(1024, Math.min(32768, Math.floor(maxTokens * 0.75)));
        } else {
          budget = Math.max(1024, Math.min(8192, Math.floor(maxTokens * 0.5)));
        }
        // Anthropic 约束：budget_tokens 必须严格小于 max_tokens
        if (budget >= maxTokens) {
          budget = Math.max(1024, maxTokens - 256);
        }
        if (maxTokens <= budget) {
          payload.max_tokens = budget + 1024;
        }
        if (budget >= 1024) {
          payload.thinking = { type: 'enabled', budget_tokens: budget };
        }
      }
    }

    if (options.temperature !== undefined) payload.temperature = options.temperature;
    if (options.stop && options.stop.length > 0) payload.stop_sequences = options.stop;

    return payload;
  }

  /**
   * 按块序关闭所有仍打开的块，产出对应的 block-end。
   * @param open - 块序索引 → 已打开块。
   */
  private *closeBlocks(open: Map<number, OpenBlock>): Generator<StreamChunk> {
    for (const [index, block] of [...open.entries()].sort((a, b) => a[0] - b[0])) {
      if (block.kind === 'text') {
        yield { type: 'block-end', index, block: { type: 'text', text: block.acc } };
      } else if (block.kind === 'reasoning') {
        yield { type: 'block-end', index, block: { type: 'reasoning', text: block.acc } };
      } else {
        yield {
          type: 'block-end',
          index,
          block: {
            type: 'tool-call',
            id: (block.id || 'call_' + index) as ToolCallId,
            name: block.name,
            arguments: block.acc,
          },
        };
      }
    }
    open.clear();
  }

  private async *streamOpenAi(
    body: import('undici').Dispatcher.ResponseData['body'],
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const onAbort = () => {
      try {
        body.destroy();
      } catch {}
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted' } } };
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let buffer = '';
    let nextBlockIdx = 0;
    let finishEmitted = false;
    let textIdx: number | undefined;
    let reasoningIdx: number | undefined;
    const open = new Map<number, OpenBlock>();
    const allBlocks: OpenBlock[] = [];
    // tool_calls[] 用自己的 index 编号，需要映射到内容块序号。
    const toolBlockOf = new Map<number, number>();

    const buildReplayState = (finishReason: string): ReplayEnvelope => ({
      response: { finish_reason: finishReason },
      blocks: allBlocks.map((b) => {
        if (b.kind === 'reasoning') return { type: 'reasoning', reasoning_content: b.acc };
        if (b.kind === 'tool-call') return { type: 'tool-call', id: b.id, name: b.name };
        return { type: 'text' };
      }),
    });

    try {
      for await (const chunk of body) {
        if (signal?.aborted) {
          yield* this.closeBlocks(open);
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted' } } };
          return;
        }

        buffer += (chunk as Buffer).toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') {
            yield* this.closeBlocks(open);
            // 有的兼容实现只发 [DONE] 不给 finish_reason；补一个终止事件，
            // 否则 harness 会把这次流转当成被截断。
            if (!finishEmitted) {
              finishEmitted = true;
              yield { type: 'finish', reason: { kind: 'stop' }, replayState: buildReplayState('stop') };
            }
            return;
          }

          try {
            const json = JSON.parse(dataStr);
            const choice = json.choices?.[0];
            const delta = choice?.delta;

            // 1. 思考 / 推理增量
            const reasoningContent = delta?.reasoning_content ?? delta?.reasoning;
            if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
              if (reasoningIdx === undefined) {
                reasoningIdx = nextBlockIdx++;
                const rb: OpenBlock = { kind: 'reasoning', acc: '' };
                open.set(reasoningIdx, rb);
                allBlocks.push(rb);
                yield { type: 'block-start', index: reasoningIdx, blockType: 'reasoning' };
              }
              const rb = open.get(reasoningIdx) as { kind: 'reasoning'; acc: string };
              rb.acc += reasoningContent;
              yield { type: 'reasoning-delta', index: reasoningIdx, text: reasoningContent };
            }

            // 2. 正文文本增量
            if (typeof delta?.content === 'string' && delta.content.length > 0) {
              if (textIdx === undefined) {
                textIdx = nextBlockIdx++;
                const tb2: OpenBlock = { kind: 'text', acc: '' };
                open.set(textIdx, tb2);
                allBlocks.push(tb2);
                yield { type: 'block-start', index: textIdx, blockType: 'text' };
              }
              const tb2 = open.get(textIdx) as { kind: 'text'; acc: string };
              tb2.acc += delta.content;
              yield { type: 'text-delta', index: textIdx, text: delta.content };
            }

            // 3. 工具调用增量
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const tcIndex = tc.index ?? 0;
                let bIdx = toolBlockOf.get(tcIndex);
                if (bIdx === undefined) {
                  bIdx = nextBlockIdx++;
                  toolBlockOf.set(tcIndex, bIdx);
                  const tcb: OpenBlock = { kind: 'tool-call', id: '', name: '', acc: '' };
                  open.set(bIdx, tcb);
                  allBlocks.push(tcb);
                  yield { type: 'block-start', index: bIdx, blockType: 'tool-call' };
                }
                const tb = open.get(bIdx) as { kind: 'tool-call'; id: string; name: string; acc: string };
                if (tc.id) tb.id = tc.id;
                if (tc.function?.name) tb.name = tc.function.name;
                const argsDelta: string = tc.function?.arguments ?? '';
                tb.acc += argsDelta;
                yield {
                  type: 'tool-call-delta',
                  index: bIdx,
                  id: (tb.id || 'call_' + tcIndex) as ToolCallId,
                  ...(tb.name ? { name: tb.name } : {}),
                  argumentsDelta: argsDelta,
                };
              }
            }

            // 4. Token 使用量
            if (json.usage) {
              yield {
                type: 'usage',
                usage: {
                  inputTokens: json.usage.prompt_tokens ?? 0,
                  outputTokens: json.usage.completion_tokens ?? 0,
                  totalTokens: json.usage.total_tokens ?? 0,
                },
              };
            }

            // 5. 结束原因：OpenAI 流里唯一可靠的「块结束」信号。
            if (choice?.finish_reason && !finishEmitted) {
              finishEmitted = true;
              yield* this.closeBlocks(open);
              const fr = choice.finish_reason;
              yield {
                type: 'finish',
                reason: fr === 'tool_calls' ? { kind: 'tool-calls' }
                  : fr === 'length' ? { kind: 'max-tokens' }
                  : { kind: 'stop' },
                replayState: buildReplayState(fr),
              };
            }
          } catch {
            // 忽略单行解析失败
          }
        }
      }

      // 流在没有终止事件的情况下结束：仍然把已打开的块收口。
      yield* this.closeBlocks(open);
      if (!finishEmitted) {
        finishEmitted = true;
        yield { type: 'finish', reason: { kind: 'stop' }, replayState: buildReplayState('stop') };
      }
    } catch (err: any) {
      if (signal?.aborted) {
        yield* this.closeBlocks(open);
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted' } } };
        return;
      }
      throw err;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      onAbort();
    }
  }

  private async *streamAnthropic(
    body: import('undici').Dispatcher.ResponseData['body'],
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const onAbort = () => {
      try {
        body.destroy();
      } catch {}
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted' } } };
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let buffer = '';
    let currentEvent = '';
    let nextBlockIdx = 0;
    let finishEmitted = false;
    const open = new Map<number, OpenBlock>();
    const allBlocks: OpenBlock[] = [];

    const buildReplayState = (stopReason: string): ReplayEnvelope => ({
      response: { stop_reason: stopReason },
      blocks: allBlocks.map((b) => {
        if (b.kind === 'reasoning') return { type: 'thinking', signature: b.signature };
        if (b.kind === 'tool-call') return { type: 'tool-call', id: b.id, name: b.name };
        return { type: 'text' };
      }),
    });

    try {
      for await (const chunk of body) {
        if (signal?.aborted) {
          yield* this.closeBlocks(open);
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted' } } };
          return;
        }

        buffer += (chunk as Buffer).toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            try {
              const json = JSON.parse(dataStr);

              if (currentEvent === 'content_block_start') {
                const b = json.content_block;
                const index = json.index ?? nextBlockIdx;
                if (b?.type === 'text') {
                  const tb: OpenBlock = { kind: 'text', acc: '' };
                  open.set(index, tb);
                  allBlocks.push(tb);
                  yield { type: 'block-start', index, blockType: 'text' };
                } else if (b?.type === 'thinking') {
                  const rb: OpenBlock = { kind: 'reasoning', acc: '', signature: b.signature ?? '' };
                  open.set(index, rb);
                  allBlocks.push(rb);
                  yield { type: 'block-start', index, blockType: 'reasoning' };
                } else if (b?.type === 'tool_use') {
                  const tcb: OpenBlock = { kind: 'tool-call', id: b.id ?? '', name: b.name ?? '', acc: '' };
                  open.set(index, tcb);
                  allBlocks.push(tcb);
                  yield { type: 'block-start', index, blockType: 'tool-call' };
                }
                nextBlockIdx = Math.max(nextBlockIdx, index + 1);
              } else if (currentEvent === 'content_block_delta') {
                const d = json.delta;
                const index = json.index ?? 0;
                const block = open.get(index);
                if (d?.type === 'text_delta') {
                  if (block?.kind === 'text') block.acc += d.text ?? '';
                  yield { type: 'text-delta', index, text: d.text ?? '' };
                } else if (d?.type === 'thinking_delta') {
                  if (block?.kind === 'reasoning') block.acc += d.thinking ?? '';
                  yield { type: 'reasoning-delta', index, text: d.thinking ?? '' };
                } else if (d?.type === 'signature_delta') {
                  if (block?.kind === 'reasoning') {
                    block.signature = (block.signature ?? '') + (d.signature ?? '');
                  }
                } else if (d?.type === 'input_json_delta') {
                  const argsDelta: string = d.partial_json ?? '';
                  if (block?.kind === 'tool-call') block.acc += argsDelta;
                  yield {
                    type: 'tool-call-delta',
                    index,
                    id: ((block?.kind === 'tool-call' && block.id) || 'call_' + index) as ToolCallId,
                    ...(block?.kind === 'tool-call' && block.name ? { name: block.name } : {}),
                    argumentsDelta: argsDelta,
                  };
                }
              } else if (currentEvent === 'content_block_stop') {
                // 上游逐块给出结束信号 —— 这是块结束的权威位置。
                const index = json.index ?? 0;
                const block = open.get(index);
                if (block !== undefined) {
                  open.delete(index);
                  yield* this.closeBlocks(new Map<number, OpenBlock>([[index, block]]));
                }
              } else if (currentEvent === 'message_delta') {
                if (json.usage) {
                  yield {
                    type: 'usage',
                    usage: {
                      inputTokens: json.usage.input_tokens ?? 0,
                      outputTokens: json.usage.output_tokens ?? 0,
                      totalTokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
                    },
                  };
                }
                if (json.delta?.stop_reason && !finishEmitted) {
                  finishEmitted = true;
                  yield* this.closeBlocks(open);
                  const sr = json.delta.stop_reason;
                  yield {
                    type: 'finish',
                    reason: sr === 'tool_use' ? { kind: 'tool-calls' }
                      : sr === 'max_tokens' ? { kind: 'max-tokens' }
                      : { kind: 'stop' },
                    replayState: buildReplayState(sr),
                  };
                }
              }
            } catch {
              // 忽略单行解析失败
            }
          }
        }
      }

      yield* this.closeBlocks(open);
      if (!finishEmitted) {
        finishEmitted = true;
        yield { type: 'finish', reason: { kind: 'stop' }, replayState: buildReplayState('stop') };
      }
    } catch (err: any) {
      if (signal?.aborted) {
        yield* this.closeBlocks(open);
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted' } } };
        return;
      }
      throw err;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      onAbort();
    }
  }
}
