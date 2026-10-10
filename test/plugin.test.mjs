/**
 * Behavioural tests for dsh-agentrouter-connect.
 *
 * Run with `node --test test/*.test.mjs`. Everything runs offline against a
 * local stub relay: what needs proving is the wire shape this plugin produces
 * and the decisions it makes, not that AgentRouter is reachable.
 *
 * Each test that touches configuration points `DSH_HOME` at a fresh temporary
 * directory, so the suite never reads or writes the real
 * `~/.dsh/agentrouter/config.json`.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHARED = { logger: { info() {}, warn() {}, error() {} } };

/** Every request the stub relay saw, most recent last. */
let seen = [];
/** Scripted upstream answers, consumed in order; empty means "200 SSE". */
let script = [];
let stub;
let stubPort;

/** Point the plugin at a fresh state directory and store a credential. */
function useHome(state = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ar-test-'));
  mkdirSync(join(home, 'agentrouter'), { recursive: true });
  process.env.DSH_HOME = home;
  writeConfig(state);
  writeCredential();
  return home;
}

function configPath() {
  return join(process.env.DSH_HOME, 'agentrouter', 'config.json');
}

function writeConfig(config = {}) {
  writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function readConfig() {
  return JSON.parse(readFileSync(configPath(), 'utf8'));
}

/**
 * The section config every test starts from: local stub, direct transport.
 *
 * This is the *profile patch* shape (the plugin's settings), which is now the
 * only source of these values. The JSON state file holds caches and overrides
 * only, so tests that need a key write it to the credential store instead.
 */
function baseSection(extra = {}) {
  return {
    endpoint: `http://127.0.0.1:${stubPort}/v1`,
    proxy: 'direct',
    directEndpoints: 'always',
    customModels: ['deepseek-v4-flash'],
    ...extra,
  };
}

/** Write the credential the plugin resolves through `apiKeyEnv`. */
function writeCredential(value = 'test-key') {
  writeFileSync(join(process.env.DSH_HOME, '.credentials.yaml'), `version: 1\nrefs:\n  AGENTROUTER_API_KEY: ${value}\n`);
}

/** Resolve config the way `apply()` does: the section is the only source. */
function section(mod, extra = {}) {
  return mod.resolveConfig(baseSection(extra));
}

/** Wrap one value the way schemastery hands a `.volatile()` field to the plugin. */
function cell(value) {
  return { get: () => value, [Symbol.for('cosmokit.volatile.write')]: () => {} };
}

/**
 * Resolve config from a runtime section, exactly as `apply()` does.
 *
 * `baseSection()` is already the *parsed* shape, so it has to be wrapped back
 * into cells before it can stand in for what the loader hands the plugin.
 */
function resolveRuntime(mod, extra = {}) {
  return mod.resolveConfig(runtimeSection(extra));
}

/**
 * Build the runtime config shape `apply()` receives from the loader.
 *
 * Two naming layers meet here: the **schema** field is `proxy`, while the
 * resolver input is `proxyUrl`; `apply()` performs that rename. Everything else
 * keeps its name. Getting this wrong is invisible — the resolver simply falls
 * back to its default — so the mapping is stated once, here.
 */
function runtimeSection(extra = {}) {
  const values = { ...baseSection(extra), userAgent: '' };
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    const inputKey = key === 'proxy' ? 'proxyUrl' : key;
    out[inputKey] = key === 'userAgent' ? value : cell(value);
  }
  return out;
}

/** Import the built host half against the current DSH_HOME. */
async function host() {
  return await import('../lib/index.js');
}

/** Create an AgentRouterLlmAdapter wired to a runtime section. */
function createAdapter(mod, extra = {}) {
  return new mod.AgentRouterLlmAdapter({
    ...SHARED,
    resolveConfig: () => resolveRuntime(mod, extra),
  });
}

/** Collect all chunks yielded by an async iterable stream. */
async function collectStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

before(async () => {
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        seen.push({ url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'claude-opus-4-8' }, { id: 'claude-opus-5' }, { id: 'deepseek-v4-flash' }, { id: 'gpt-6-astra' }],
        }));
        return;
      }
      seen.push({ url: req.url, headers: req.headers, body });
      // A `persist` entry stays for every subsequent request; others are consumed once.
      const step = script[0]?.persist === true ? script[0] : script.shift();
      if (step !== undefined) {
        if (step.raw) {
          res.writeHead(step.status ?? 200, { 'content-type': step.contentType ?? 'text/event-stream' });
          res.end(step.raw);
          return;
        }
        res.writeHead(step.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: step.message } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubPort = stub.address().port;
});

after(() => new Promise((resolve) => stub.close(resolve)));

beforeEach(() => {
  seen = [];
  script = [];
});

// ---------------------------------------------------------------------------
// Security & Authentication
// ---------------------------------------------------------------------------

test('adapter.stream rejects unauthenticated requests before making upstream calls', async () => {
  useHome();
  writeFileSync(join(process.env.DSH_HOME, '.credentials.yaml'), 'version: 1\nrefs:\n');
  const mod = await host();
  const adapter = createAdapter(mod);
  await assert.rejects(
    async () => {
      await collectStream(adapter.stream({ model: 'deepseek-v4-flash', messages: [] }));
    },
    (err) => {
      assert.match(err.message, /API Key/);
      assert.equal(err.code, 'AUTH');
      assert.equal(err.failure?.status, 401);
      return true;
    },
  );
  assert.equal(seen.length, 0, 'an unauthenticated request must never reach upstream');
});

