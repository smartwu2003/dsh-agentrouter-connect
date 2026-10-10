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
const ARRAY_KEYS = new Set(['required', 'enum', 'allOf', 'anyOf', 'oneOf', 'prefixItems']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively normalize one JSON Schema node.
 * @param node - the schema (or sub-schema) to clean.
 * @returns a sanitized copy; the input is never mutated.
 */
export function sanitizeJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeJsonSchema);
  }
  if (!isPlainObject(node)) {
    return node;
  }

  const out: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(node)) {
    // Null placeholders we know how to repair.
    if (raw === null) {
      if (ARRAY_KEYS.has(key)) {
        out[key] = [];
        continue;
      }
      // `items` is dereferenced like `required`, so a null placeholder has to
      // become a real (permissive) schema rather than being dropped.
      if (key === 'items') {
        out[key] = {};
        continue;
      }
      // Any other null (object-, boolean- or string-valued keys): drop the key
      // entirely — an absent key is valid where an explicit null is not.
      continue;
    }

    // `additionalProperties` may also arrive as a nested schema object.
    if (key === 'additionalProperties' && isPlainObject(raw)) {
      out[key] = sanitizeJsonSchema(raw);
      continue;
    }

    out[key] = sanitizeJsonSchema(raw);
  }

  // AgentRouter's validator dereferences `required` unconditionally on every
  // object schema. Sending the key at all with a non-array value fails, but so
  // does omitting it: the gateway then reports `null is not of type "array"`.
  // An explicit empty array is the only shape it accepts for "no requirements".
  const declaresObject = out.type === 'object' ||
    (Array.isArray(out.type) && (out.type as unknown[]).includes('object')) ||
    isPlainObject(out.properties);
  if (declaresObject && !Array.isArray(out.required)) {
    out.required = [];
  }

  return out;
}

/** Whether one tool definition is pinned to strict sampling and must not be rewritten. */
function isStrictTool(tool: Record<string, unknown>): boolean {
  return tool.strict === true ||
    (isPlainObject(tool.function) && (
      tool.function.strict === true ||
      (isPlainObject(tool.function.parameters) && tool.function.parameters.strict === true)
    )) ||
    (isPlainObject(tool.input_schema) && tool.input_schema.strict === true);
}

/**
 * Normalize every tool definition in an outgoing request body, in whichever
 * protocol shape the body uses.
 * @param body - the parsed request body about to be forwarded upstream.
 * @returns the number of tools whose schema had to be rewritten.
 */
export function sanitizeToolSchemas(body: unknown): number {
  if (!isPlainObject(body) || !Array.isArray(body.tools)) {
    return 0;
  }

  let repaired = 0;
  for (const tool of body.tools) {
    if (!isPlainObject(tool)) continue;
    if (isStrictTool(tool)) continue;

    // OpenAI shape: tools[].function.parameters
    const fn = tool.function;
    if (isPlainObject(fn) && 'parameters' in fn) {
      const before = JSON.stringify(fn.parameters);
      const after = sanitizeJsonSchema(fn.parameters);
      if (JSON.stringify(after) !== before) {
        fn.parameters = after;
        repaired++;
      }
      continue;
    }

    // Anthropic shape: tools[].input_schema
    if ('input_schema' in tool) {
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
