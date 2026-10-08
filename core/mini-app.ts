// core/mini-app.ts — Sandboxed Web MCP mini-apps contract & validation (voicebox-beads-q8d)
//
// Defines the security policy, Web MCP tool declaration schemas, wire envelopes,
// and execution bounds for the double-iframe mini-app architecture.
//
// Pure TypeScript: no platform or DOM imports.

export interface WebMcpParameterSchema {
  type: string;
  description?: string;
  enum?: string[];
  [key: string]: unknown;
}

export interface WebMcpToolParameters {
  type: "object";
  properties: Record<string, WebMcpParameterSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface WebMcpToolDeclaration {
  name: string;
  description: string;
  parameters: WebMcpToolParameters;
}

export interface WebMcpToolCall {
  callId: string;
  appId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface WebMcpToolResult {
  callId: string;
  appId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface MiniAppManifest {
  id: string;
  title: string;
  tools: WebMcpToolDeclaration[];
  declaredAt: string;
}

export const MINI_APP_BOUNDS = Object.freeze({
  maxTools: 16,
  maxOutputBytes: 65536, // 64KB
  maxArgsBytes: 65536,   // 64KB max incoming tool arguments
  maxNestingDepth: 32,   // 32 levels of object/array nesting
  maxNodeCount: 2048,    // 2048 total visited nodes
  maxSchemaDepth: 16,    // 16 levels of schema nesting
  maxSchemaNodes: 512,   // 512 visited schema nodes
  callTimeoutMs: 5000,   // 5s per tool execution
  maxNameLength: 64,
  maxDescriptionLength: 1024,
  maxAppIdLength: 64,
  sandboxPolicy: "allow-scripts", // strictly NO allow-same-origin
});

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; refused: string; why: string };

const refusal = (refused: string, why: string): { ok: false; refused: string; why: string } => ({
  ok: false,
  refused,
  why,
});

const ALLOWED_TOP_PARAM_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
const ALLOWED_STRING_KEYS = new Set(["type", "description", "enum", "maxLength", "minLength"]);
const ALLOWED_NUMBER_KEYS = new Set(["type", "description", "enum", "maximum", "minimum"]);
const ALLOWED_BOOLEAN_KEYS = new Set(["type", "description"]);
const ALLOWED_ARRAY_KEYS = new Set(["type", "description", "items"]);
const ALLOWED_OBJECT_KEYS = new Set(["type", "description", "properties", "required", "additionalProperties"]);
const ALLOWED_ITEMS_KEYS = new Set(["type", "description", "enum"]);
const SUPPORTED_PRIMITIVE_ITEM_TYPES = new Set(["string", "number", "integer", "boolean"]);

function validateSinglePropertySchema(
  propName: string,
  raw: unknown,
  path = "",
  depth = 1,
  counter = { nodes: 0 }
): string | null {
  counter.nodes++;
  if (counter.nodes > MINI_APP_BOUNDS.maxSchemaNodes) {
    return `schema exceeds maximum node count of ${MINI_APP_BOUNDS.maxSchemaNodes}`;
  }
  if (depth > MINI_APP_BOUNDS.maxSchemaDepth) {
    return `schema nesting exceeds maximum depth of ${MINI_APP_BOUNDS.maxSchemaDepth}`;
  }

  if (propName === "__proto__") {
    return `property name cannot be '__proto__'`;
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `property '${path}${propName}' schema must be an object`;
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.type !== "string") {
    return `property '${path}${propName}' must declare a string 'type'`;
  }

  let allowedKeys: Set<string>;
  switch (s.type) {
    case "string":
      allowedKeys = ALLOWED_STRING_KEYS;
      break;
    case "number":
    case "integer":
      allowedKeys = ALLOWED_NUMBER_KEYS;
      break;
    case "boolean":
      allowedKeys = ALLOWED_BOOLEAN_KEYS;
      break;
    case "array":
      allowedKeys = ALLOWED_ARRAY_KEYS;
      break;
    case "object":
      allowedKeys = ALLOWED_OBJECT_KEYS;
      break;
    default:
      return `unsupported parameter type '${s.type}' for property '${path}${propName}'`;
  }

  for (const k of Object.keys(s)) {
    if (!allowedKeys.has(k)) {
      return `unsupported schema keyword '${k}' on property '${path}${propName}' of type '${s.type}'`;
    }
  }

  if (s.type === "string") {
    if (s.maxLength !== undefined) {
      if (typeof s.maxLength !== "number" || !Number.isInteger(s.maxLength) || s.maxLength < 0) {
        return `maxLength on property '${path}${propName}' must be a non-negative integer`;
      }
    }
    if (s.minLength !== undefined) {
      if (typeof s.minLength !== "number" || !Number.isInteger(s.minLength) || s.minLength < 0) {
        return `minLength on property '${path}${propName}' must be a non-negative integer`;
      }
    }
    if (typeof s.maxLength === "number" && typeof s.minLength === "number" && s.minLength > s.maxLength) {
      return `minLength cannot exceed maxLength on property '${path}${propName}'`;
    }
    if (s.enum !== undefined) {
      if (!Array.isArray(s.enum) || s.enum.length === 0 || !s.enum.every((item) => typeof item === "string")) {
        return `enum for string property '${path}${propName}' must be a non-empty array of strings`;
      }
      if (typeof s.minLength === "number" || typeof s.maxLength === "number") {
        const hasSatisfiable = s.enum.some((item) => {
          const len = Array.from(item as string).length;
          if (typeof s.minLength === "number" && len < s.minLength) return false;
          if (typeof s.maxLength === "number" && len > s.maxLength) return false;
          return true;
        });
        if (!hasSatisfiable) {
          return `no enum members satisfy declared length bounds on property '${path}${propName}'`;
        }
      }
    }
  }

  if (s.type === "integer") {
    if (s.maximum !== undefined) {
      if (typeof s.maximum !== "number" || !Number.isInteger(s.maximum)) {
        return `maximum on integer property '${path}${propName}' must be an integer`;
      }
    }
    if (s.minimum !== undefined) {
      if (typeof s.minimum !== "number" || !Number.isInteger(s.minimum)) {
        return `minimum on integer property '${path}${propName}' must be an integer`;
      }
    }
    if (typeof s.maximum === "number" && typeof s.minimum === "number" && s.minimum > s.maximum) {
      return `minimum cannot exceed maximum on property '${path}${propName}'`;
    }
    if (s.enum !== undefined) {
      if (!Array.isArray(s.enum) || s.enum.length === 0 || !s.enum.every((item) => typeof item === "number" && Number.isInteger(item))) {
        return `enum for integer property '${path}${propName}' must be a non-empty array of integers`;
      }
      if (typeof s.minimum === "number" || typeof s.maximum === "number") {
        const hasSatisfiable = s.enum.some((item) => {
          if (typeof s.minimum === "number" && (item as number) < s.minimum) return false;
          if (typeof s.maximum === "number" && (item as number) > s.maximum) return false;
          return true;
        });
        if (!hasSatisfiable) {
          return `no enum members satisfy declared range bounds on property '${path}${propName}'`;
        }
      }
    }
  }

  if (s.type === "number") {
    if (s.maximum !== undefined) {
      if (typeof s.maximum !== "number" || !Number.isFinite(s.maximum)) {
        return `maximum on property '${path}${propName}' must be a finite number`;
      }
    }
    if (s.minimum !== undefined) {
      if (typeof s.minimum !== "number" || !Number.isFinite(s.minimum)) {
        return `minimum on property '${path}${propName}' must be a finite number`;
      }
    }
    if (typeof s.maximum === "number" && typeof s.minimum === "number" && s.minimum > s.maximum) {
      return `minimum cannot exceed maximum on property '${path}${propName}'`;
    }
    if (s.enum !== undefined) {
      if (!Array.isArray(s.enum) || s.enum.length === 0 || !s.enum.every((item) => typeof item === "number" && Number.isFinite(item))) {
        return `enum for numeric property '${path}${propName}' must be a non-empty array of numbers`;
      }
      if (typeof s.minimum === "number" || typeof s.maximum === "number") {
        const hasSatisfiable = s.enum.some((item) => {
          if (typeof s.minimum === "number" && (item as number) < s.minimum) return false;
          if (typeof s.maximum === "number" && (item as number) > s.maximum) return false;
          return true;
        });
        if (!hasSatisfiable) {
          return `no enum members satisfy declared range bounds on property '${path}${propName}'`;
        }
      }
    }
  }

  if (s.type === "array" && s.items !== undefined) {
    if (!s.items || typeof s.items !== "object" || Array.isArray(s.items)) {
      return `items schema for array property '${path}${propName}' must be an object`;
    }
    const itemSchema = s.items as Record<string, unknown>;
    for (const k of Object.keys(itemSchema)) {
      if (!ALLOWED_ITEMS_KEYS.has(k)) {
        return `unsupported schema keyword '${k}' in items schema of array property '${path}${propName}'`;
      }
    }
    if (typeof itemSchema.type !== "string" || !SUPPORTED_PRIMITIVE_ITEM_TYPES.has(itemSchema.type)) {
      return `unsupported items type '${String(itemSchema.type)}' for array property '${path}${propName}' (only primitive types string, number, integer, boolean supported)`;
    }
    if (itemSchema.enum !== undefined) {
      if (!Array.isArray(itemSchema.enum) || itemSchema.enum.length === 0) {
        return `enum in items schema of array property '${path}${propName}' must be a non-empty array`;
      }
      if (itemSchema.type === "string" && !itemSchema.enum.every((item) => typeof item === "string")) {
        return `enum in items schema of array property '${path}${propName}' must contain strings matching type '${itemSchema.type}'`;
      }
      if (itemSchema.type === "number" && !itemSchema.enum.every((item) => typeof item === "number" && Number.isFinite(item))) {
        return `enum in items schema of array property '${path}${propName}' must contain numbers matching type '${itemSchema.type}'`;
      }
      if (itemSchema.type === "integer" && !itemSchema.enum.every((item) => typeof item === "number" && Number.isInteger(item))) {
        return `enum in items schema of array property '${path}${propName}' must contain integers matching type '${itemSchema.type}'`;
      }
      if (itemSchema.type === "boolean" && !itemSchema.enum.every((item) => typeof item === "boolean")) {
        return `enum in items schema of array property '${path}${propName}' must contain booleans matching type '${itemSchema.type}'`;
      }
    }
  }

  if (s.type === "object") {
    if (s.properties !== undefined) {
      if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) {
        return `properties for object property '${path}${propName}' must be an object`;
      }
      if (Object.hasOwn(s.properties, "__proto__")) {
        return `object property '${path}${propName}' cannot declare '__proto__' property`;
      }
    }
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean") {
      return `additionalProperties for object property '${path}${propName}' must be a boolean`;
    }
    if (s.required !== undefined) {
      if (!Array.isArray(s.required) || !s.required.every((r) => typeof r === "string" && r.length > 0)) {
        return `required for object property '${path}${propName}' must be an array of non-empty strings`;
      }
      if (s.required.includes("__proto__")) {
        return `object property '${path}${propName}' required cannot include '__proto__'`;
      }
    }
    if (s.additionalProperties === false) {
      const nestedPropNames = (s.properties && typeof s.properties === "object" && !Array.isArray(s.properties))
        ? Object.keys(s.properties)
        : [];
      if (Array.isArray(s.required)) {
        for (const reqKey of s.required) {
          if (!nestedPropNames.includes(reqKey)) {
            return `contradictory schema on property '${path}${propName}': required property '${reqKey}' is not declared in properties when additionalProperties: false`;
          }
        }
      }
    }
    if (s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)) {
      for (const [nestedName, nestedSchema] of Object.entries(s.properties as Record<string, unknown>)) {
        const err = validateSinglePropertySchema(nestedName, nestedSchema, `${path}${propName}.`, depth + 1, counter);
        if (err) return err;
      }
    }
  }

  return null;
}