test('adapter.stream rejects invalid proxy configs before making upstream calls', async () => {
  useHome();
  const mod = await host();
  const adapter = createAdapter(mod, { proxy: 'socks5://127.0.0.1:1080' });
  await assert.rejects(
    async () => {
      await collectStream(adapter.stream({ model: 'deepseek-v4-flash', messages: [] }));
    },
    (err) => {
      assert.match(err.message, /代理配置不可用/);
      assert.equal(err.code, 'INVALID_PROXY');
      return true;
    },
  );
  assert.equal(seen.length, 0, 'invalid proxy must fail before dispatch');
});

test('the plugin exposes no loopback HTTP server or shim', async () => {
  const mod = await host();
  assert.equal(mod.createAgentRouterShim, undefined, 'no local shim server should be exported');
});

// ---------------------------------------------------------------------------
// Outgoing wire shape
// ---------------------------------------------------------------------------

test('the OpenAI path rewrites the developer role and fills a null required', async () => {
  useHome();
  const mod = await host();
  const adapter = createAdapter(mod, { protocolPreference: 'openai-first' });
  await collectStream(adapter.stream({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'developer', content: 'sys' }],
    tools: [{ name: 'get_goal', parameters: { type: 'object', properties: {}, required: null } }],
  }));
  const upstream = seen.at(-1);
  assert.equal(upstream.url, '/v1/chat/completions');
  assert.match(upstream.headers['user-agent'], /^pi \(/);
  assert.equal(upstream.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(upstream.body);
  assert.equal(body.messages[0].role, 'system');
  assert.deepEqual(body.tools[0].function.parameters, { type: 'object', properties: {}, required: [] });
});

test('the Anthropic path repairs input_schema and uses x-api-key', async () => {
  useHome();
  const mod = await host();
  const adapter = createAdapter(mod, { protocolPreference: 'anthropic-first' });
  await collectStream(adapter.stream({
    model: 'deepseek-v4-flash',
    maxTokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_goal', description: 'x', parameters: { type: 'object', properties: {} } }],
  }));
  const upstream = seen.at(-1);
  assert.equal(upstream.url, '/v1/messages');
  assert.equal(upstream.headers['x-api-key'], 'test-key');
  assert.equal(upstream.headers['anthropic-version'], '2023-06-01');
  assert.equal(upstream.headers.authorization, undefined, 'the Anthropic path must not also send a bearer token');
  assert.deepEqual(JSON.parse(upstream.body).tools[0].input_schema, { type: 'object', properties: {}, required: [] });
});

test('a strict tool schema is left alone', async () => {
  useHome();
  const mod = await host();
  const adapter = createAdapter(mod, { protocolPreference: 'openai-first' });
  const strict = { type: 'object', properties: { a: { type: 'string' } }, strict: true };
  await collectStream(adapter.stream({
    model: 'deepseek-v4-flash',
    messages: [],
    tools: [{ name: 'x', parameters: strict, strict: true }],
  }));
  assert.deepEqual(JSON.parse(seen.at(-1).body).tools[0].function.parameters, strict);
});

// ---------------------------------------------------------------------------
// Silent retry
// ---------------------------------------------------------------------------

const DIALECT = 'The content[].thinking in the thinking mode must be passed back to the API.';

test('silent retry is off when the config says so', async () => {
  useHome();
  const mod = await host();
  const adapter = createAdapter(mod, { silentRetry: false });
  script = [{ status: 400, message: DIALECT }];
  await assert.rejects(
    async () => {
      await collectStream(adapter.stream({ model: 'deepseek-v4-flash', messages: [] }));
    },
    (err) => {
      assert.equal(err.failure?.status, 400);
      return true;
    },
  );
  assert.equal(seen.length, 1, 'nothing may be re-sent while the switch is off');
});

test('a channel-dialect 400 is re-sent until a channel accepts it', async () => {
  useHome();
  const mod = await host();
  const adapter = createAdapter(mod, { silentRetry: true, silentRetryAttempts: 3 });
  script = [{ status: 400, message: DIALECT }];
  await collectStream(adapter.stream({ model: 'deepseek-v4-flash', messages: [] }));
  assert.equal(seen.length, 2);
  assert.equal(seen[0].body, seen[1].body, 'every attempt must put identical bytes on the wire');
});

test('a genuine 400 is surfaced without being re-sent', async () => {
  useHome();
  const mod = await host();
  const adapter = createAdapter(mod, { silentRetry: true, silentRetryAttempts: 3 });
  script = [{ status: 400, message: 'unknown model: no-such-model' }];
  await assert.rejects(
    async () => {
      await collectStream(adapter.stream({ model: 'no-such-model', messages: [] }));
    },
    (err) => {
      assert.equal(err.failure?.status, 400);
      assert.match(err.message, /unknown model/);
      return true;
    },
  );
  assert.equal(seen.length, 1);
});

