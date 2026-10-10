// dsh-agentrouter-connect client half (browser).
//
// Registers a native settings form for this plugin's own Config namespace,
// following the shape the harness's own pages use: the Host publishes the
// namespace (it declares a volatile Config), `configForms.whileServed` mounts
// the page only while that namespace is served, and the page renders through
// the shared `SettingsForm`/`SettingsValueField` primitives.
//
// The API key is not a settings field at all. The section names a credential
// *reference* (`apiKeyEnv`), the key itself lives in the credential store
// (`~/.dsh/.credentials.yaml` or the environment), and the page reads only
// whether one is configured and writes it through the credentials domain — a
// value that crosses the wire in one direction only.
import type { Context } from '@deepseek-ai/cordis';

type ReactApi = {
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
  useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
  useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void;
  useRef: <S>(initial: S) => { current: S };
};

const R = require('react') as ReactApi;
const P = require('@deepseek-ai/dsh-client-ui-primitives') as {
  SettingsForm: (props: Record<string, unknown>) => unknown;
  SettingsValueField: (props: Record<string, unknown>) => unknown;
  SettingsSecretField: (props: Record<string, unknown>) => unknown;
  Switch: (props: Record<string, unknown>) => unknown;
  SegmentedControl: (props: Record<string, unknown>) => unknown;
  SettingsFormModel: new (scope: unknown, specs: unknown[], secrets?: unknown[]) => any;
  settingsTextField: (field: string) => unknown;
  settingsNumberField: (field: string) => unknown;
};
const { createElement: h } = R;

export const name = 'dsh-agentrouter-connect-client';
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials'];

/** 本插件在 profile 补丁里的 entry id —— 也就是它的设置命名空间。 */
const NAMESPACE = 'llm-agentrouter';

/** 页面字典命名空间。 */
const LOCALE_NS = 'settings.agentrouter';

/** 凭据引用的兜底名字（与 Host 的 DEFAULT_API_KEY_REF 一致）。 */
const DEFAULT_API_KEY_REF = 'AGENTROUTER_API_KEY';

interface LocaleReader {
  (key: string): string;
}

const zh: Record<string, string> = {
  title: 'AgentRouter 聚合代理',
  description: '把 AgentRouter 中转站接入 DSH：端点、代理、模型目录与重试策略。',
  apiKey: 'API Key',
  apiKeyHint: '密钥保存在凭据存储（.credentials.yaml 或同名环境变量），不写入设置文件、也不随响应回传。留空表示保持当前密钥。',
  apiKeySet: '已配置密钥',
  apiKeyUnset: '未配置密钥',
  apiKeyEnv: '凭据引用名',
  apiKeyEnvHint: '密钥从这个名字解析：环境变量，或 .credentials.yaml 的 refs 段。默认 AGENTROUTER_API_KEY。',
  proxy: '网络代理地址',
  proxyHint: 'Clash/Mihomo 的 HTTP 端口，例如 http://127.0.0.1:7897；填 direct 表示直连。不支持 SOCKS。',
  endpoint: 'API 端点',
  endpointHint: '国内源站 https://ps.air-outer.com/v1 直连可达且绕开 WAF；国际源站 agentrouter.org 需要代理。',
  direct: '端点传输方式',
  directHint: '选「自动」时，代理对国内端点不生效（绕开 WAF 对代理出口 IP 的质询）。',
  directAuto: '自动',
  directNone: '全部走代理',
  directAlways: '全部直连',
  preference: '协议择优策略',
  preferenceHint: 'anthropic-first 优先 /v1/messages（thinking 块带签名，回放无损）；openai-first 全部走 /v1/chat/completions。',
  preferenceAnthropic: 'Anthropic 优先',
  preferenceOpenAI: 'OpenAI 优先',
  models: '模型列表',
  modelsHint: '一行一个模型 id。留空则用中转站实测缓存，再回落到内置种子表；你填了就以你填的为准。',
  autoRefresh: '启动时同步模型目录',
  autoRefreshHint: '用中转站 /v1/models 的真实在售列表刷新上面的模型列表。',
  silentRetry: '渠道抖动自动重发',
  silentRetryHint: '中转站把一个模型轮询到多个上游渠道，渠道方言不一致时会回普通 400；打开后由回环服务重发。',
  retryAttempts: '最大发送次数',
  retryAttemptsHint: '单次请求最多发送几次（含首次），1–10。',
  quotaHint: '配额提示文案',
  quotaHintHint: '402 配额错误后追加的提示；留空关闭。',
  userAgent: 'User-Agent 标识',
  userAgentHint: '留空使用官方支持的 pi (平台 版本; 架构)。中转站按此标识放行与计费。',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalidNumber: '请填 1–10 之间的整数。',
  modelsPlaceholder: 'claude-opus-5\ndeepseek-v4-flash\ngpt-6-astra',
  test: '测试连接',
  testing: '测试中…',
  testHint: '按当前已保存的配置向上游发一次真实请求（/v1/models）。需要先保存再测试。',
};