/**
 * Validate a Web MCP tool declaration submitted by a mini-app against the strictly supported schema subset.
 */
export function validateWebMcpTool(raw: unknown): ValidationResult<WebMcpToolDeclaration> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return refusal("invalid-tool-declaration", "tool declaration must be an object");
  }
  const t = raw as Record<string, unknown>;
  const name = typeof t.name === "string" ? t.name.trim() : "";
  if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    return refusal("invalid-tool-name", `tool name must be 1-64 alphanumeric characters, underscores or dashes, got '${name}'`);
  }
  const description = typeof t.description === "string" ? t.description.trim() : "";
  if (!description || description.length > MINI_APP_BOUNDS.maxDescriptionLength) {
    return refusal("invalid-tool-description", `tool description must be a string up to ${MINI_APP_BOUNDS.maxDescriptionLength} characters`);
  }
  const rawParams = t.parameters ?? t.inputSchema ?? { type: "object", properties: {} };
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return refusal("invalid-tool-parameters", "tool parameters must be a JSON schema object with type: 'object'");
  }
  const p = rawParams as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!ALLOWED_TOP_PARAM_KEYS.has(k)) {
      return refusal("invalid-tool-parameters", `unsupported top-level schema keyword '${k}' in tool parameters`);
    }
  }
  if (p.type !== "object") {
    return refusal("invalid-tool-parameters", "tool parameters schema must specify type: 'object'");
  }
  if (p.additionalProperties !== undefined && typeof p.additionalProperties !== "boolean") {
    return refusal("invalid-tool-parameters", "additionalProperties must be a boolean if specified");
  }
  if (p.properties !== undefined) {
    if (!p.properties || typeof p.properties !== "object" || Array.isArray(p.properties)) {
      return refusal("invalid-tool-parameters", "tool parameters properties must be an object");
    }
    if (Object.hasOwn(p.properties, "__proto__")) {
      return refusal("invalid-tool-parameters", "tool parameters cannot declare '__proto__' property");
    }
  }

  const properties = (p.properties && typeof p.properties === "object" && !Array.isArray(p.properties))
    ? (p.properties as Record<string, WebMcpParameterSchema>)
    : {};

  const counter = { nodes: 0 };
  for (const [propName, propSchema] of Object.entries(properties)) {
    const err = validateSinglePropertySchema(propName, propSchema, "", 1, counter);
    if (err) {
      return refusal("invalid-tool-parameters", err);
    }
  }

  const required = Array.isArray(p.required) ? p.required : [];
  if (p.required !== undefined) {
    if (!Array.isArray(p.required) || !p.required.every((r) => typeof r === "string" && r.length > 0)) {
      return refusal("invalid-tool-parameters", "tool parameters required must be an array of non-empty strings");
    }
    if (p.required.includes("__proto__")) {
      return refusal("invalid-tool-parameters", "tool parameters required cannot include '__proto__'");
    }
  }

  const propNames = (p.properties && typeof p.properties === "object" && !Array.isArray(p.properties))
    ? Object.keys(p.properties)
    : [];

  if (p.additionalProperties === false && Array.isArray(p.required)) {
    for (const reqKey of p.required) {
      if (!propNames.includes(reqKey)) {
        return refusal(
          "invalid-tool-parameters",
          `contradictory schema: required property '${reqKey}' is not declared in properties when additionalProperties: false`
        );
      }
    }
  }

  const additionalProperties = p.additionalProperties === false ? false : undefined;

  return {
    ok: true,
    value: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        ...(additionalProperties === false ? { additionalProperties: false } : {}),
      },
    },
  };
}