test('a 5xx is re-sent and the attempt count bounds the total', async () => {
  useHome();
  const mod = await host();
  const adapter = createAdapter(mod, { silentRetry: true, silentRetryAttempts: 4 });
  script = [{ status: 503, message: 'unavailable', persist: true }];
  await assert.rejects(
    async () => {
      await collectStream(adapter.stream({ model: 'deepseek-v4-flash', messages: [] }));
    },
    (err) => {
      assert.equal(err.failure?.status, 503);
      return true;
    },
  );
  assert.equal(seen.length, 4, 'the ceiling is a total attempt count, the first included');
});

// ---------------------------------------------------------------------------
// Stream chunk decoding
// ---------------------------------------------------------------------------

test('the adapter decodes OpenAI SSE stream chunks (text, reasoning, tool_calls, usage, finish)', async () => {
  useHome();
  const mod = await host();
  const adapter = createAdapter(mod, { protocolPreference: 'openai-first' });
  script = [{
    raw: [
      'data: {"choices":[{"delta":{"reasoning_content":"thinking step"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hello world"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"search","arguments":"{\\"q\\":\\"test\\"}"}}]}}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''),
  }];

  const chunks = await collectStream(adapter.stream({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] }));
  assert.ok(chunks.some(c => c.type === 'reasoning-delta' && c.text === 'thinking step'));
  assert.ok(chunks.some(c => c.type === 'text-delta' && c.text === 'hello world'));
  assert.ok(chunks.some(c => c.type === 'tool-call-delta' && c.id === 'call_123' && c.name === 'search'));
  assert.ok(chunks.some(c => c.type === 'usage' && c.usage.totalTokens === 15));
  assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'stop'));
});

test('the adapter decodes Anthropic SSE stream chunks (text, reasoning, tool_calls, usage, finish)', async () => {
  useHome();
  const mod = await host();
  const adapter = createAdapter(mod, { protocolPreference: 'anthropic-first' });
  script = [{
    raw: [
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"thinking"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"anthropic thought"}}\n\n',
      'event: content_block_stop\ndata: {"index":0}\n\n',
      'event: content_block_start\ndata: {"index":1,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"index":1,"delta":{"type":"text_delta","text":"anthropic text"}}\n\n',
      'event: content_block_stop\ndata: {"index":1}\n\n',
      'event: content_block_start\ndata: {"index":2,"content_block":{"type":"tool_use","id":"call_anthropic","name":"lookup"}}\n\n',
      'event: content_block_delta\ndata: {"index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"k\\":1}"}}\n\n',
      'event: content_block_stop\ndata: {"index":2}\n\n',
      'event: message_delta\ndata: {"usage":{"input_tokens":20,"output_tokens":8},"delta":{"stop_reason":"tool_use"}}\n\n',
    ].join(''),
  }];

  const chunks = await collectStream(adapter.stream({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }));
  assert.ok(chunks.some(c => c.type === 'reasoning-delta' && c.text === 'anthropic thought'));
  assert.ok(chunks.some(c => c.type === 'text-delta' && c.text === 'anthropic text'));
  assert.ok(chunks.some(c => c.type === 'tool-call-delta' && c.id === 'call_anthropic' && c.name === 'lookup'));
  assert.ok(chunks.some(c => c.type === 'usage' && c.usage.totalTokens === 28));
  assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'tool-calls'));
});

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