const en: Record<string, string> = {
  title: 'AgentRouter relay',
  description: 'Connect the AgentRouter relay to DSH: endpoint, proxy, model catalog, and retry policy.',
  apiKey: 'API key',
  apiKeyHint: 'The key lives in the credential store (.credentials.yaml or an environment variable), never in the settings file and never in a response. Leave blank to keep the current key.',
  apiKeySet: 'A key is configured',
  apiKeyUnset: 'No key is configured',
  apiKeyEnv: 'Credential reference',
  apiKeyEnvHint: 'The name the key is resolved from: an environment variable, or the refs section of .credentials.yaml. Defaults to AGENTROUTER_API_KEY.',
  proxy: 'Network proxy',
  proxyHint: 'The Clash/Mihomo HTTP port, e.g. http://127.0.0.1:7897; enter direct to connect directly. SOCKS is not supported.',
  endpoint: 'API endpoint',
  endpointHint: 'The domestic origin https://ps.air-outer.com/v1 is directly reachable and bypasses the WAF; agentrouter.org needs a proxy.',
  direct: 'Endpoint transport',
  directHint: 'With "auto" the proxy does not apply to the domestic endpoint (the WAF challenges proxy egress IPs).',
  directAuto: 'Auto',
  directNone: 'Always proxy',
  directAlways: 'Always direct',
  preference: 'Protocol preference',
  preferenceHint: 'anthropic-first prefers /v1/messages (thinking blocks carry a signature, so replay is lossless); openai-first sends everything to /v1/chat/completions.',
  preferenceAnthropic: 'Anthropic first',
  preferenceOpenAI: 'OpenAI first',
  models: 'Model list',
  modelsHint: 'One model id per line. Blank falls back to the relay-verified cache, then to the built-in seed list; anything you type wins.',
  autoRefresh: 'Sync the catalog at startup',
  autoRefreshHint: "Refresh the list above from the relay's real /v1/models answer.",
  silentRetry: 'Re-send channel flapping',
  silentRetryHint: 'The relay round-robins one model across channels that disagree on dialect and answer a plain 400; the loopback service re-sends.',
  retryAttempts: 'Max sends',
  retryAttemptsHint: 'How many times one request may be sent, the first included (1–10).',
  quotaHint: 'Quota hint',
  quotaHintHint: 'Appended to 402 quota errors; leave blank to disable.',
  userAgent: 'User-Agent identity',
  userAgentHint: 'Blank uses the officially supported pi (platform release; arch). The relay admits and bills by this identity.',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  invalidNumber: 'Enter a whole number between 1 and 10.',
  modelsPlaceholder: 'claude-opus-5\ndeepseek-v4-flash\ngpt-6-astra',
  test: 'Test connection',
  testing: 'Testing…',
  testHint: 'Send one real request (/v1/models) upstream with the saved configuration. Save first, then test.',
};

function formLabels(t: LocaleReader) {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  };
}

interface SettingsScope {
  getSnapshot(): {
    status: string;
    writable: boolean;
    value?: Record<string, unknown>;
    base?: Record<string, unknown>;
    user?: Record<string, unknown>;
    revision?: number;
  };
  subscribe(listener: () => void): () => void;
}

/**
 * AgentRouter 设置卡片。
 *
 * `props.view === 'summary'` 时只画一行说明（「插件」页列表用），否则画完整表单。
 * 表单由宿主原语渲染，一次保存只写一次设置文档。
 * @param props - 视图、字典、表单快照与动作。
 */