/**
 * Convert a list of Web MCP tool declarations to live model function declarations.
 */
export function toolsToFunctionDeclarations(tools: WebMcpToolDeclaration[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

interface SnapshotResult {
  ok: boolean;
  snapshot?: unknown;
  refused?: string;
  why?: string;
}

export function inspectAndSnapshotJson(
  val: unknown,
  path = "",
  depth = 0,
  counter = { nodes: 0 },
  seen = new Set<unknown>()
): SnapshotResult {
  try {
    counter.nodes++;
    if (counter.nodes > MINI_APP_BOUNDS.maxNodeCount) {
      return {
        ok: false,
        refused: "invalid-argument-bounds",
        why: `argument exceeds maximum node count of ${MINI_APP_BOUNDS.maxNodeCount}`,
      };
    }

    if (depth > MINI_APP_BOUNDS.maxNestingDepth) {
      return {
        ok: false,
        refused: "invalid-argument-bounds",
        why: `argument nesting exceeds maximum depth of ${MINI_APP_BOUNDS.maxNestingDepth}`,
      };
    }

    if (val === undefined) {
      return { ok: false, refused: "invalid-argument", why: `argument${path ? ` at '${path}'` : ""} cannot be undefined` };
    }
    if (val === null || typeof val === "boolean") {
      return { ok: true, snapshot: val };
    }
    if (typeof val === "number") {
      if (!Number.isFinite(val)) {
        return { ok: false, refused: "invalid-argument", why: `number${path ? ` at '${path}'` : ""} must be a finite number, got ${val}` };
      }
      return { ok: true, snapshot: val };
    }
    if (typeof val === "string") {
      return { ok: true, snapshot: val };
    }
    if (typeof val === "bigint" || typeof val === "symbol" || typeof val === "function") {
      return { ok: false, refused: "invalid-argument", why: `argument${path ? ` at '${path}'` : ""} has unsupported type '${typeof val}'` };
    }
    if (typeof val !== "object") {
      return { ok: false, refused: "invalid-argument", why: `argument${path ? ` at '${path}'` : ""} has invalid type '${typeof val}'` };
    }

    // Reject non-plain objects: Date, RegExp, Map, Set, Promise, Error, ArrayBuffer, ArrayBuffer views
    if (
      val instanceof Date ||
      val instanceof RegExp ||
      val instanceof Map ||
      val instanceof Set ||
      val instanceof Promise ||
      val instanceof Error ||
      val instanceof ArrayBuffer ||
      ArrayBuffer.isView(val)
    ) {
      return {
        ok: false,
        refused: "invalid-argument",
        why: `argument${path ? ` at '${path}'` : ""} cannot be an instance of ${Object.prototype.toString.call(val).slice(8, -1)}`,
      };
    }

    if (seen.has(val)) {
      return { ok: false, refused: "invalid-argument", why: `circular reference detected${path ? ` at '${path}'` : ""}` };
    }
    seen.add(val);

    if (Array.isArray(val)) {
      const len = val.length;
      let ownKeys: (string | symbol)[];
      try {
        ownKeys = Reflect.ownKeys(val);
      } catch {
        seen.delete(val);
        return { ok: false, refused: "invalid-argument", why: `cannot read keys on array${path ? ` at '${path}'` : ""}` };
      }

      // Arrays must strictly only have canonical dense integer keys "0".."len-1" and "length"
      if (ownKeys.length !== len + 1) {
        seen.delete(val);
        return { ok: false, refused: "invalid-argument", why: `array${path ? ` at '${path}'` : ""} cannot contain non-index or symbol properties` };
      }

      let descriptors: PropertyDescriptorMap;
      try {
        descriptors = Object.getOwnPropertyDescriptors(val);
      } catch {
        seen.delete(val);
        return { ok: false, refused: "invalid-argument", why: `cannot read descriptors on array${path ? ` at '${path}'` : ""}` };
      }

      const arrSnapshot: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const desc = descriptors[String(i)];
        if (!desc) {
          seen.delete(val);
          return { ok: false, refused: "invalid-argument", why: `sparse array detected${path ? ` at '${path}[${i}]'` : ""}` };
        }
        if (desc.get || desc.set) {
          seen.delete(val);
          return { ok: false, refused: "invalid-argument", why: `array element${path ? ` at '${path}[${i}]'` : ""} cannot use getter/setter accessors` };
        }
        const itemRes = inspectAndSnapshotJson(desc.value, `${path}[${i}]`, depth + 1, counter, seen);
        if (!itemRes.ok) {
          seen.delete(val);
          return itemRes;
        }
        arrSnapshot.push(itemRes.snapshot);
      }
      seen.delete(val);
      return { ok: true, snapshot: arrSnapshot };
    }

    const proto = Object.getPrototypeOf(val);
    if (proto !== null && proto !== Object.prototype) {
      if (Object.prototype.toString.call(val) !== "[object Object]" || (proto && Object.prototype.toString.call(proto) !== "[object Object]")) {
        seen.delete(val);
        return {
          ok: false,
          refused: "invalid-argument",
          why: `argument object${path ? ` at '${path}'` : ""} must be a plain object`,
        };
      }
    }

    let syms: symbol[] = [];
    try {
      syms = Object.getOwnPropertySymbols(val);
    } catch {
      seen.delete(val);
      return { ok: false, refused: "invalid-argument", why: `cannot read symbols on object${path ? ` at '${path}'` : ""}` };
    }
    if (syms.length > 0) {
      seen.delete(val);
      return { ok: false, refused: "invalid-argument", why: `argument object${path ? ` at '${path}'` : ""} cannot contain Symbol keys` };
    }

    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(val);
    } catch {
      seen.delete(val);
      return { ok: false, refused: "invalid-argument", why: `cannot read descriptors on object${path ? ` at '${path}'` : ""}` };
    }

    if (Object.hasOwn(val, "__proto__")) {
      seen.delete(val);
      return { ok: false, refused: "invalid-argument", why: `argument object${path ? ` at '${path}'` : ""} cannot contain '__proto__' property` };
    }

    const objSnapshot: Record<string, unknown> = Object.create(null);
    for (const [key, desc] of Object.entries(descriptors)) {
      if (!desc.enumerable) {
        seen.delete(val);
        return { ok: false, refused: "invalid-argument", why: `argument property '${path ? `${path}.` : ""}${key}' cannot be non-enumerable` };
      }
      if (desc.get || desc.set) {
        seen.delete(val);
        return { ok: false, refused: "invalid-argument", why: `argument property '${path ? `${path}.` : ""}${key}' cannot use getter/setter accessors` };
      }
      const propRes = inspectAndSnapshotJson(desc.value, path ? `${path}.${key}` : key, depth + 1, counter, seen);
      if (!propRes.ok) {
        seen.delete(val);
        return propRes;
      }
      Object.defineProperty(objSnapshot, key, {
        value: propRes.snapshot,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    seen.delete(val);
    return { ok: true, snapshot: objSnapshot };
  } catch {
    seen.delete(val);
    return {
      ok: false,
      refused: "invalid-argument",
      why: `failed to inspect arguments${path ? ` at '${path}'` : ""}`,
    };
  }
}

/**
 * Validate arguments supplied to a mini-app tool against its declared JSON schema.
 */
export function validateMiniAppToolArgs(
  tool: WebMcpToolDeclaration,
  rawArgs: unknown
): ValidationResult<Record<string, unknown>> {
  try {
    if (rawArgs === null || rawArgs === undefined) {
      rawArgs = {};
    }
    let isArr = false;
    try {
      isArr = Array.isArray(rawArgs);
    } catch {
      return refusal("invalid-argument", "failed to inspect arguments: revoked or inaccessible proxy");
    }
    if (typeof rawArgs !== "object" || isArr) {
      return refusal("invalid-tool-arguments", `tool arguments must be an object, got ${isArr ? "array" : typeof rawArgs}`);
    }

    const snapResult = inspectAndSnapshotJson(rawArgs);
    if (!snapResult.ok) {
      return refusal(snapResult.refused || "invalid-argument", snapResult.why || "invalid arguments");
    }

    let jsonStr = "";
    try {
      jsonStr = JSON.stringify(snapResult.snapshot);
    } catch {
      return refusal("invalid-tool-arguments", "tool arguments must be serializable JSON");
    }

    const byteLen = typeof Buffer !== "undefined"
      ? Buffer.byteLength(jsonStr, "utf8")
      : (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(jsonStr).length : jsonStr.length);

    if (byteLen > MINI_APP_BOUNDS.maxArgsBytes) {
      return refusal(
        "invalid-tool-arguments",
        `tool arguments size (${byteLen} bytes) exceeds maximum allowed bound of ${MINI_APP_BOUNDS.maxArgsBytes} bytes`
      );
    }

    const args = snapResult.snapshot as Record<string, unknown>;

    const params = tool?.parameters ?? { type: "object", properties: {} };
    const properties = (params.properties && typeof params.properties === "object" && !Array.isArray(params.properties))
      ? params.properties
      : {};
    const required = Array.isArray(params.required) ? params.required : [];

  for (const reqKey of required) {
    if (typeof reqKey === "string" && (!Object.hasOwn(args, reqKey) || args[reqKey] === undefined || args[reqKey] === null)) {
      return refusal("missing-argument", `missing required argument '${reqKey}' for mini-app tool '${tool.name}'`);
    }
  }

  if ((params as Record<string, unknown>).additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(properties, key)) {
        return refusal("invalid-argument", `unrecognized argument '${key}' not permitted by tool schema`);
      }
    }
  }

  for (const [key, val] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) continue;
    const schema = properties[key];
    if (schema) {
      if (val === null) {
        return refusal("invalid-argument-type", `argument '${key}' cannot be null`);
      }
      if (val !== undefined) {
        if (schema.type) {
          switch (schema.type) {
            case "string": {
              if (typeof val !== "string") {
                return refusal("invalid-argument-type", `argument '${key}' must be a string, got ${typeof val}`);
              }
              const charCount = Array.from(val).length;
              if (typeof schema.maxLength === "number" && charCount > schema.maxLength) {
                return refusal("invalid-argument-length", `argument '${key}' length (${charCount}) exceeds maxLength ${schema.maxLength}`);
              }
              if (typeof schema.minLength === "number" && charCount < schema.minLength) {
                return refusal("invalid-argument-length", `argument '${key}' length (${charCount}) below minLength ${schema.minLength}`);
              }
              break;
            }
            case "number":
              if (typeof val !== "number" || !Number.isFinite(val)) {
                return refusal("invalid-argument-type", `argument '${key}' must be a finite number, got ${typeof val === "number" ? "NaN/Infinity" : typeof val}`);
              }
              if (typeof schema.maximum === "number" && val > schema.maximum) {
                return refusal("invalid-argument-range", `argument '${key}' value ${val} exceeds maximum ${schema.maximum}`);
              }
              if (typeof schema.minimum === "number" && val < schema.minimum) {
                return refusal("invalid-argument-range", `argument '${key}' value ${val} below minimum ${schema.minimum}`);
              }
              break;
            case "integer":
              if (typeof val !== "number" || !Number.isInteger(val)) {
                return refusal("invalid-argument-type", `argument '${key}' must be an integer, got ${val}`);
              }
              if (typeof schema.maximum === "number" && val > schema.maximum) {
                return refusal("invalid-argument-range", `argument '${key}' value ${val} exceeds maximum ${schema.maximum}`);
              }
              if (typeof schema.minimum === "number" && val < schema.minimum) {
                return refusal("invalid-argument-range", `argument '${key}' value ${val} below minimum ${schema.minimum}`);
              }
              break;
            case "boolean":
              if (typeof val !== "boolean") {
                return refusal("invalid-argument-type", `argument '${key}' must be a boolean, got ${typeof val}`);
              }
              break;
            case "array":
              if (!Array.isArray(val)) {
                return refusal("invalid-argument-type", `argument '${key}' must be an array, got ${typeof val}`);
              }
              if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
                const itemSchema = schema.items as Record<string, unknown>;
                const itemType = typeof itemSchema.type === "string" ? itemSchema.type : null;
                for (let i = 0; i < val.length; i++) {
                  const item = val[i];
                  if (item === null) {
                    return refusal("invalid-argument-type", `array item at index ${i} in '${key}' cannot be null`);
                  }
                  if (itemType) {
                    if (itemType === "string" && typeof item !== "string") {
                      return refusal("invalid-argument-type", `array item at index ${i} in '${key}' must be a string, got ${typeof item}`);
                    }
                    if (itemType === "number" && (typeof item !== "number" || !Number.isFinite(item))) {
                      return refusal("invalid-argument-type", `array item at index ${i} in '${key}' must be a number, got ${typeof item}`);
                    }
                    if (itemType === "integer" && (typeof item !== "number" || !Number.isInteger(item))) {
                      return refusal("invalid-argument-type", `array item at index ${i} in '${key}' must be an integer, got ${typeof item}`);
                    }
                    if (itemType === "boolean" && typeof item !== "boolean") {
                      return refusal("invalid-argument-type", `array item at index ${i} in '${key}' must be a boolean, got ${typeof item}`);
                    }
                    if (itemType === "object" && (typeof item !== "object" || Array.isArray(item))) {
                      return refusal("invalid-argument-type", `array item at index ${i} in '${key}' must be an object, got ${Array.isArray(item) ? "array" : typeof item}`);
                    }
                  }
                  if (Array.isArray(itemSchema.enum) && !itemSchema.enum.includes(item)) {
                    return refusal("invalid-argument-enum", `array item at index ${i} in '${key}' value ${JSON.stringify(item)} is not one of allowed enum values`);
                  }
                }
              }
              break;
            case "object":
              if (typeof val !== "object" || Array.isArray(val)) {
                return refusal("invalid-argument-type", `argument '${key}' must be an object, got ${Array.isArray(val) ? "array" : typeof val}`);
              }
              {
                const nestedProps = (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties))
                  ? (schema.properties as Record<string, WebMcpParameterSchema>)
                  : {};
                const nestedReq = Array.isArray(schema.required) ? (schema.required as string[]) : [];
                const nestedAddl = schema.additionalProperties === false ? false : undefined;
                if (nestedReq.length > 0 || nestedAddl === false || Object.keys(nestedProps).length > 0) {
                  const nestedTool: WebMcpToolDeclaration = {
                    name: `${tool.name}.${key}`,
                    description: "",
                    parameters: {
                      type: "object",
                      properties: nestedProps,
                      ...(nestedReq.length ? { required: nestedReq } : {}),
                      ...(nestedAddl === false ? { additionalProperties: false } : {}),
                    },
                  };
                  const nestedRes = validateMiniAppToolArgs(nestedTool, val);
                  if (!nestedRes.ok) {
                    return refusal(nestedRes.refused, `in argument '${key}': ${nestedRes.why}`);
                  }
                }
              }
              break;
          }
        }
        if (Array.isArray(schema.enum) && !schema.enum.includes(val as string)) {
          return refusal(
            "invalid-argument-enum",
            `argument '${key}' value ${JSON.stringify(val)} is not one of the allowed enum values: [${schema.enum.map((e) => JSON.stringify(e)).join(", ")}]`
          );
        }
      }
    }
  }

  return { ok: true, value: args };
  } catch {
    return refusal("invalid-argument", "failed to inspect arguments");
  }
}