test('every opened block is closed with a block-end carrying the assembled content', async () => {
  // Regression: the native adapter originally emitted block-start + deltas but
  // never block-end. BlockAssembler tolerates that at end-of-stream, so nothing
  // visibly broke — but the authoritative assembled block was never delivered.
  // pi-ai's contract is block-start -> *-delta -> block-end.
  useHome();
  const mod = await host();

  // Build the SSE frames with JSON.stringify so the escaping can never drift.
  const oa = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
  const an = (event, obj) => 'event: ' + event + '\ndata: ' + JSON.stringify(obj) + '\n\n';

  const check = (chunks) => {
    const starts = chunks.filter(c => c.type === 'block-start');
    const ends = chunks.filter(c => c.type === 'block-end');
    assert.ok(starts.length > 0, 'the stream must open at least one block');
    assert.equal(ends.length, starts.length, 'every opened block must be closed');
    for (const st of starts) {
      const en = ends.find(x => x.index === st.index);
      assert.ok(en, `block ${st.index} (${st.blockType}) was never closed`);
      assert.equal(en.block.type, st.blockType, 'a block-end must match its block-start type');
    }
    const order = ends.map(x => x.index);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'block-ends must follow block order');
  };

  // --- OpenAI ---
  script = [{ raw: [
    oa({ choices: [{ delta: { reasoning_content: 'think' } }] }),
    oa({ choices: [{ delta: { content: 'hello ' } }] }),
    oa({ choices: [{ delta: { content: 'world' } }] }),
    oa({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"a":' } }] } }] }),
    oa({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }),
    oa({ choices: [{ finish_reason: 'tool_calls' }] }),
    oa('[DONE]'),
  ].join('') }];
  const openai = await collectStream(createAdapter(mod, { protocolPreference: 'openai-first' }).stream({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] }));
  check(openai);
  assert.equal(openai.find(c => c.type === 'block-end' && c.block.type === 'text').block.text, 'hello world',
    'the text block-end must carry the concatenated text');
  assert.equal(openai.find(c => c.type === 'block-end' && c.block.type === 'reasoning').block.text, 'think');
  const cb = openai.find(c => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.equal(cb.block.id, 'call_1');
  assert.equal(cb.block.name, 'f');
  assert.equal(cb.block.arguments, '{"a":1}', 'arguments split across deltas must be reassembled');

  // --- Anthropic: content_block_stop is the authoritative close ---
  script = [{ raw: [
    an('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
    an('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'deep' } }),
    an('content_block_stop', { index: 0 }),
    an('content_block_start', { index: 1, content_block: { type: 'text' } }),
    an('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'ok' } }),
    an('content_block_stop', { index: 1 }),
    an('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'tool_9', name: 'g' } }),
    an('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"b":2}' } }),
    an('content_block_stop', { index: 2 }),
    an('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 3, output_tokens: 4 } }),
  ].join('') }];
  const anthropic = await collectStream(createAdapter(mod, { protocolPreference: 'anthropic-first' }).stream({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }));
  check(anthropic);
  assert.equal(anthropic.find(c => c.type === 'block-end' && c.block.type === 'reasoning').block.text, 'deep');
  assert.equal(anthropic.find(c => c.type === 'block-end' && c.block.type === 'text').block.text, 'ok');
  const at = anthropic.find(c => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.equal(at.block.id, 'tool_9');
  assert.equal(at.block.name, 'g');
  assert.equal(at.block.arguments, '{"b":2}');
  assert.ok(anthropic.some(c => c.type === 'finish' && c.reason.kind === 'tool-calls'));
});

test('an unsupported proxy scheme is refused with an actionable message', async () => {
  const mod = await host();
  for (const bad of ['socks5://127.0.0.1:1080', 'socks://127.0.0.1:1080', 'not a url', 'ftp://x']) {
    const verdict = mod.validateProxyUrl(bad);
    assert.equal(verdict.ok, false, `${bad} must be refused`);
    assert.match(verdict.message, /代理地址/);
  }
  for (const good of ['', 'direct', 'http://127.0.0.1:7897', 'https://proxy.example:8443']) {
    assert.equal(mod.validateProxyUrl(good).ok, true, `${good} must be accepted`);
  }
});

test('a SOCKS proxy fails loudly at dispatch time too', async () => {
  const mod = await host();
  assert.throws(
    () => mod.getDispatcherForEndpoint('https://example.com/v1', 'socks5://127.0.0.1:1080', 'none'),
    /SOCKS/,
  );
});

test('the domestic origin bypasses the proxy in auto mode only', async () => {
  const mod = await host();
  assert.equal(mod.shouldBypassProxy('https://ps.air-outer.com/v1', 'auto'), true);
  assert.equal(mod.shouldBypassProxy('https://agentrouter.org/v1', 'auto'), false);
  assert.equal(mod.shouldBypassProxy('https://ps.air-outer.com/v1', 'none'), false);
  assert.equal(mod.shouldBypassProxy('https://agentrouter.org/v1', 'always'), true);
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('volatile config cells are unwrapped on read', async () => {
  useHome({});
  const mod = await host();
  const cell = (value) => ({ get: () => value, [Symbol.for('cosmokit.volatile.write')]: () => {} });
  const resolved = mod.resolveConfig({
    proxyUrl: cell('http://127.0.0.1:1080'),
    endpoint: cell('https://example.com/v1'),
    customModels: cell(['m1']),
    silentRetry: cell(false),
    silentRetryAttempts: cell(7),
    protocolPreference: cell('openai-first'),
  });
  assert.equal(resolved.proxyUrl, 'http://127.0.0.1:1080');
  assert.equal(resolved.endpoint, 'https://example.com/v1');
  assert.deepEqual(resolved.customModels, ['m1']);
  assert.equal(resolved.silentRetry, false);
  assert.equal(resolved.silentRetryAttempts, 7);
  assert.equal(resolved.protocolPreference, 'openai-first');
});

test('the state file can never shadow the settings section', async () => {
  // This is the regression that produced a page showing one endpoint while the
  // plugin used another: the section said X, config.json said Y, and both were
  // read. The section wins by construction now — the state file is not read for
  // any section-owned field at all.
  useHome({
    proxyUrl: 'http://127.0.0.1:9999',
    endpoint: 'https://stale.example.com/v1',
    customModels: ['stale-model'],
    silentRetry: false,
    directEndpoints: 'none',
  });
  const mod = await host();
  const cfg = resolveRuntime(mod, { customModels: ['fresh-model'], silentRetry: true });
  assert.equal(cfg.endpoint, `http://127.0.0.1:${stubPort}/v1`, 'the section endpoint must win');
  assert.equal(cfg.proxyUrl, 'direct', 'the section proxy must win');
  assert.deepEqual(cfg.customModels, ['fresh-model'], 'the section catalog must win');
  assert.equal(cfg.silentRetry, true, 'the section retry switch must win');
  assert.equal(cfg.directEndpoints, 'always', 'the section transport must win');
});

test('the retry attempt count is clamped into the supported range', async () => {
  const mod = await host();
  for (const [input, expected] of [[0, 1], [99, 10], [3.4, 3]]) {
    useHome();
    assert.equal(resolveRuntime(mod, { silentRetryAttempts: input }).silentRetryAttempts, expected);
  }
});

test('the legacy plaintext key is only dropped once the credential store holds one', async () => {
  useHome({ apiKey: 'legacy-key', endpoint: 'http://127.0.0.1:1/v1' });
  const mod = await host();
  assert.equal(mod.hasLegacyApiKey(), true);
  assert.equal(mod.dropLegacyApiKeyIfSuperseded(false), '');
  assert.equal(mod.hasLegacyApiKey(), true, 'nothing may be deleted while no replacement exists');
  assert.equal(mod.dropLegacyApiKeyIfSuperseded(true), 'legacy-key');
  assert.equal(mod.hasLegacyApiKey(), false);
});

test('saveConfig never persists a key into the JSON state file', async () => {
  useHome({});
  const mod = await host();
  mod.saveConfig({ apiKey: 'should-not-be-written', proxyUrl: 'http://127.0.0.1:7897' });
  assert.equal(readConfig().apiKey, undefined);
  assert.equal(readConfig().proxyUrl, 'http://127.0.0.1:7897');
});

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

test('the seed catalog lists the models the relay actually served', async () => {
  const mod = await host();
  assert.deepEqual(
    mod.AGENTROUTER_DEFAULT_MODELS.map((m) => m.id),
    ['claude-opus-5', 'claude-opus-4-8', 'deepseek-v4-flash', 'gpt-6-astra'],
  );
  assert.deepEqual(
    mod.AGENTROUTER_DEFAULT_MODELS.filter((m) => m.supportsImages).map((m) => m.id),
    [],
    'image input is unverified upstream, so nothing may claim it',
  );
});

test('an unknown custom model falls back to conservative traits', async () => {
  const mod = await host();
  const [unknown] = mod.resolveActiveModels(['totally-new-model']);
  assert.equal(unknown.supportsImages, false);
  assert.equal(unknown.maxTokens, 16384);
  assert.deepEqual(unknown.protocols, ['openai']);
});

test('the catalog sync caches the relay answer without touching the section', async () => {
  useHome();
  const mod = await host();
  const cfg = section(mod, { customModels: [] });
  const ids = await mod.syncModelCatalog(cfg, {});
  assert.deepEqual(ids, ['claude-opus-4-8', 'claude-opus-5', 'deepseek-v4-flash', 'gpt-6-astra']);
  assert.deepEqual(readConfig().relayModels, ids, 'the answer is a cache in the state file');
  assert.equal(readConfig().customModels, undefined, 'and never a second source of the section list');

  const before = readFileSync(configPath(), 'utf8');
  await mod.syncModelCatalog(section(mod, { customModels: [] }), {});
  assert.equal(readFileSync(configPath(), 'utf8'), before, 'an unchanged catalog must not rewrite the file');
});

test('an explicit model list outranks the cached catalog', async () => {
  useHome({ relayModels: ['claude-opus-5', 'gpt-6-astra'] });
  const mod = await host();
  assert.deepEqual(
    mod.effectiveModelIds(mod.resolveConfig(baseSection({ customModels: ['deepseek-v4-flash'] }))),
    ['deepseek-v4-flash'],
    'what the user typed wins',
  );
  assert.deepEqual(
    mod.effectiveModelIds(mod.resolveConfig(baseSection({ customModels: [] }))),
    ['claude-opus-5', 'gpt-6-astra'],
    'an empty section list falls back to the cache',
  );
  assert.equal(
    mod.effectiveModelIds(mod.resolveConfig(baseSection({ customModels: [] })))?.length,
    2,
  );
});

// ---------------------------------------------------------------------------
// Protocol resolution
// ---------------------------------------------------------------------------

test('the active-model view reflects a per-model protocol override', async () => {
  // The card and the adapter both derive the active protocol from the same
  // catalog helpers via describeActiveModels(), so this is the single place the
  // P0-2 regression ("card shows auto while the adapter uses openai") can hide.
  useHome();
  const mod = await host();

  const overridden = mod.describeActiveModels(mod.resolveConfig(baseSection({
    customModels: ['deepseek-v4-flash'],
    modelProtocols: { 'deepseek-v4-flash': 'openai' },
  })));
  assert.equal(overridden.length, 1);
  assert.equal(overridden[0].active, 'openai', 'a per-model override must be visible everywhere');

  const auto = mod.describeActiveModels(mod.resolveConfig(baseSection({ customModels: ['deepseek-v4-flash'] })));
  assert.equal(auto[0].active, 'anthropic', 'without an override a dual-protocol model follows anthropic-first');
});

test('the preference only decides among protocols the model supports', async () => {
  const mod = await host();
  const flash = mod.AGENTROUTER_DEFAULT_MODELS.find((m) => m.id === 'deepseek-v4-flash');
  const astra = mod.AGENTROUTER_DEFAULT_MODELS.find((m) => m.id === 'gpt-6-astra');
  assert.equal(mod.resolveModelProtocol(flash, 'anthropic-first'), 'anthropic');
  assert.equal(mod.resolveModelProtocol(flash, 'openai-first'), 'openai');
  assert.equal(mod.resolveModelProtocol(astra, 'anthropic-first'), 'openai', 'an OpenAI-only model cannot be talked into Anthropic');
});

// ---------------------------------------------------------------------------
// Adapter contract & dynamic config
// ---------------------------------------------------------------------------

test('the native adapter implements the LlmAdapter contract and reflects live config dynamically', async () => {
  useHome();
  const mod = await host();
  const live = baseSection();
  const adapter = new mod.AgentRouterLlmAdapter({
    ...SHARED,
    resolveConfig: () => mod.resolveConfig(live),
  });

  // 1. Provider info
  const info = adapter.providerInfo(mod.AGENTROUTER_PROVIDER);
  assert.equal(info.id, mod.AGENTROUTER_PROVIDER);
  assert.equal(info.name, 'AgentRouter');

  // 2. Dynamic listModels reflecting live configuration
  const initialModels = await adapter.listModels(mod.AGENTROUTER_PROVIDER);
  assert.deepEqual(initialModels.map((m) => m.id), ['deepseek-v4-flash']);

  live.customModels = ['gpt-6-astra', 'claude-opus-5'];
  const updatedModels = await adapter.listModels(mod.AGENTROUTER_PROVIDER);
  assert.deepEqual(updatedModels.map((m) => m.id), ['gpt-6-astra', 'claude-opus-5']);

  // 3. resolveModel exposes context windows, max tokens, reasoning
  const resolved = await adapter.resolveModel(mod.AGENTROUTER_PROVIDER, 'claude-opus-5');
  assert.equal(resolved.id, 'claude-opus-5');
  assert.equal(resolved.context?.contextWindow, 1000000);
  assert.equal(resolved.defaultMaxTokens, 128000);

  // 4. prepareCall returns callable stream
  const prep = await adapter.prepareCall(mod.AGENTROUTER_PROVIDER, 'claude-opus-5');
  assert.equal(prep.model.id, 'claude-opus-5');
  assert.equal(typeof prep.stream, 'function');
});

// ---------------------------------------------------------------------------
// Settings surface
// ---------------------------------------------------------------------------

test('the Config schema publishes a form and validates its fields', async () => {
  const mod = await host();
  const schema = mod.Config;
  assert.equal(schema.type, 'object');

  const parsed = schema({});
  const volatile = Symbol.for('cosmokit.volatile.write');
  const cellNames = Object.entries(parsed)
    .filter(([, value]) => typeof value === 'object' && value !== null && volatile in value)
    .map(([name]) => name);
  assert.ok(cellNames.includes('proxy'), 'the proxy is a live field');
  assert.ok(cellNames.includes('customModels'), 'the catalog is a live field');
  assert.ok(cellNames.includes('userAgent'), 'the UA must be volatile: it is an editable card field, and the settings writer rejects non-volatile writes');
  assert.equal(schema.dict.apiKeyEnv.meta.role, 'credential-ref');
  assert.equal(schema.dict.apiKey, undefined, 'the key is not a settings field at all');

  assert.throws(() => schema({ silentRetryAttempts: 99 }), /<= 10/);
  assert.throws(() => schema({ directEndpoints: 'sometimes' }), /expected/);
});

test('every field the card lets you edit is volatile (or the atomic save is rejected)', async () => {
  // dsh-settings' write path throws "Config field ... is not volatile" for any
  // non-volatile path, and a save is atomic — one non-volatile field in the form
  // breaks saving for every field staged alongside it. These are exactly the
  // fields the native card exposes as editable controls (apiKey is not a schema
  // field; it is written through the credential domain).
  const mod = await host();
  const parsed = mod.Config({});
  const volatile = Symbol.for('cosmokit.volatile.write');
  const isCell = (value) => typeof value === 'object' && value !== null && volatile in value;
  const EDITABLE = [
    'apiKeyEnv', 'proxy', 'endpoint', 'userAgent', 'customModels',
    'directEndpoints', 'protocolPreference', 'autoRefreshModels',
    'silentRetry', 'silentRetryAttempts', 'quotaHint',
  ];
  for (const field of EDITABLE) {
    assert.ok(isCell(parsed[field]), `${field} must be volatile to be saveable from the card`);
  }
});

test('a known-bad legacy endpoint host is corrected, not used', async () => {
  useHome();
  const mod = await host();
  const cfg = mod.resolveConfig({ endpoint: 'https://co.agentrouter.org/v1' });
  assert.equal(cfg.endpoint, 'https://ps.air-outer.com/v1', 'the unusable host must not survive resolution');
  assert.equal(cfg.correctedEndpoint, 'https://co.agentrouter.org/v1', 'and the correction must be reported');
});

test('a healthy endpoint is left exactly as configured', async () => {
  useHome();
  const mod = await host();
  assert.equal(mod.resolveConfig({ endpoint: 'https://ps.air-outer.com/v1' }).correctedEndpoint, undefined);
  const cfg = mod.resolveConfig({ endpoint: 'https://example.com/v1' });
  assert.equal(cfg.endpoint, 'https://example.com/v1');
  assert.equal(cfg.correctedEndpoint, undefined, 'only known-bad hosts are touched');
});

test('the only HTTP route is the parameter-free connectivity probe', async () => {
  useHome();
  const mod = await host();
  const routes = new Map();
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); return d; },
    on: () => () => {},
    inject(names, cb) {
      if (names.includes('webServer')) {
        cb({ get: () => ({ register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } }) });
      }
      return () => {};
    },
    llm: { registerAdapter: () => (() => {}) },
    get: () => undefined,
  };
  try {
    await mod.apply(ctx, runtimeSection({ autoRefreshModels: false }));
    assert.deepEqual([...routes.keys()], ['/plugins/agentrouter/test']);

    const route = routes.get('/plugins/agentrouter/test');
    const call = (method) => new Promise((resolve) => {
      const res = { status: 0, body: '', writeHead(s) { this.status = s; }, end(c) { this.body = c ?? ''; resolve(this); } };
      route.handler({ method }, res);
    });
    assert.equal((await call('GET')).status, 405);
    const ok = await call('POST');
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).ok, true);
    assert.ok(!ok.body.includes('test-key'), 'the probe must not echo the key');
  } finally {
    for (const dispose of effects) { try { dispose(); } catch { /* ignore */ } }
  }
});


// ---------------------------------------------------------------------------
// Client bundle
// ---------------------------------------------------------------------------

/**
 * Load the built browser bundle the way the page's module loader does.
 *
 * The bundle is a lazy-CJS factory: executing it only registers the factory,
 * and `factory(require)` materializes the exports. Standing in for both lets
 * the test drive the real registration path without a browser.
 *
 * @returns the captured registration plus a fake primitives surface that
 *   records the field specs the page hands the shared form model.
 */
async function loadClientBundle() {
  const captured = { registration: undefined, specs: undefined, secrets: undefined };
  const primitives = {
    SettingsForm: (props) => ({ kind: 'form', props }),
    SettingsValueField: (props) => ({ kind: 'value', props }),
    SettingsSecretField: (props) => ({ kind: 'secret', props }),
    Switch: (props) => ({ kind: 'switch', props }),
    SegmentedControl: (props) => ({ kind: 'segmented', props }),
    settingsTextField: (field) => ({
      field,
      format: (value) => (typeof value === 'string' ? value : ''),
      parse: (text) => (text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text.trim() }),
    }),
    settingsNumberField: (field) => ({
      field,
      format: (value) => (typeof value === 'number' ? String(value) : ''),
      parse: (text) => {
        const trimmed = text.trim();
        if (trimmed === '') return { kind: 'clear' };
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined;
      },
    }),
    SettingsFormModel: class {
      constructor(scope, specs, secrets) {
        captured.specs = specs;
        captured.secrets = secrets;
      }
      bind() { return { set() {}, getSnapshot: () => ({}) }; }
      shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }; }
      field() { return { text: '', overridden: false, invalid: false }; }
      actions() { return { edit() {}, resetField() {}, save() {}, discard() {} }; }
      dispose() {}
    },
  };
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  };
  const previousWindow = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: {
      load: (registration) => { captured.registration = registration; },
    },
  };
  try {
    await import(`../lib/client.js?t=${Date.now()}`);
  } finally {
    globalThis.window = previousWindow;
  }
  const factory = captured.registration.factory;
  const exports = factory((spec) => {
    if (spec === 'react') return react;
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`unexpected require("${spec}")`);
  });
  return { exports, captured, primitives };
}