function AgentRouterCard(props: Record<string, any>): unknown {
  const { t } = props as { t: LocaleReader };
  const [test, setTest] = R.useState<{ busy: boolean; ok?: boolean; message?: string }>({ busy: false });
  const state = props.useAgentRouterCard((snapshot: unknown) => snapshot) as Record<string, any>;
  if (props.view === 'summary') return t('description');
  const disabled = !state.writable;

  const valueField = (field: string, label: string, hint: string, extra: Record<string, unknown> = {}) =>
    h(P.SettingsValueField, {
      id: `plugin-config-agentrouter-${field}`,
      key: field,
      label,
      hint,
      overriddenLabel: t('overridden'),
      resetLabel: t('reset'),
      invalidLabel: t('invalidNumber'),
      disabled,
      ...(state[field] as Record<string, unknown>),
      onEdit: (text: string) => props.edit(field, text),
      onReset: () => props.resetField(field),
      ...extra,
    });

  return h(P.SettingsForm, {
    labels: formLabels(t),
    state,
    onSave: props.save,
    onDiscard: props.discard,
  },
    h(P.SettingsSecretField, {
      key: 'apiKey',
      id: 'plugin-config-agentrouter-api-key',
      label: t('apiKey'),
      hint: t('apiKeyHint'),
      disabled: !state.apiKeyWritable,
      text: state.apiKey?.text ?? '',
      configured: state.apiKeyConfigured,
      stateLabel: state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset'),
      onEdit: (text: string) => props.edit('apiKey', text),
    }),
    valueField('apiKeyEnv', t('apiKeyEnv'), t('apiKeyEnvHint')),
    valueField('proxy', t('proxy'), t('proxyHint')),
    valueField('endpoint', t('endpoint'), t('endpointHint')),
    h('div', { key: 'direct', style: { margin: '10px 0' } },
      h('div', { style: { marginBottom: '4px', fontWeight: 600, fontSize: '12px' } }, t('direct')),
      h(P.SegmentedControl, {
        id: 'plugin-config-agentrouter-direct',
        value: state.directEndpointsValue,
        disabled,
        label: t('direct'),
        options: [
          { value: 'auto', label: t('directAuto') },
          { value: 'none', label: t('directNone') },
          { value: 'always', label: t('directAlways') },
        ],
        onChange: (next: string) => props.edit('directEndpoints', next),
      }),
      h('p', { style: { fontSize: '11px', opacity: 0.7, marginTop: '4px' } }, t('directHint')),
    ),
    h('div', { key: 'preference', style: { margin: '10px 0' } },
      h('div', { style: { marginBottom: '4px', fontWeight: 600, fontSize: '12px' } }, t('preference')),
      h(P.SegmentedControl, {
        id: 'plugin-config-agentrouter-preference',
        value: state.protocolPreferenceValue,
        disabled,
        label: t('preference'),
        options: [
          { value: 'anthropic-first', label: t('preferenceAnthropic') },
          { value: 'openai-first', label: t('preferenceOpenAI') },
        ],
        onChange: (next: string) => props.edit('protocolPreference', next),
      }),
      h('p', { style: { fontSize: '11px', opacity: 0.7, marginTop: '4px' } }, t('preferenceHint')),
    ),
    h('div', { key: 'models', style: { margin: '10px 0' } },
      h('label', {
        htmlFor: 'plugin-config-agentrouter-models',
        style: { display: 'block', fontWeight: 600, fontSize: '12px', marginBottom: '4px' },
      }, t('models')),
      h('textarea', {
        id: 'plugin-config-agentrouter-models',
        value: state.customModelsText ?? '',
        placeholder: t('modelsPlaceholder'),
        disabled,
        rows: 6,
        style: { width: '100%', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '12px', boxSizing: 'border-box' },
        onChange: (event: { target: { value: string } }) => props.edit('customModels', event.target.value),
      }),
      h('p', { style: { fontSize: '11px', opacity: 0.7, marginTop: '4px' } }, t('modelsHint')),
    ),
    h('div', { key: 'autoRefresh', style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '10px 0' } },
      h(P.Switch, {
        checked: state.autoRefreshValue === true,
        disabled,
        label: t('autoRefresh'),
        onChange: (next: boolean) => props.edit('autoRefreshModels', next ? 'true' : 'false'),
      }),
      h('div', null,
        h('div', { style: { fontWeight: 600, fontSize: '12px' } }, t('autoRefresh')),
        h('div', { style: { fontSize: '11px', opacity: 0.7 } }, t('autoRefreshHint')),
      ),
    ),
    h('div', { key: 'silentRetry', style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '10px 0' } },
      h(P.Switch, {
        checked: state.silentRetryValue === true,
        disabled,
        label: t('silentRetry'),
        onChange: (next: boolean) => props.edit('silentRetry', next ? 'true' : 'false'),
      }),
      h('div', null,
        h('div', { style: { fontWeight: 600, fontSize: '12px' } }, t('silentRetry')),
        h('div', { style: { fontSize: '11px', opacity: 0.7 } }, t('silentRetryHint')),
      ),
    ),
    valueField('silentRetryAttempts', t('retryAttempts'), t('retryAttemptsHint'), { numeric: true }),
    valueField('quotaHint', t('quotaHint'), t('quotaHintHint')),
    valueField('userAgent', t('userAgent'), t('userAgentHint')),
    // 测试连接：唯一需要服务端参与的诊断 —— 浏览器发不出中转站要求的
    // User-Agent（禁用头），只能用服务端已保存的配置探测。该接口无参数，
    // 因此不构成 SSRF 面，也不回传密钥。
    h('div', { key: 'test', style: { margin: '10px 0' } },
      h('button', {
        type: 'button',
        disabled: test.busy,
        onClick: () => {
          setTest({ busy: true });
          void (async () => {
            try {
              const res = await fetch('/plugins/agentrouter/test', { method: 'POST' });
              const data = await res.json() as { ok: boolean; message: string };
              setTest({ busy: false, ok: data.ok, message: data.message });
            } catch (e: any) {
              setTest({ busy: false, ok: false, message: e?.message || '测试请求失败' });
            }
          })();
        },
      }, test.busy ? t('testing') : t('test')),
      h('p', { style: { fontSize: '11px', opacity: 0.7, marginTop: '4px' } }, t('testHint')),
      test.message
        ? h('p', {
            style: {
              fontSize: '12px',
              marginTop: '6px',
              color: test.ok ? '#065f46' : '#991b1b',
            },
          }, test.message)
        : null,
    ),
  );
}

