/**
 * AgentRouter model catalog definition for DeepSeek Harness.
 *
 * The relay's catalog is dynamic: models come and go with upstream capacity,
 * and `/v1/models` is the only authority on what is actually served. The list
 * below is therefore a *seed* — the ids the relay answered with when it was
 * last verified — not a claim about today. `fetchRelayModels()` refreshes it
 * from the relay itself; the seed is what a fresh install shows before the
 * first successful refresh, and what a deployment with no key falls back to.
 *
 * Verified against `https://ps.air-outer.com/v1/models` on 2026-10-10:
 * `claude-opus-4-8`, `claude-opus-5`, `deepseek-v4-flash`, `gpt-6-astra`.
 */

/**
 * 中转站为每个模型提供的协议端点类型。
 *  - `openai`    → `/v1/chat/completions`
 *  - `anthropic` → `/v1/messages`
 */
export type AgentRouterProtocol = 'openai' | 'anthropic';

export interface AgentRouterModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages?: boolean;
  reasoning?: {
    supports?: boolean;
    canDisableThinking?: boolean;
    supportedEfforts?: readonly string[];
  };
  /**
   * 该模型在中转站上游实际使用的思考协议（仅 OpenAI 协议路径下有意义）。
   *
   * 默认 `openai`（只发顶层 `reasoning_effort`）。DeepSeek 系模型在上游走
   * DeepSeek 兼容思考协议：需要额外发 `thinking` 字段，并且**回放的 assistant
   * 消息必须带 `reasoning_content`**，否则一旦历史里出现过工具调用，上游就会
   * 拒绝整个请求（400 "content[].thinking ... must be passed back"）。
   *
   * pi-ai 无法自行推断：它按 baseURL 识别 DeepSeek，而这里指向的是中转站主机。
   */
  thinkingFormat?: 'openai' | 'deepseek';
  /**
   * 该模型在中转站**可用**的协议端点类型（来自中转站控制台的「可用端点类型」）。
   *
   * 这是解决 `content[].thinking must be passed back` 的一条路径：
   * Anthropic 协议的 thinking 块带 `signature` 字段，必须原样回传；而 OpenAI
   * 协议只把推理字段名当作签名，落到 Anthropic 形态的上游渠道时该签名无效。
   * 走 Anthropic 原生端点可避免这次有损转换。
   *
   * 未声明时按 `['openai']` 处理，并交给 `resolveModelProtocol` 择优。
   */
  protocols?: readonly AgentRouterProtocol[];
  /**
   * 用户为该模型选定的协议；未设置时按 {@link protocols} 自动择优。
   */
  preferredProtocol?: AgentRouterProtocol;
}

/**
 * 协议择优的默认策略。
 *
 * `anthropic-first`（默认）适合需要 thinking 签名原样往返的场景；
 * `openai-first` 适合中转站的 Anthropic 端点不稳定、或用户明确希望所有模型
 * 走同一条 OpenAI 通路的场景（参考实现 aqiu817/dsh-llm-agentrouter 即如此）。
 */
export type AgentRouterProtocolPreference = 'anthropic-first' | 'openai-first';

/**
 * 内置种子模型表 —— **与中转站实测在售列表保持同步**。
 *
 * 上下文窗口 / 最大输出取自中转站返回值约束与实测；`protocols` 取自控制台
 * 「可用端点类型」标注。模型上下线由上游资源决定，请以设置卡片里的
 * 「刷新模型列表」或控制台为准。
 */