test('the client bundle registers under the package name with package-name deps', async () => {
  const { exports, captured } = await loadClientBundle();
  assert.equal(captured.registration.id, 'dsh-agentrouter-connect');
  assert.equal(exports.name, 'dsh-agentrouter-connect-client');
  for (const service of ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']) {
    assert.ok(exports.inject.includes(service), `the page must inject ${service}`);
  }
});

test('the page mounts only into its own bundle slots, never the Official list', async () => {
  const { exports } = await loadClientBundle();
  const mounts = [];
  const effects = [];
  const ctx = {
    locale: { bind: () => (key) => key, register() {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); return d; },
    remote: { $on: () => () => {}, credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => ({}) } },
    configForms: {
      get: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', writable: true, value: {} }) }),
      whileServed: (_namespaces, register) => register(),
    },
    slots: {
      inject: (_slot, register) => register(),
      register: (options, component) => { mounts.push({ ...options, component }); return () => {}; },
    },
  };
  exports.apply(ctx);
  const names = mounts.map((m) => m.name).sort();
  assert.deepEqual(names, ['plugins.bundle.config', 'plugins.row.config']);
  // `plugins.item` is a LIST slot: the host renders every entry as a standalone
  // card inside the "Official" group, which would present a third-party plugin as
  // a first-party one. Registering it is the bug this asserts against.
  assert.ok(!names.includes('plugins.item'), 'a third-party plugin must not claim an Official-group card');
  assert.equal(mounts.find((m) => m.name === 'plugins.bundle.config').key, 'dsh-agentrouter-connect');
  assert.equal(mounts.find((m) => m.name === 'plugins.row.config').key, 'dsh-agentrouter-connect#llm-agentrouter');
  for (const dispose of effects) { try { dispose(); } catch { /* ignore */ } }
});