/**
 * 卡片控制器：把插件设置命名空间与凭据域桥接到页面表单上。
 *
 * 大部分字段是 `.volatile()`，宿主把它们作为**引用单元**交给 Host 半边；设置写入
 * 原地更新单元而不重载 fiber，因此表单每次读取都必须解包取当前值。
 */
class AgentRouterCardController {
  scope: SettingsScope;
  ctx: any;
  form: any;
  store: any;
  credential = { ref: '', configured: false, writable: true };
  unsubscribe: () => void;

  constructor(scope: SettingsScope, ctx: any) {
    this.scope = scope;
    this.ctx = ctx;
    this.form = new P.SettingsFormModel(
      scope,
      [
        liveSpec(P.settingsTextField('apiKeyEnv') as { format: (value: unknown) => string }),
        liveSpec(P.settingsTextField('proxy') as { format: (value: unknown) => string }),
        liveSpec(P.settingsTextField('endpoint') as { format: (value: unknown) => string }),
        liveSpec(P.settingsTextField('userAgent') as { format: (value: unknown) => string }),
        liveSpec(P.settingsNumberField('silentRetryAttempts') as { format: (value: unknown) => string }),
        liveSpec(P.settingsTextField('quotaHint') as { format: (value: unknown) => string }),
        // 结构化字段：设置文档里是数组 / 布尔 / 枚举，控件是文本、开关与分段控件，
        // 因此在这里做双向转换（空串表示清除，回到 schema 默认值）。
        liveSpec({
          field: 'customModels',
          format: (value: unknown) => (Array.isArray(value) ? value.join('\n') : ''),
          parse: (text: string) => {
            const ids = text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
            return ids.length === 0 ? { kind: 'clear' } : { kind: 'set', value: ids };
          },
        }),
        liveSpec({
          field: 'autoRefreshModels',
          format: (value: unknown) => (value === true ? 'true' : 'false'),
          parse: (text: string) => ({ kind: 'set', value: text === 'true' }),
        }),
        liveSpec({
          field: 'silentRetry',
          format: (value: unknown) => (value === true ? 'true' : 'false'),
          parse: (text: string) => ({ kind: 'set', value: text === 'true' }),
        }),
        liveSpec({
          field: 'directEndpoints',
          format: (value: unknown) => (typeof value === 'string' ? value : 'auto'),
          parse: (text: string) => ({ kind: 'set', value: text }),
        }),
        liveSpec({
          field: 'protocolPreference',
          format: (value: unknown) => (typeof value === 'string' ? value : 'anthropic-first'),
          parse: (text: string) => ({ kind: 'set', value: text }),
        }),
      ],
      [{
        field: 'apiKey',
        write: (text: string) => this.writeKey(text),
      }],
    );
    this.store = this.form.bind(() => this.projection());
    this.unsubscribe = scope.subscribe(() => {
      void this.readCredential();
    });
    void this.readCredential();
  }