export const AGENTROUTER_DEFAULT_MODELS: readonly AgentRouterModelInfo[] = [
  {
    id: 'claude-opus-5',
    name: 'claude-opus-5',
    contextWindow: 1000000,
    maxTokens: 128000,
    // 图片输入未经实测；保守声明为纯文本，避免消息持久化后才被上游拒绝。
    supportsImages: false,
    protocols: ['anthropic', 'openai'],
    reasoning: {
      supports: true,
      canDisableThinking: true,
      supportedEfforts: ['low', 'medium', 'high'],
    },
  },
  {
    id: 'claude-opus-4-8',
    name: 'claude-opus-4-8',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImages: false,
    protocols: ['anthropic', 'openai'],
    reasoning: {
      supports: true,
      canDisableThinking: true,
      supportedEfforts: ['low', 'medium', 'high'],
    },
  },
  {
    id: 'deepseek-v4-flash',
    name: 'deepseek-v4-flash',
    contextWindow: 1000000,
    maxTokens: 256000,
    supportsImages: false,
    protocols: ['anthropic', 'openai'],
    // 上游把它路由到 DeepSeek 兼容思考通道，但主机名是中转站自己的，
    // pi-ai 无法按 URL 推断，必须在此显式声明（否则走默认 openai 形状，
    // 回放不带 reasoning_content，一旦历史有工具调用就被上游拒绝）。
    thinkingFormat: 'deepseek',
    reasoning: {
      supports: true,
      canDisableThinking: true,
      supportedEfforts: ['low', 'medium', 'high'],
    },
  },
  {
    id: 'gpt-6-astra',
    name: 'gpt-6-astra',
    contextWindow: 272000,
    maxTokens: 128000,
    supportsImages: false,
    // 中转站控制台标注：仅 openai 端点（无 anthropic）。
    protocols: ['openai'],
    reasoning: {
      supports: true,
      canDisableThinking: true,
      supportedEfforts: ['low', 'medium', 'high'],
    },
  },
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
function inferModelTraits(idLower: string): Pick<AgentRouterModelInfo, 'contextWindow' | 'maxTokens' | 'reasoning' | 'thinkingFormat' | 'protocols'> {
  const isReasoning =
    idLower.includes('reason') ||
    idLower.includes('r1') ||
    idLower.includes('o1') ||
    idLower.includes('o3') ||
    idLower.includes('v4') ||
    idLower.includes('qwq') ||
    idLower.includes('thinking') ||
    idLower.includes('opus') ||
    idLower.includes('astra');

  const isDeepSeekFamily = idLower.includes('deepseek');

  const contextWindow =
    idLower.includes('gemini') || idLower.includes('1m') ? 1000000 :
    idLower.includes('opus') || idLower.includes('deepseek') || idLower.includes('gpt-6') ? 1000000 :
    idLower.includes('gpt-5') ? 272000 :
    200000;

  return {
    contextWindow,
    maxTokens: FALLBACK_MAX_TOKENS,
    ...(isReasoning ? {
      reasoning: {
        supports: true,
        canDisableThinking: !idLower.includes('r1'),
        supportedEfforts: ['low', 'medium', 'high'],
      },
    } : {}),
    ...(isDeepSeekFamily ? { thinkingFormat: 'deepseek' as const } : {}),
    // 未知 id 不猜协议：交给用户在中转站控制台确认后于卡片里选择。
    protocols: ['openai'],
  };
}

/**
 * 把一份 id 列表解析成完整的模型信息表。
 *
 * 种子表里有的 id 直接复用其（实测校订过的）参数；其余按 id 推断。
 * @param customModelIds - 用户配置或中转站返回的模型 id 列表。
 * @returns 去重后的模型信息表。
 */
export function resolveActiveModels(customModelIds?: string[]): AgentRouterModelInfo[] {
  if (!customModelIds || customModelIds.length === 0) {
    return [...AGENTROUTER_DEFAULT_MODELS];
  }

  const modelMap = new Map<string, AgentRouterModelInfo>();
  for (const m of AGENTROUTER_DEFAULT_MODELS) {
    modelMap.set(m.id.toLowerCase(), m);
  }

  const seen = new Set<string>();
  const results: AgentRouterModelInfo[] = [];

  for (const rawId of customModelIds) {
    const id = rawId.trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());

    const existing = modelMap.get(id.toLowerCase());
    if (existing) {
      results.push({
        ...existing,
        id, // keep casing user provided
      });
      continue;
    }

    results.push({
      id,
      name: id,
      supportsImages: false,
      ...inferModelTraits(id.toLowerCase()),
    });
  }

  return results.length > 0 ? results : [...AGENTROUTER_DEFAULT_MODELS];
}

/**
 * 为未知模型 ID 生成推断兜底信息。
 * @param id - 模型 ID。
 * @returns 兜底模型信息。
 */
export function fallbackModel(id: string): AgentRouterModelInfo {
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
export function resolveModelProtocol(
  info: AgentRouterModelInfo,
  preference: AgentRouterProtocolPreference = 'anthropic-first',
): AgentRouterProtocol {
  const available = info.protocols ?? ['openai'];
  if (info.preferredProtocol && available.includes(info.preferredProtocol)) {
    return info.preferredProtocol;
  }
  const ranked: readonly AgentRouterProtocol[] = preference === 'openai-first'
    ? ['openai', 'anthropic']
    : ['anthropic', 'openai'];
  for (const protocol of ranked) {
    if (available.includes(protocol)) return protocol;
  }
  return 'openai';
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
export function applyProtocolOverrides(
  list: AgentRouterModelInfo[],
  overrides: Record<string, AgentRouterProtocol> | undefined,
): AgentRouterModelInfo[] {
  if (!overrides) return list;
  return list.map((m) => {
    const want = overrides[m.id.toLowerCase()];
    if (!want) return m;
    const available = m.protocols ?? ['openai'];
    // 只在模型确实支持该协议时才覆盖，否则保持自动择优。
    return available.includes(want) ? { ...m, preferredProtocol: want } : m;
  });
}