test('field specs unwrap volatile cells before formatting', async () => {
  const { exports, captured } = await loadClientBundle();
  const effects = [];
  const ctx = {
    locale: { bind: () => (key) => key, register() {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); return d; },
    remote: { $on: () => () => {}, credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => ({}) } },
    configForms: {
      get: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', writable: true, value: {} }) }),
      whileServed: (_namespaces, register) => register(),
    },
    slots: { inject: (_slot, register) => register(), register: () => () => {} },
  };
  exports.apply(ctx);

  // Every namespace field arrives as a cosmokit reference cell.
  const cell = (value) => ({ get: () => value, [Symbol.for('cosmokit.volatile.write')]: () => {} });
  const specOf = (field) => captured.specs.find((spec) => spec.field === field);
  assert.ok(specOf('customModels'), 'the catalog field must be registered');

  assert.equal(
    specOf('customModels').format(cell(['claude-opus-5', 'deepseek-v4-flash'])),
    'claude-opus-5\ndeepseek-v4-flash',
    'a wrapped array must render as lines, not as [object Object]',
  );
  assert.equal(specOf('proxy').format(cell('http://127.0.0.1:7897')), 'http://127.0.0.1:7897');
  assert.equal(specOf('endpoint').format(cell('https://ps.air-outer.com/v1')), 'https://ps.air-outer.com/v1');
  assert.equal(specOf('silentRetryAttempts').format(cell(3)), '3');
  assert.equal(specOf('directEndpoints').format(cell('auto')), 'auto');
  assert.equal(specOf('protocolPreference').format(cell('anthropic-first')), 'anthropic-first');
  assert.equal(specOf('silentRetry').format(cell(false)), 'false');

  // Plain values must keep working.
  assert.equal(specOf('proxy').format('http://127.0.0.1:1080'), 'http://127.0.0.1:1080');

  // Parsing still produces the stored shapes.
  assert.deepEqual(specOf('customModels').parse('a\nb'), { kind: 'set', value: ['a', 'b'] });
  assert.deepEqual(specOf('customModels').parse('   '), { kind: 'clear' });
  assert.deepEqual(specOf('silentRetry').parse('true'), { kind: 'set', value: true });
  assert.deepEqual(specOf('silentRetryAttempts').parse('7'), { kind: 'set', value: 7 });
  assert.equal(specOf('silentRetryAttempts').parse('abc'), undefined, 'a bad draft must block the save');
  assert.equal(captured.secrets[0].field, 'apiKey', 'the key is a write-only control');

  for (const dispose of effects) { try { dispose(); } catch { /* ignore */ } }
});