  /** 读取命名空间里某个字段的当前生效值（自动解包 volatile 引用）。 */
  read(field: string): unknown {
    const raw = this.scope.getSnapshot().value?.[field];
    return unwrap(raw);
  }

  projection(): Record<string, any> {
    return {
      ...this.form.shell(),
      apiKeyEnv: this.form.field('apiKeyEnv'),
      proxy: this.form.field('proxy'),
      endpoint: this.form.field('endpoint'),
      userAgent: this.form.field('userAgent'),
      silentRetryAttempts: this.form.field('silentRetryAttempts'),
      quotaHint: this.form.field('quotaHint'),
      // `form.field()` 返回 { text, overridden, invalid } —— textarea 需要的是
      // 里面的 text，直接塞整个对象就会渲染成 [object Object]。
      customModelsText: (this.form.field('customModels') as { text?: string })?.text ?? '',
      // 开关/分段控件需要原始值而不是草稿文本，因此单独投影一份。
      autoRefreshValue: this.currentBoolean('autoRefreshModels', true),
      silentRetryValue: this.currentBoolean('silentRetry', true),
      directEndpointsValue: this.currentEnum('directEndpoints', 'auto'),
      protocolPreferenceValue: this.currentEnum('protocolPreference', 'anthropic-first'),
      apiKey: this.form.field('apiKey'),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
    };
  }

  /** 草稿优先、否则读当前生效值 —— 控件显示的是「保存后会是什么」。 */
  private currentBoolean(field: string, fallback: boolean): boolean {
    const staged = this.form.field(field) as { text?: string };
    if (typeof staged?.text === 'string' && staged.text !== '') return staged.text === 'true';
    const live = this.read(field);
    return typeof live === 'boolean' ? live : fallback;
  }

  private currentEnum(field: string, fallback: string): string {
    const staged = this.form.field(field) as { text?: string };
    if (typeof staged?.text === 'string' && staged.text !== '') return staged.text;
    const live = this.read(field);
    return typeof live === 'string' ? live : fallback;
  }

  inject() {
    return {
      hooks: { agentRouterCard: this.store },
      ...this.form.actions(),
    };
  }

  /**
   * 询问凭据域：设置段引用的这个 ref 现在有没有值。
   *
   * 设置文档里只有引用名，密钥本体从不随响应回来；「是否已配置」必须问凭据域，
   * 否则徽标会一直显示未配置。
   */
  async readCredential() {
    const ref = refOf(this.scope.getSnapshot());
    if (ref !== this.credential.ref) {
      this.credential = { ref, configured: false, writable: true };
      this.store.set(this.projection());
    }
    try {
      const response = await this.ctx.remote.credentials.describe([ref]);
      if (!response?.ok) return;
      if (ref !== refOf(this.scope.getSnapshot())) return;
      const view = response.value?.[ref];
      const next = {
        ref,
        configured: view?.configured ?? false,
        writable: view?.writable ?? true,
      };
      if (next.configured === this.credential.configured && next.writable === this.credential.writable) return;
      this.credential = next;
      this.store.set(this.projection());
    } catch {
      // 凭据域不可用时保持上一次已知状态。
    }
  }