test('the card renders every control from the projection, never from a field object', async () => {
  // The regression this pins: a raw control consumed `form.field(name)` (an object
  // shaped { text, overridden, invalid }) as its React `value`, so the textarea
  // rendered "[object Object]". `SettingsValueField` takes that object spread, a
  // plain <textarea> must take `.text`.
  const { exports } = await loadClientBundle();
  const effects = [];
  let component;
  const ctx = {
    locale: { bind: () => (key) => key, register() {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); return d; },
    remote: { $on: () => () => {}, credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => ({}) } },
    configForms: {
      get: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', writable: true, value: {} }) }),
      whileServed: (_namespaces, register) => register(),
    },
    slots: { inject: (_slot, register) => register(), register: (_options, c) => { component = c; return () => {}; } },
  };
  exports.apply(ctx);
  assert.equal(typeof component, 'function');

  const field = (text) => ({ text, overridden: false, invalid: false });
  const state = {
    available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
    apiKeyEnv: field('AGENTROUTER_API_KEY'),
    proxy: field('http://127.0.0.1:7897'),
    endpoint: field('https://ps.air-outer.com/v1'),
    userAgent: field(''),
    silentRetryAttempts: field('3'),
    quotaHint: field('hint'),
    customModelsText: '',
    autoRefreshValue: true,
    silentRetryValue: true,
    directEndpointsValue: 'auto',
    protocolPreferenceValue: 'anthropic-first',
    apiKey: field(''),
    apiKeyConfigured: true,
    apiKeyWritable: true,
  };

  const tree = component({
    view: 'full',
    t: (key) => key,
    useAgentRouterCard: (select) => select(state),
    edit() {}, resetField() {}, save() {}, discard() {},
  });

  // Walk the returned element tree for every control and check its value type.
  const found = new Map();
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    if (node.props?.id) found.set(node.props.id, node.props);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);

  const models = found.get('plugin-config-agentrouter-models');
  assert.ok(models, 'the model list textarea must be rendered');
  assert.equal(typeof models.value, 'string', 'a textarea value must be a string, not a field object');
  assert.equal(models.value, '');
  assert.ok(!String(models.value).includes('[object'), 'and never stringify an object into the control');

  // Two different control contracts live side by side:
  //  - `SettingsValueField` takes the whole field object spread, and reads `.text`;
  //  - a raw <textarea> takes a plain string `value`.
  // The bug was feeding the first shape to the second control.
  const proxy = found.get('plugin-config-agentrouter-proxy');
  assert.ok(proxy, 'the proxy field must be rendered');
  assert.equal(typeof proxy.text, 'string');
  assert.equal(proxy.text, 'http://127.0.0.1:7897');

  const attempts = found.get('plugin-config-agentrouter-silentRetryAttempts');
  assert.equal(typeof attempts.text, 'string');
  assert.equal(attempts.text, '3');

  const secret = found.get('plugin-config-agentrouter-api-key');
  assert.equal(typeof secret.text, 'string');

  // Whatever a control receives must be a primitive, never a field object.
  for (const [id, props] of found) {
    for (const key of ['value', 'text']) {
      if (props[key] === undefined) continue;
      assert.ok(
        ['string', 'number', 'boolean'].includes(typeof props[key]),
        `control ${id} rendered a ${typeof props[key]} ${key}`,
      );
    }
  }

  for (const dispose of effects) { try { dispose(); } catch { /* ignore */ } }
});