  /**
   * 写入暂存的密钥。
   *
   * 走凭据域而不是设置文档：密钥不属于设置文件，这条通道也只允许写入、不回读。
   * @param value - 用户输入的密钥明文。
   * @returns 写入后凭据域是否报告已配置。
   */
  async writeKey(value: string): Promise<boolean> {
    try {
      await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot()), value);
    } catch {
      return false;
    }
    await this.readCredential();
    return this.credential.configured;
  }

  dispose() {
    this.unsubscribe();
    this.form.dispose();
  }
}

/** 共享的 volatile 引用协议（与 cosmokit 的 `isVolatile` 同一枚符号）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** 解包 volatile 引用单元；普通值原样返回。 */
function unwrap<T>(value: unknown): T | undefined {
  if (typeof value === 'object' && value !== null && VOLATILE_WRITE in (value as object)) {
    return (value as { get(): T }).get();
  }
  return value as T | undefined;
}

/**
 * 把一个字段规范包装成「格式化前先解包 volatile」的版本。
 *
 * `SettingsFormModel.field()` 调用的是 `spec.format(scope.value[field])`，而
 * `.volatile()` 字段在那里是**引用单元**而不是值 —— 不解包的话
 * `Array.isArray(cell)` 为假、`String(cell)` 得到 `[object Object]`。
 * 所有字段统一经过这里，避免每写一个规范都要记得解包。
 * @param spec - 原始字段规范。
 * @returns 解包后的规范。
 */
function liveSpec<T extends { format: (value: unknown) => string }>(spec: T): T {
  return {
    ...spec,
    format: (value: unknown) => spec.format(unwrap(value)),
  };
}

/** 设置段当前引用的凭据名；未声明时用兜底名。 */
function refOf(snapshot: { value?: Record<string, unknown> }): string {
  const declared = unwrap<string>(snapshot.value?.apiKeyEnv);
  return typeof declared === 'string' && declared.length > 0 ? declared : DEFAULT_API_KEY_REF;
}

/**
 * 本插件作为 bundle 的包名。
 *
 * 「插件」页按 **bundle 包名** 给配置插槽取键（`pluginManager.listBundles` 报告的就是
 * 它），所以这里必须与 profile 里安装的名字逐字一致。
 */
const BUNDLE_NAME = 'dsh-agentrouter-connect';

/** 该 bundle 里本插件那一行的 id，与 cordis.patch.yml 的声明一致。 */
const ROW_ID = 'llm-agentrouter';

export function apply(ctx: any): void {
  const t = ctx.locale.bind(LOCALE_NS) as LocaleReader;
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'agentrouter: dictionaries');
  const card = new AgentRouterCardController(ctx.configForms.get(NAMESPACE), ctx);
  ctx.effect(() => () => {
    card.dispose();
  }, 'agentrouter: form subscription');
  ctx.effect(() => ctx.remote.$on('credentials/reference-updated', () => {
    void card.readCredential();
  }), 'agentrouter: credential invalidations');

  /**
   * 把一个挂载点注册进某个插槽（仅在该命名空间被宿主服务时存在）。
   *
   * **只注册 `plugins.bundle.config` 与 `plugins.row.config`** —— 它们是 keyed 插槽，
   * 挂在**本插件自己的 bundle 卡片 / 组件行**的详情页上。
   *
   * 不注册 `plugins.item`：那是 list 插槽，宿主会把它的每一条都当成一张独立卡片
   * 塞进「官方」组（`officialCards = [...official, ...ledger.items]`，见
   * dsh-client-ui-plugin-manager）。注册进去会让第三方插件看起来像官方插件。
   */
  const mount = (slot: string, options: Record<string, unknown>, label: string) => {
    ctx.effect(
      () => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject(slot, () => ctx.slots.register({
        ...options,
        name: slot,
        locale: LOCALE_NS,
        inject: () => card.inject(),
      }, AgentRouterCard))),
      label,
    );
  };

  mount('plugins.bundle.config', { key: BUNDLE_NAME }, 'agentrouter: bundle settings page');
  mount('plugins.row.config', { key: `${BUNDLE_NAME}#${ROW_ID}` }, 'agentrouter: row settings page');
}
